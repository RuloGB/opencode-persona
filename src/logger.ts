// File-only diagnostics: console.* paints over the OpenCode TUI and corrupts
// it. If the project path is not writable, fall back to ~/.persona/.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export class PersonaLogger {
  private readonly candidates: string[];

  constructor(projectRoot: string) {
    this.candidates = [
      path.join(projectRoot, ".opencode", "persona.log"),
      path.join(os.homedir(), ".persona", "persona.log"),
    ];
  }

  log(message: string, data?: unknown): void {
    const suffix = data === undefined ? "" : ` ${this.stringify(data)}`;
    const line = `[${new Date().toISOString()}] ${message}${suffix}\n`;
    for (const file of this.candidates) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, line, "utf-8");
        break;
      } catch {
        // Location not writable: try the next one.
      }
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
