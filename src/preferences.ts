// User personal-preferences domain: which fields exist, how they merge, and
// how they are presented to the model. Persistence lives in EngramClient.

export const VERBOSITY_LEVELS = ["concise", "balanced", "detailed"] as const;

export type Verbosity = (typeof VERBOSITY_LEVELS)[number];

export const VERBOSITY_LABEL: Record<Verbosity, string> = {
  concise: "concise (short answers, no filler or repetition)",
  balanced: "balanced (detail only where it adds value)",
  detailed: "detailed (in-depth explanations, with context and examples)",
};

export interface UserPreferences {
  /** Language the user wants replies in ("es", "en", "galician"...). */
  language?: string;
  verbosity?: Verbosity;
}

// A longer value is almost certainly a model misunderstanding, not a language.
const MAX_LANGUAGE_LENGTH = 40;

export function isVerbosity(value: unknown): value is Verbosity {
  return typeof value === "string" && (VERBOSITY_LEVELS as readonly string[]).includes(value);
}

/** Validates data read from Engram: drops corrupt fields without throwing. */
export function sanitizePreferences(raw: unknown): UserPreferences {
  if (typeof raw !== "object" || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const prefs: UserPreferences = {};
  const language = sanitizeLanguage(record.language);
  if (language) prefs.language = language;
  if (isVerbosity(record.verbosity)) prefs.verbosity = record.verbosity;
  return prefs;
}

/** Merges without losing fields: anything not present in `incoming` is kept from `existing`. */
export function mergePreferences(existing: UserPreferences, incoming: UserPreferences): UserPreferences {
  const merged: UserPreferences = { ...existing };
  const language = sanitizeLanguage(incoming.language);
  if (language) merged.language = language;
  if (isVerbosity(incoming.verbosity)) merged.verbosity = incoming.verbosity;
  return merged;
}

export function hasPreferences(prefs: UserPreferences): boolean {
  return prefs.language !== undefined || prefs.verbosity !== undefined;
}

/** Text injected at session start; null when there is nothing to apply. */
export function buildPreferencesContext(prefs: UserPreferences): string | null {
  if (!hasPreferences(prefs)) return null;
  const lines = ["User preferences recorded by the Persona plugin (apply them in all your replies):"];
  if (prefs.language) {
    // The saved language must win over mirroring the user's message language.
    lines.push(
      `- Reply language: ${prefs.language} — this saved preference takes precedence over the language the user writes in.`
    );
  }
  if (prefs.verbosity) lines.push(`- Level of detail: ${VERBOSITY_LABEL[prefs.verbosity]}`);
  return lines.join("\n");
}

function sanitizeLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_LANGUAGE_LENGTH) return undefined;
  return trimmed;
}
