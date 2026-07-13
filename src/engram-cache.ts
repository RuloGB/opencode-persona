// Map of logical key -> Engram observation id, for exact reads with
// mem_get_observation. Ids belong to the local SQLite database: the cache is
// per machine and lives under ~/.persona/cache, never inside the project.
import * as fs from "node:fs";
import * as path from "node:path";
import { cachePath } from "./storage-paths.ts";

export class EngramCacheStore {
  private readonly cachePath: string;
  private cache: Record<string, string> = {};
  private loaded = false;

  constructor(projectRoot: string, home?: string) {
    this.cachePath = cachePath(projectRoot, home);
  }

  get(key: string): string | undefined {
    this.load();
    return this.cache[key];
  }

  set(key: string, observationId: string): void {
    this.load();
    this.cache[key] = observationId;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch {
      // Without persistence the cache keeps working in memory.
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));
    } catch {
      this.cache = {}; // does not exist yet or is corrupt: start clean
    }
  }
}
