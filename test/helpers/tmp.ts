import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // On Windows a still-open file can prevent deletion; not a test failure.
  }
}
