// Project-conventions domain: bounded list of working rules with "project"
// scope in the user's LOCAL Engram. They are shared across that person's
// sessions and agents in this project, NOT across people: each team member
// has their own Engram database.

export interface ConventionEntry {
  text: string;
  saved_at: string;
}

export interface ProjectConventions {
  conventions: ConventionEntry[];
}

// Limits so the context injection does not grow unbounded.
export const MAX_CONVENTIONS = 20;
export const MAX_CONVENTION_LENGTH = 300;

/** Validates data read from Engram: drops corrupt entries without throwing. */
export function sanitizeConventions(raw: unknown): ProjectConventions {
  if (typeof raw !== "object" || raw === null) return { conventions: [] };
  const list = (raw as Record<string, unknown>).conventions;
  if (!Array.isArray(list)) return { conventions: [] };
  const conventions: ConventionEntry[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const text = normalizeConventionText(entry.text);
    if (!text) continue;
    conventions.push({
      text,
      saved_at: typeof entry.saved_at === "string" ? entry.saved_at : "",
    });
  }
  return { conventions: conventions.slice(-MAX_CONVENTIONS) };
}

export interface AppendResult {
  updated: ProjectConventions;
  /** false when the convention already existed (case- and whitespace-insensitive comparison). */
  added: boolean;
  /** Normalized text exactly as stored; null when the input was empty. */
  normalized: string | null;
}

/** Appends a convention with deduplication and a cap: past MAX_CONVENTIONS the oldest one is dropped. */
export function appendConvention(current: ProjectConventions, text: string, now: Date = new Date()): AppendResult {
  const normalized = normalizeConventionText(text);
  if (!normalized) {
    return { updated: current, added: false, normalized: null };
  }
  const exists = current.conventions.some((c) => conventionKey(c.text) === conventionKey(normalized));
  if (exists) {
    return { updated: current, added: false, normalized };
  }
  const conventions = [...current.conventions, { text: normalized, saved_at: now.toISOString() }].slice(
    -MAX_CONVENTIONS
  );
  return { updated: { conventions }, added: true, normalized };
}

/** Text injected at session start; null when there are no conventions. */
export function buildConventionsContext(current: ProjectConventions): string | null {
  if (current.conventions.length === 0) return null;
  const lines = [
    "Working conventions recorded by the Persona plugin for this project " +
      "(stored in the user's local Engram; honor them in everything you do):",
  ];
  for (const entry of current.conventions) {
    lines.push(`- ${entry.text}`);
  }
  return lines.join("\n");
}

// The payload travels as single-line JSON inside Engram: conventions are
// stored without line breaks.
function normalizeConventionText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, MAX_CONVENTION_LENGTH);
}

function conventionKey(text: string): string {
  return text.toLowerCase();
}
