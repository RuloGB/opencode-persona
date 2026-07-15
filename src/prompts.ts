// Model-facing texts: changing their wording changes the plugin's behavior.
import { ROLE_LABEL, type Role } from "./roles.ts";
import { VERBOSITY_LABEL, hasPreferences, type UserPreferences } from "./preferences.ts";
import type { ConventionList, ConventionScope } from "./conventions.ts";

// Shared visual marker: every reply generated from the plugin must start with
// this prefix so the user can tell at a glance that Persona answered.
export const PERSONA_PREFIX = "✨ Persona plugin:";

const PREFIX_INSTRUCTION = `Start that reply EXACTLY with "${PERSONA_PREFIX}".`;

// Prompts are English, but replies must mirror the user's language; a saved
// language preference overrides the mirroring.
export const LANGUAGE_INSTRUCTION =
  "Always write your reply in the language the user is writing in; if a saved " +
  "language preference exists, that preference takes precedence.";

export const SAVE_ROLE_TOOL_DESCRIPTION =
  "Saves or updates the user's role. Use it in two cases: (1) the first time " +
  "the user is asked, as soon as you interpret their answer (a number, the role " +
  "name, or a free-form description); (2) whenever the user asks to change " +
  "roles (e.g. 'change my role to QA'). Exact accepted values: developer, " +
  "architect, analyst, qa.";

export const SAVE_PREFERENCES_TOOL_DESCRIPTION =
  "Saves or updates the user's communication preferences when they express one " +
  "clearly and stably: the language they want replies in ('always reply in " +
  "English') or the level of detail ('be more brief', 'I want in-depth " +
  "explanations'). Send only the fields the user expressed; the others are " +
  "preserved. Do not use it for one-off requests scoped to a single message.";

export const SAVE_CONVENTION_TOOL_DESCRIPTION =
  "Saves a working convention when the user establishes a rule that must be " +
  "respected in future sessions (e.g. 'commits in this repo are written in " +
  "English', 'never use any'). One imperative, self-contained sentence per " +
  "call. Scope 'project' (the default) applies only to the user's sessions " +
  "in the current project; scope 'global' applies to their sessions in ALL " +
  "of their projects — use it only when the user states the rule is " +
  "universal (e.g. 'in every project', 'always, everywhere'). Either way it " +
  "is stored in the user's LOCAL Engram: it is NOT automatically shared with " +
  "other people on the team (each person has their own Engram). Do not use " +
  "it for one-off tasks or for personal preferences (save_user_preferences " +
  "exists for those).";

export const PERSONA_STATUS_TOOL_DESCRIPTION =
  "Reads what the Persona plugin has recorded in Engram: the user's active " +
  "role, communication preferences, their global conventions (applied in all " +
  "of their projects), and this project's conventions. Use it WHENEVER the " +
  "user asks what they have configured or recorded in Persona (their role, " +
  "their preferences, or any conventions) or wants to verify a recent " +
  "change. These questions are not answered from AGENTS.md or other " +
  "repository files.";

export const BOOTSTRAP_PROMPT = [
  "No role is configured for this user yet.",
  "Before handling their request you must know their role.",
  LANGUAGE_INSTRUCTION,
  "Reply with this introduction, translated into that reply language (keep the ✨ marker",
  "and the numbered list):",
  "'✨ Hi! I'm the Persona plugin: I adapt the assistant to your professional role, save your",
  "preferences (language and level of detail) and your project's conventions, and remember",
  "them across sessions. Everything stays in your local Engram: it is yours alone and is not",
  "shared with anyone.",
  "",
  "First, choose your role:",
  "",
  "1. Developer",
  "2. Software Architect",
  "3. Analyst",
  "4. QA",
  "",
  "Tip: type the number and press Enter. Once saved, I'll show you what else you can configure (optional).'",
  "As soon as the role is clear, call the save_user_role tool with the matching value.",
  "Do not handle any other task until you have done so.",
].join("\n");

// User-facing, not model-facing: the plugin itself prepends this line to the
// first assistant reply of the session (experimental.text.complete hook), so
// it appears regardless of the model. Always English by design.
export function buildRoleAnnouncement(role: Role): string {
  return `${PERSONA_PREFIX} active role - ${ROLE_LABEL[role]}`;
}

// Assistant reply of the session when the update check (update-check.ts)
export function buildUpdateNotice(currentVersion: string, latestVersion: string): string {
  return [
    "---",
    `${PERSONA_PREFIX} 🚨 UPDATE AVAILABLE: opencode-persona ${latestVersion} is out (you're running ${currentVersion}).`,
    `Pin it in opencode.json: "opencode-persona@${latestVersion}".`,
    "---",
  ].join("\n");
}

export const ROLE_SESSION_GUIDANCE = [
  "",
  "---",
  LANGUAGE_INSTRUCTION,
  "Handle the user's request, applying the role instructions above",
  "for the whole session.",
  "If the user asks to change roles, call the save_user_role tool with the new value.",
  "If they ask what is recorded or configured in Persona (role, preferences, or",
  "conventions), call the get_persona_status tool and answer from its result;",
  "that is NOT answered from AGENTS.md or other repository files.",
].join("\n");

export function buildSaveRoleResult(
  role: Role,
  persisted: boolean,
  roleContext: string,
  firstTime: boolean
): string {
  const status = persisted
    ? `Role saved: ${role} (${ROLE_LABEL[role]}).`
    : `Role active for this session only: ${role} (${ROLE_LABEL[role]}). ` +
      "It could not be persisted to Engram (is it installed and on the PATH?); the role will be asked again next session.";
  const confirmation = persisted
    ? "Now confirm to the user, in a brief message, that their role has been saved, keeping the prefix\n" +
      "verbatim and translating the rest into that reply language:\n" +
      `"${PERSONA_PREFIX} role saved and active — ${ROLE_LABEL[role]}."`
    : "Confirm to the user, in a brief message, that their role is active for this session " +
      `but could not be saved permanently (Engram unavailable). ${PREFIX_INSTRUCTION}`;

  // Onboarding only makes sense on the first save with a healthy Engram: on a
  // role change the user already saw it, and without persistence it misleads.
  const onboarding =
    firstTime && persisted
      ? [
          "",
          "This is the user's first configuration: after the confirmation line, offer them",
          "the optional configuration in the SAME message, conveying exactly these ideas:",
          "- They can choose the reply language and level of detail by saying it in the chat, e.g.:",
          '  "always reply in English" · "be more brief" · "I want detailed explanations".',
          "- They can record working conventions, for this project or global across all their projects, e.g.:",
          '  "save as a convention: commits are written in English" · "global convention: never use any".',
          "- They do not have to decide now: those same phrases work in any future session,",
          '  and they can review what is recorded by asking "what do I have configured in Persona?".',
          "- Remind them that everything is stored in their local Engram and is theirs alone: the",
          "  conventions are NOT shared with the rest of the team.",
        ]
      : [];

  return [
    status,
    "",
    roleContext,
    "",
    "---",
    LANGUAGE_INSTRUCTION,
    confirmation,
    ...onboarding,
    "Then handle their original request (if there was one), applying these role instructions.",
  ].join("\n");
}

export function buildSavePreferencesResult(prefs: UserPreferences, persisted: boolean): string {
  if (!hasPreferences(prefs)) {
    return (
      "No recognizable preference was provided (language or level of detail); nothing was saved. " +
      `Let the user know. ${PREFIX_INSTRUCTION} ${LANGUAGE_INSTRUCTION}`
    );
  }
  const summary: string[] = [];
  if (prefs.language) summary.push(`reply language: ${prefs.language}`);
  if (prefs.verbosity) summary.push(`level of detail: ${VERBOSITY_LABEL[prefs.verbosity]}`);
  const status = persisted
    ? `Preferences saved (${summary.join("; ")}). They will also apply in future sessions.`
    : `Preferences active for this session only (${summary.join("; ")}). ` +
      "They could not be persisted to Engram (is it installed and on the PATH?).";
  return [
    status,
    "",
    "Confirm to the user in a single line which preference was recorded and apply it from your next reply on. " +
      `${PREFIX_INSTRUCTION} ${LANGUAGE_INSTRUCTION}`,
  ].join("\n");
}

export function buildSaveConventionResult(
  normalized: string | null,
  added: boolean,
  conventionTexts: string[],
  persisted: boolean,
  scope: ConventionScope
): string {
  if (normalized === null) {
    return (
      "The convention was empty after normalization; nothing was saved. Ask the user for a concrete sentence. " +
      `${PREFIX_INSTRUCTION} ${LANGUAGE_INSTRUCTION}`
    );
  }
  const scopeLabel = scope === "global" ? "all of the user's projects" : "this project";
  // The full list travels in the result: it lets the model answer questions
  // about the conventions in the same session they were saved in.
  const listing =
    conventionTexts.length > 0
      ? ["", `Conventions currently recorded for ${scopeLabel}:`, ...conventionTexts.map((t, i) => `${i + 1}. ${t}`)]
      : [];
  if (!added) {
    return [
      `The convention "${normalized}" was already recorded for ${scopeLabel}; it was not duplicated. ` +
        `Tell the user. ${PREFIX_INSTRUCTION} ${LANGUAGE_INSTRUCTION}`,
      ...listing,
    ].join("\n");
  }
  const scopeSummary =
    scope === "global"
      ? "It will be injected at the start of each of the user's sessions in ALL of their projects."
      : "It will be injected at the start of each of the user's sessions in this project.";
  const status = persisted
    ? `Convention saved with ${scope} scope (${conventionTexts.length} in total): "${normalized}". ` +
      `${scopeSummary} It stays in their local Engram: ` +
      "it is NOT automatically shared with other people on the team; if the user expects it to be shared, clarify that."
    : `Convention active for this session only (${scope} scope): "${normalized}". ` +
      "It could not be persisted to Engram (is it installed and on the PATH?).";
  return [
    status,
    ...listing,
    "",
    "Confirm to the user in a single line that the convention was recorded and honor it from now on. " +
      `${PREFIX_INSTRUCTION} ${LANGUAGE_INSTRUCTION}`,
  ].join("\n");
}

export function buildPersonaStatusResult(
  role: Role | null,
  prefs: UserPreferences,
  globalConventions: ConventionList,
  projectConventions: ConventionList,
  engramOk: boolean
): string {
  const lines = [
    "Recorded by the Persona plugin (source: Engram, not AGENTS.md or other repository files):",
    `- Active role: ${role ? `${role} (${ROLE_LABEL[role]})` : "none recorded"}`,
  ];
  if (hasPreferences(prefs)) {
    if (prefs.language) lines.push(`- Preferred reply language: ${prefs.language}`);
    if (prefs.verbosity) lines.push(`- Preferred level of detail: ${VERBOSITY_LABEL[prefs.verbosity]}`);
  } else {
    lines.push("- Communication preferences: none recorded");
  }
  if (globalConventions.conventions.length > 0) {
    lines.push(
      `- Global conventions (${globalConventions.conventions.length}, they apply in all of the user's projects, stored in their local Engram, not shared with the rest of the team):`
    );
    globalConventions.conventions.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text}`));
  } else {
    lines.push("- Global conventions: none recorded");
  }
  if (projectConventions.conventions.length > 0) {
    lines.push(
      `- Conventions for this project (${projectConventions.conventions.length}, stored in the user's local Engram, not shared with the rest of the team):`
    );
    projectConventions.conventions.forEach((c, i) => lines.push(`  ${i + 1}. ${c.text}`));
  } else {
    lines.push("- Conventions for this project: none recorded");
  }
  if (!engramOk) {
    lines.push(
      "",
      "Warning: Engram did not respond to at least one read; recorded data may exist that is not shown here."
    );
  }
  lines.push(
    "",
    "Answer the user from this list, keeping it distinct from whatever AGENTS.md or other documents say. " +
      `${PREFIX_INSTRUCTION} ${LANGUAGE_INSTRUCTION}`
  );
  return lines.join("\n");
}
