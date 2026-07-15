import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  ENTRY_GLOBAL_CONVENTIONS,
  ENTRY_PROJECT_CONVENTIONS,
  ENTRY_USER_PREFERENCES,
  ENTRY_USER_ROLE,
  EngramClient,
  type EngramEntryDef,
} from "./engram-client.ts";
import { PersonaLogger } from "./logger.ts";
import { registerProject } from "./storage-paths.ts";
import {
  CONVENTION_SCOPES,
  appendConvention,
  buildConventionsContext,
  sanitizeConventions,
  type ConventionList,
  type ConventionScope,
} from "./conventions.ts";
import {
  VERBOSITY_LEVELS,
  buildPreferencesContext,
  mergePreferences,
  sanitizePreferences,
  type UserPreferences,
} from "./preferences.ts";
import {
  BOOTSTRAP_PROMPT,
  PERSONA_STATUS_TOOL_DESCRIPTION,
  ROLE_SESSION_GUIDANCE,
  SAVE_CONVENTION_TOOL_DESCRIPTION,
  SAVE_PREFERENCES_TOOL_DESCRIPTION,
  SAVE_ROLE_TOOL_DESCRIPTION,
  buildPersonaStatusResult,
  buildRoleAnnouncement,
  buildSaveConventionResult,
  buildSavePreferencesResult,
  buildSaveRoleResult,
  buildUpdateNotice,
} from "./prompts.ts";
import { ROLES, ROLE_LABEL, type Role, buildRoleContext, findProjectRoot, isRole } from "./roles.ts";
import { checkForNewerVersion, type VersionUpdate } from "./update-check.ts";

export const Persona: Plugin = async ({ client, directory, worktree }) => {
  const cwd = directory ?? worktree ?? process.cwd();
  const projectRoot = findProjectRoot(cwd);
  const baseDir = projectRoot ?? cwd;
  const logger = new PersonaLogger(baseDir);
  const engram = new EngramClient(baseDir, logger);
  const handledSessions = new Set<string>();
  // Tracked separately from handledSessions: a failed Engram read below
  // deletes handledSessions to retry the role lookup on the next message, but
  // the npm update check must still run exactly once per session regardless.
  const updateCheckedSessions = new Set<string>();
  // Sessions whose first assistant reply still needs the role announcement
  // prepended (consumed by the experimental.text.complete hook).
  const pendingAnnouncements = new Map<string, Role>();
  // Same single-shot pattern as pendingAnnouncements, for the npm update
  // notice; kept as a separate map so neither can clobber the other when
  // both are pending for the same session.
  const pendingUpdateNotices = new Map<string, VersionUpdate>();

  registerProject(baseDir); // best-effort (never throws): keeps the ~/.persona projects index current

  logger.log(`plugin loaded (cwd=${cwd}, projectRoot=${projectRoot ?? "not found"})`);

  async function isSubagentSession(sessionID: string): Promise<boolean> {
    try {
      const session = await client.session.get({ path: { id: sessionID } });
      return Boolean(session.data?.parentID);
    } catch {
      return false;
    }
  }

  // One conventions scope read, degraded to empty on failure: callers combine
  // scopes without one failing read losing the other.
  async function readConventionList(
    def: EngramEntryDef,
    failureMessage: string
  ): Promise<{ list: ConventionList; ok: boolean }> {
    try {
      return { list: sanitizeConventions(await engram.get(def)), ok: true };
    } catch (err) {
      logger.error(failureMessage, err);
      return { list: { conventions: [] }, ok: false };
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
    tool: {
      save_user_role: tool({
        description: SAVE_ROLE_TOOL_DESCRIPTION,
        args: {
          role: tool.schema
            .enum(ROLES)
            .describe("Role interpreted from the user's answer"),
        },
        async execute({ role }) {
          // Only the first role save triggers the optional-configuration
          // offer; a later role change does not repeat the onboarding.
          let firstTime = false;
          try {
            const previous = await engram.get<{ role?: unknown }>(ENTRY_USER_ROLE);
            firstTime = !(previous && isRole(previous.role));
          } catch {
            // Without a read there is no way to tell; skip the onboarding.
          }
          let persisted = true;
          try {
            await engram.save(ENTRY_USER_ROLE, {
              role,
              confirmed_at: new Date().toISOString(),
              source: "chat_bootstrap",
            });
          } catch (err) {
            persisted = false;
            logger.error("could not save the role to Engram", err);
          }
          logger.log(`save_user_role executed (role=${role}, persisted=${persisted}, firstTime=${firstTime})`);

          // Role instructions travel in the tool result: they enter the
          // current turn's context without depending on other SDK hooks.
          return buildSaveRoleResult(role, persisted, buildRoleContext(role, projectRoot), firstTime);
        },
      }),

      save_user_preferences: tool({
        description: SAVE_PREFERENCES_TOOL_DESCRIPTION,
        args: {
          language: tool.schema
            .string()
            .optional()
            .describe("Language the user wants replies in (e.g. 'es', 'en', 'galician')"),
          verbosity: tool.schema
            .enum(VERBOSITY_LEVELS)
            .optional()
            .describe("Preferred level of detail for replies"),
        },
        async execute({ language, verbosity }) {
          let current: UserPreferences = {};
          try {
            current = sanitizePreferences(await engram.get(ENTRY_USER_PREFERENCES));
          } catch (err) {
            logger.error("could not read previous preferences; starting from empty", err);
          }
          const merged = mergePreferences(current, sanitizePreferences({ language, verbosity }));
          let persisted = true;
          try {
            await engram.save(ENTRY_USER_PREFERENCES, merged);
          } catch (err) {
            persisted = false;
            logger.error("could not save the preferences to Engram", err);
          }
          logger.log(`save_user_preferences executed (${JSON.stringify(merged)}, persisted=${persisted})`);
          return buildSavePreferencesResult(merged, persisted);
        },
      }),

      save_convention: tool({
        description: SAVE_CONVENTION_TOOL_DESCRIPTION,
        args: {
          convention: tool.schema
            .string()
            .describe("Working rule, one imperative and self-contained sentence"),
          scope: tool.schema
            .enum(CONVENTION_SCOPES)
            .optional()
            .describe(
              "Where the convention applies: 'project' (this project only, the default) or 'global' (all of the user's projects)"
            ),
        },
        async execute({ convention, scope }) {
          const targetScope: ConventionScope = scope ?? "project";
          const entry = targetScope === "global" ? ENTRY_GLOBAL_CONVENTIONS : ENTRY_PROJECT_CONVENTIONS;
          const current = (
            await readConventionList(entry, "could not read previous conventions; starting from empty")
          ).list;
          const { updated, added, normalized } = appendConvention(current, convention);
          let persisted = added;
          if (added) {
            try {
              await engram.save(entry, updated);
            } catch (err) {
              persisted = false;
              logger.error("could not save the convention to Engram", err);
            }
          }
          logger.log(
            `save_convention executed (scope=${targetScope}, added=${added}, total=${updated.conventions.length}, persisted=${persisted})`
          );
          return buildSaveConventionResult(
            normalized,
            added,
            updated.conventions.map((c) => c.text),
            persisted,
            targetScope
          );
        },
      }),

      get_persona_status: tool({
        description: PERSONA_STATUS_TOOL_DESCRIPTION,
        args: {},
        async execute() {
          let engramOk = true;
          let role: Role | null = null;
          try {
            const record = await engram.get<{ role?: unknown }>(ENTRY_USER_ROLE);
            role = record && isRole(record.role) ? record.role : null;
          } catch (err) {
            engramOk = false;
            logger.error("get_persona_status: could not read the role", err);
          }
          let prefs: UserPreferences = {};
          try {
            prefs = sanitizePreferences(await engram.get(ENTRY_USER_PREFERENCES));
          } catch (err) {
            engramOk = false;
            logger.error("get_persona_status: could not read the preferences", err);
          }
          const globalRead = await readConventionList(
            ENTRY_GLOBAL_CONVENTIONS,
            "get_persona_status: could not read the global conventions"
          );
          const projectRead = await readConventionList(
            ENTRY_PROJECT_CONVENTIONS,
            "get_persona_status: could not read the project conventions"
          );
          if (!globalRead.ok || !projectRead.ok) engramOk = false;
          const globalConventions = globalRead.list;
          const projectConventions = projectRead.list;
          logger.log(
            `get_persona_status executed (role=${role ?? "none"}, globalConventions=${globalConventions.conventions.length}, projectConventions=${projectConventions.conventions.length}, engramOk=${engramOk})`
          );
          return buildPersonaStatusResult(role, prefs, globalConventions, projectConventions, engramOk);
        },
      }),
    },

    // Injection happens on the first chat.message of each session, not on
    // session.created: resumed sessions never emit that event again.
    "chat.message": async (input, output) => {
      try {
        const sessionID = input.sessionID ?? output.message?.sessionID;
        if (!sessionID) {
          logger.log("chat.message without a recognizable sessionID; ignored");
          return;
        }
        if (handledSessions.has(sessionID)) return;
        handledSessions.add(sessionID);

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

        logger.log(`first message of session ${sessionID}; resolving role`);

        let record: { role?: unknown } | null;
        try {
          record = await engram.get<{ role?: unknown }>(ENTRY_USER_ROLE);
        } catch (err) {
          handledSessions.delete(sessionID); // retried on the next message
          logger.error("Engram unavailable; default behavior without asking for the role", err);
          return;
        }

        const role = record && isRole(record.role) ? record.role : null;

        // Preferences and conventions degrade separately: their failure never
        // prevents injecting the role (the connection is alive after reading it).
        let preferencesContext: string | null = null;
        try {
          preferencesContext = buildPreferencesContext(
            sanitizePreferences(await engram.get(ENTRY_USER_PREFERENCES))
          );
        } catch (err) {
          logger.error("could not read the preferences; session runs without them", err);
        }

        // Global and project conventions also degrade independently: a failure
        // reading one scope must not lose the other.
        const globalConventions = (
          await readConventionList(ENTRY_GLOBAL_CONVENTIONS, "could not read the global conventions; session runs without them")
        ).list;
        const projectConventions = (
          await readConventionList(ENTRY_PROJECT_CONVENTIONS, "could not read the project conventions; session runs without them")
        ).list;
        const conventionsContext = buildConventionsContext(globalConventions, projectConventions);

        const sections: string[] = [role ? buildRoleContext(role, projectRoot) : BOOTSTRAP_PROMPT];
        if (preferencesContext) sections.push(preferencesContext);
        if (conventionsContext) sections.push(conventionsContext);
        // The guidance goes last: its instructions must be the last thing the model reads.
        if (role) sections.push(ROLE_SESSION_GUIDANCE);
        const text = sections.join("\n\n");

        output.parts.push({
          id: `prt-persona-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          sessionID,
          messageID: output.message?.id ?? "",
          type: "text",
          text,
          synthetic: true,
        });

        logger.log(
          (role
            ? `role '${role}' instructions injected into the message`
            : "no saved role: bootstrap instruction injected (will ask for the role)") +
            ` (preferences=${preferencesContext !== null}, conventions=${conventionsContext !== null})`
        );

        if (role) {
          pendingAnnouncements.set(sessionID, role);
          notifyRoleLoaded(role);
        }
      } catch (err) {
        // The plugin must never block the user's message.
        logger.error("error in chat.message", err);
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
    // per-session collection below: this is a long-running host process with
    // no other lifecycle hook available to bound their growth.
    event: async ({ event }) => {
      try {
        const type: string = event?.type ?? "";
        if (type.startsWith("session.") && type !== "session.updated") {
          logger.log(`event received: ${type}`);
        }
        if (event && event.type === "session.deleted") {
          const sessionID = event.properties.info.id;
          handledSessions.delete(sessionID);
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

// Must stay the same reference as the named export: OpenCode initializes every
// function export and dedupes by identity, so a distinct value would load twice.
export default Persona;
