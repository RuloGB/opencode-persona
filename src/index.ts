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
  SAVE_CONVENTION_TOOL_DESCRIPTION,
  SAVE_PREFERENCES_TOOL_DESCRIPTION,
  SAVE_ROLE_TOOL_DESCRIPTION,
  buildPersonaStatusResult,
  buildRoleAnnouncement,
  buildSaveConventionResult,
  buildSavePreferencesResult,
  buildSaveRoleResult,
} from "./prompts.ts";
import { ROLES, ROLE_LABEL, type Role, buildRoleContext, findProjectRoot, isRole } from "./roles.ts";

export const Persona: Plugin = async ({ client, directory, worktree }) => {
  const cwd = directory ?? worktree ?? process.cwd();
  const projectRoot = findProjectRoot(cwd);
  const baseDir = projectRoot ?? cwd;
  const logger = new PersonaLogger(baseDir);
  const engram = new EngramClient(baseDir, logger);
  const handledSessions = new Set<string>();

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
        // The announcement goes last: its kickoff instruction must be the last thing the model reads.
        if (role) sections.push(buildRoleAnnouncement(role));
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

        if (role) notifyRoleLoaded(role);
      } catch (err) {
        // The plugin must never block the user's message.
        logger.error("error in chat.message", err);
      }
    },

    // Diagnostics only; session.updated is skipped as too noisy.
    event: async ({ event }) => {
      try {
        const type: string = event?.type ?? "";
        if (type.startsWith("session.") && type !== "session.updated") {
          logger.log(`event received: ${type}`);
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
