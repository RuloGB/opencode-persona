// OpenCode v1 adapter: maps the shared core onto the v1 server plugin hooks
// and adds the v1-only extras (role announcement, update notice, toast).
import type { Hooks, Plugin } from "@opencode-ai/plugin";
import { createPersonaCore } from "./core.ts";
import { isInternalAgentRequest } from "./internal-agents.ts";
import { buildRoleAnnouncement, buildUpdateNotice } from "./prompts.ts";
import { ROLE_LABEL, type Role } from "./roles.ts";
import { checkForNewerVersion, type VersionUpdate } from "./update-check.ts";

export const Persona: Plugin = async ({ client, directory, worktree }) => {
  const core = createPersonaCore(directory ?? worktree ?? process.cwd());
  const { logger } = core;
  // Tracked separately from the core's handled sessions: a failed Engram read
  // releases the session to retry the role lookup on the next message, but
  // the npm update check must still run exactly once per session regardless.
  const updateCheckedSessions = new Set<string>();
  // Sessions whose first assistant reply still needs the role announcement
  // prepended (consumed by the experimental.text.complete hook).
  const pendingAnnouncements = new Map<string, Role>();
  // Same single-shot pattern as pendingAnnouncements, for the npm update
  // notice; kept as a separate map so neither can clobber the other when
  // both are pending for the same session.
  const pendingUpdateNotices = new Map<string, VersionUpdate>();

  async function isSubagentSession(sessionID: string): Promise<boolean> {
    try {
      const session = await client.session.get({ path: { id: sessionID } });
      return Boolean(session.data?.parentID);
    } catch {
      return false;
    }
  }

  function notifyRoleLoaded(role: Role): void {
    // Fire-and-forget: without a connected TUI the request may never resolve.
    try {
      void client.tui
        .showToast({ body: { message: `Persona: ${ROLE_LABEL[role]} role loaded`, variant: "success" } })
        .catch(() => {});
    } catch {
      // Without a TUI (CLI mode) the toast is simply skipped.
    }
  }

  return {
    // Plain tool definitions (v1's `tool()` helper is an identity function):
    // importing it as a value would require @opencode-ai/plugin at runtime,
    // which OpenCode v2 installs do not provide. The cast only bridges types:
    // the SDK's typings pin their own nested zod copy, whose version literal
    // differs from ours; OpenCode wraps the raw shape with its own zod anyway.
    tool: core.tools as unknown as Hooks["tool"],

    // Injection happens on the first chat.message of each session, not on
    // session.created: resumed sessions never emit that event again.
    "chat.message": async (input, output) => {
      try {
        const sessionID = input.sessionID ?? output.message?.sessionID;
        if (!sessionID) {
          logger.log("chat.message without a recognizable sessionID; ignored");
          return;
        }
        if (!core.claimSession(sessionID)) return;

        if (await isSubagentSession(sessionID)) {
          logger.log(`session ${sessionID} belongs to a subagent; ignored`);
          return;
        }

        if (!updateCheckedSessions.has(sessionID)) {
          updateCheckedSessions.add(sessionID);
          try {
            void checkForNewerVersion(logger)
              .then((update) => {
                // The session may already be gone (session.deleted) by the
                // time this resolves; never resurrect a dead session's entry.
                if (update && updateCheckedSessions.has(sessionID)) {
                  pendingUpdateNotices.set(sessionID, update);
                }
              })
              .catch((err) => {
                logger.error("update check failed unexpectedly", err);
              });
          } catch (err) {
            logger.error("could not start the update check", err);
          }
        }

        // Stored, not pushed into the message: a synthetic part still reaches
        // the title generator (it only skips messages whose parts are ALL
        // synthetic), which titled every session after the persona block.
        const role = await core.composeContext(sessionID);
        if (role) {
          pendingAnnouncements.set(sessionID, role);
          notifyRoleLoaded(role);
        }
      } catch (err) {
        // The plugin must never block the user's message.
        logger.error("error in chat.message", err);
      }
    },

    // The persona context travels in the system prompt, not in the user's
    // message: OpenCode's title generator reads the message parts (and only
    // skips a user message whose parts are ALL synthetic), so a synthetic
    // part made every session title describe the persona block instead of the
    // conversation. The title call passes system: [] plus its own agent
    // prompt, so the guard below keeps our block out of it.
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sessionID = input.sessionID;
        if (!sessionID) return;
        const context = core.contextFor(sessionID);
        if (!context) return;
        if (isInternalAgentRequest(output.system)) {
          logger.log(`system prompt of an internal agent (session ${sessionID}); context not injected`);
          return;
        }
        output.system.push(context);
      } catch (err) {
        // The plugin must never break a request.
        logger.error("error in experimental.chat.system.transform", err);
      }
    },

    // The active-role announcement and the update notice are written by the
    // plugin, never by the model: asking the model to start its reply with a
    // line was probabilistic and some models skipped it. Prepending them to
    // the first completed assistant text of the session guarantees the user
    // always sees them regardless of the model. Both can be pending at once
    // (e.g. a role change plus a newer release found the same session); each
    // gets its own banner and neither may clobber the other.
    "experimental.text.complete": async (input, output) => {
      try {
        // Same defensive fallback as chat.message: input.sessionID is typed
        // as required, but this hook is "experimental" for a reason, and
        // this project already defends chat.message's own sessionID the same
        // way. Resolved once, here, so neither map lookup below can miss it
        // independently.
        const sessionID =
          input.sessionID ?? (output as { message?: { sessionID?: string } }).message?.sessionID;
        if (!sessionID) return;

        const role = pendingAnnouncements.get(sessionID);
        if (role) pendingAnnouncements.delete(sessionID);

        const update = pendingUpdateNotices.get(sessionID);
        if (update) pendingUpdateNotices.delete(sessionID);

        const banners: string[] = [];
        if (role) banners.push(buildRoleAnnouncement(role));
        if (update) banners.push(buildUpdateNotice(update.currentVersion, update.latestVersion));
        if (banners.length === 0) return;

        output.text = `${banners.join("\n\n")}\n\n${output.text}`;
        if (role) logger.log(`role announcement prepended to the first reply of session ${sessionID}`);
        if (update) {
          logger.log(
            `update notice prepended to the first reply of session ${sessionID} (latest=${update.latestVersion})`
          );
        }
      } catch (err) {
        // The plugin must never break the reply.
        logger.error("error in experimental.text.complete", err);
      }
    },

    // Diagnostics for every session.* event except the noisy session.updated.
    // session.deleted additionally evicts that session's entries from every
    // per-session collection: this is a long-running host process with no
    // other lifecycle hook available to bound their growth.
    event: async ({ event }) => {
      try {
        const type: string = event?.type ?? "";
        if (type.startsWith("session.") && type !== "session.updated") {
          logger.log(`event received: ${type}`);
        }
        if (event && event.type === "session.deleted") {
          const sessionID = event.properties.info.id;
          core.forgetSession(sessionID);
          pendingAnnouncements.delete(sessionID);
          updateCheckedSessions.delete(sessionID);
          pendingUpdateNotices.delete(sessionID);
        }
      } catch {
        // Logging must never break the event flow.
      }
    },
  };
};
