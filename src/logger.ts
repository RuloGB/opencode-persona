// File-only diagnostics: console.* paints over the OpenCode TUI and corrupts
// it. The log is global (~/.persona/persona.log) and shared by every project,
// so each line is tagged with the project key.
import * as fs from "node:fs";
import * as path from "node:path";
import { logPath, projectKey } from "./storage-paths.ts";

export class PersonaLogger {
  private readonly file: string;
  private readonly project: string;

  constructor(projectRoot: string, home?: string) {
    this.file = logPath(home);
    this.project = projectKey(projectRoot);
  }

  log(message: string, data?: unknown): void {
    const suffix = data === undefined ? "" : ` ${this.stringify(data)}`;
    const line = `[${new Date().toISOString()}] [${this.project}] ${message}${suffix}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line, "utf-8");
    } catch {
      // Home not writable: diagnostics are skipped, never thrown.
    }
  }

  error(message: string, err: unknown): void {
    this.log(`ERROR: ${message}`, err instanceof Error ? err.message : err);
  }

  private stringify(data: unknown): string {
    try {
      return typeof data === "string" ? data : JSON.stringify(data);
    } catch {
      return String(data);
    }
  }
}
