// Catalog of the plugin's global storage layout under ~/.persona: the plugin
// never writes inside the project directory. The project identity is the
// basename of the normalized project root, mirroring how Engram infers the
// project from the cwd basename; two roots with the same basename are the
// same project by design.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// PERSONA_HOME redirects the storage root (the Plugin factory offers no
// injection point, so the plugin-level tests rely on this override).
function defaultHome(): string {
  return process.env.PERSONA_HOME || os.homedir();
}

export function personaHome(home: string = defaultHome()): string {
  return path.join(home, ".persona");
}

/** Stable per-project key; degenerate roots without a basename (e.g. a drive root) fall back to a fixed key. */
export function projectKey(projectRoot: string): string {
  return path.basename(path.resolve(projectRoot)) || "unknown-project";
}

export function logPath(home: string = defaultHome()): string {
  return path.join(personaHome(home), "persona.log");
}

export function cachePath(projectRoot: string, home: string = defaultHome()): string {
  return path.join(personaHome(home), "cache", `${projectKey(projectRoot)}.json`);
}

export function projectsIndexPath(home: string = defaultHome()): string {
  return path.join(personaHome(home), "projects.json");
}

interface ProjectIndexEntry {
  root: string;
  lastSeen: string;
}

/**
 * Upserts the project into the shared index (project key -> last known root),
 * so per-project data under ~/.persona can be traced back to a real path.
 * Never throws: a missing or corrupt index starts clean, and a failed write
 * leaves the plugin fully functional.
 */
export function registerProject(projectRoot: string, home: string = defaultHome()): void {
  const indexPath = projectsIndexPath(home);
  let index: Record<string, ProjectIndexEntry> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      index = parsed as Record<string, ProjectIndexEntry>;
    }
  } catch {
    // Does not exist yet or is corrupt: start clean.
  }
  index[projectKey(projectRoot)] = { root: path.resolve(projectRoot), lastSeen: new Date().toISOString() };
  // Atomic replace (unique temp file + rename) so concurrent plugin loads can
  // never tear or corrupt the file. The read-modify-write itself still races
  // (last writer wins): an upsert lost that way self-heals on that project's
  // next plugin load, acceptable for a write-only diagnostics index.
  const tmpPath = `${indexPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2));
    fs.renameSync(tmpPath, indexPath);
  } catch {
    // The index is informational only; a failed write must not break anything.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Nothing was left behind to clean up.
    }
  }
}
