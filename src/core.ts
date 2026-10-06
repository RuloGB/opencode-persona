// Runtime-agnostic Persona core shared by the OpenCode v1 and v2 adapters:
// Engram wiring, per-session context composition, and the four tool bodies.
// The adapters only translate their host's hooks and tool registration onto it.
import { z } from "zod";
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
  buildSaveConventionResult,
  buildSavePreferencesResult,
  buildSaveRoleResult,
} from "./prompts.ts";
import { ROLES, type Role, buildRoleContext, findProjectRoot, isRole } from "./roles.ts";

// A tool in host-neutral form: zod raw-shape args (v1 consumes the shape,
// v2 wraps it with z.object) and a body that returns the text result.
export interface PersonaTool<Args extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>): Promise<string>;
}

function defineTool<Args extends z.ZodRawShape>(tool: PersonaTool<Args>): PersonaTool<Args> {
  return tool;
}

export type PersonaCore = ReturnType<typeof createPersonaCore>;

export function createPersonaCore(cwd: string) {
  const projectRoot = findProjectRoot(cwd);
  const baseDir = projectRoot ?? cwd;
  const logger = new PersonaLogger(baseDir);
  const engram = new EngramClient(baseDir, logger);
  const handledSessions = new Set<string>();
  // Persona context composed on the first message of a session, injected into
  // the system prompt of every LLM call of that session. Resending it on every
  // call is what keeps the role alive after a compaction.
  const sessionContexts = new Map<string, string>();

  registerProject(baseDir); // best-effort (never throws): keeps the ~/.persona projects index current

  logger.log(`plugin loaded (cwd=${cwd}, projectRoot=${projectRoot ?? "not found"})`);

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

  const tools = {
    save_user_role: defineTool({
      description: SAVE_ROLE_TOOL_DESCRIPTION,
      args: {
        role: z.enum(ROLES).describe("Role interpreted from the user's answer"),
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

    save_user_preferences: defineTool({
      description: SAVE_PREFERENCES_TOOL_DESCRIPTION,
      args: {
        language: z
          .string()
          .optional()
          .describe("Language the user wants replies in (e.g. 'es', 'en', 'galician')"),
        verbosity: z.enum(VERBOSITY_LEVELS).optional().describe("Preferred level of detail for replies"),
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

    save_convention: defineTool({
      description: SAVE_CONVENTION_TOOL_DESCRIPTION,
      args: {
        convention: z.string().describe("Working rule, one imperative and self-contained sentence"),
        scope: z
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

    get_persona_status: defineTool({
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
  };

  return {
    projectRoot,
    logger,
    tools,

    // Marks the session as handled; false when it already was. Injection
    // happens once per session, on its first message.
    claimSession(sessionID: string): boolean {
      if (handledSessions.has(sessionID)) return false;
      handledSessions.add(sessionID);
      return true;
    },

    // Composes and stores the session's context from Engram. Returns the saved
    // role, or null when there is none (bootstrap) or Engram is unavailable;
    // in the latter case the session is released so the next message retries.
    async composeContext(sessionID: string): Promise<Role | null> {
      logger.log(`first message of session ${sessionID}; resolving role`);

      let record: { role?: unknown } | null;
      try {
        record = await engram.get<{ role?: unknown }>(ENTRY_USER_ROLE);
      } catch (err) {
        handledSessions.delete(sessionID); // retried on the next message
        logger.error("Engram unavailable; default behavior without asking for the role", err);
        return null;
      }

      const role = record && isRole(record.role) ? record.role : null;

      // Preferences and conventions degrade separately: their failure never
      // prevents injecting the role (the connection is alive after reading it).
      let preferencesContext: string | null = null;
      try {
        preferencesContext = buildPreferencesContext(sanitizePreferences(await engram.get(ENTRY_USER_PREFERENCES)));
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
      sessionContexts.set(sessionID, sections.join("\n\n"));

      logger.log(
        (role
          ? `role '${role}' instructions ready for the system prompt`
          : "no saved role: bootstrap instruction ready (will ask for the role)") +
          ` (preferences=${preferencesContext !== null}, conventions=${conventionsContext !== null})`
      );
      return role;
    },

    // The composed context of a session, if its first message was handled.
    contextFor(sessionID: string): string | undefined {
      return sessionContexts.get(sessionID);
    },

    // Evicts a deleted session: the host process is long-running and has no
    // other lifecycle signal to bound the per-session state.
    forgetSession(sessionID: string): void {
      handledSessions.delete(sessionID);
      sessionContexts.delete(sessionID);
    },
  };
}
