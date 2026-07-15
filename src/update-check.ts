// Checks npm's registry for a newer published version of this very package,
// once per session (see the chat.message wiring in index.ts). Every failure
// (timeout, network error, non-200, malformed JSON) degrades to "no update
// found": the caller must never surface an error or block the session for it.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { PersonaLogger } from "./logger.ts";

// PERSONA_NPM_REGISTRY_URL lets tests point this at a loopback fake server
// instead of the real npm registry; read at call time, mirroring how
// PERSONA_ENGRAM_CMD/ARGS override the Engram subprocess in engram-client.ts.
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/opencode-persona/latest";
const CHECK_TIMEOUT_MS = 5000;

export interface VersionUpdate {
  currentVersion: string;
  latestVersion: string;
}

/**
 * Checks whether the npm registry has a version newer than the one installed.
 * Returns null on ANY failure (timeout, network error, bad status, malformed
 * body) or when the registry's version is not newer than the current one.
 * `timeoutMs` is only ever overridden by tests, to keep the timeout case fast.
 */
export async function checkForNewerVersion(
  logger?: PersonaLogger,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<VersionUpdate | null> {
  const url = process.env.PERSONA_NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  const startedAt = Date.now();
  const controller = new AbortController();
  try {
    const currentVersion = readInstalledVersion();
    const latestVersion = await withTimeout(
      fetchLatestVersion(url, controller.signal),
      timeoutMs,
      `checking npm for a newer version (${url})`,
      controller
    );
    const elapsedMs = Date.now() - startedAt;
    if (!isNewerVersion(latestVersion, currentVersion)) {
      logger?.log(
        `update check: already up to date (current=${currentVersion}, latest=${latestVersion}, ${elapsedMs}ms)`
      );
      return null;
    }
    logger?.log(
      `update check: newer version found (current=${currentVersion}, latest=${latestVersion}, ${elapsedMs}ms)`
    );
    return { currentVersion, latestVersion };
  } catch (err) {
    logger?.error("update check failed; no update notice will be shown", err);
    return null;
  }
}

// Resolved relative to this module's own file, one directory below the
// package root in both layouts: src/update-check.ts during development and
// dist/update-check.js once built and published. A static JSON import would
// instead need resolveJsonModule and trip tsc's rootDir check on build
// (package.json lives outside src/, which is tsconfig.build.json's rootDir).
export function readInstalledVersion(): string {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const raw = fs.readFileSync(pkgPath, "utf-8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

async function fetchLatestVersion(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`npm registry responded with ${response.status}`);
  const data: unknown = await response.json();
  const version = (data as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("malformed npm registry response (missing version)");
  }
  return version;
}

// Splits "2.10.0-beta.1" into ["2.10.0", "beta.1"]; a version with no "-"
// returns an empty string for the suffix.
function splitPrerelease(version: string): [string, string] {
  const dashIndex = version.indexOf("-");
  return dashIndex === -1 ? [version, ""] : [version.slice(0, dashIndex), version.slice(dashIndex + 1)];
}

// Numeric major.minor.patch comparison, plus a minimal local rule for
// pre-release suffixes (e.g. "2.10.0-beta.1"): sufficient for this project's
// own releases without pulling in a semver library dependency. Exported for
// direct unit testing of the comparison logic (see update-check.test.ts).
export function isNewerVersion(latest: string, current: string): boolean {
  const [latestCore, latestPre] = splitPrerelease(latest);
  const [currentCore, currentPre] = splitPrerelease(current);
  const a = latestCore.split(".").map((p) => parseInt(p, 10) || 0);
  const b = currentCore.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  // Equal numeric core: a release (no pre-release suffix) is newer than its
  // own pre-release (e.g. "2.10.0" is newer than "2.10.0-beta.1"). Two
  // differing pre-releases of the same core are left at equal precedence;
  // this project has never needed to distinguish those from each other.
  if (latestPre === currentPre) return false;
  if (latestPre === "") return true;
  if (currentPre === "") return false;
  return false;
}

// Same idiom as engram-client.ts's withTimeout, plus real cancellation: on
// timeout the underlying fetch is aborted so the socket is actually torn
// down, instead of being abandoned to undici's own (much longer) internal
// defaults while `checkForNewerVersion` has already moved on.
function withTimeout<T>(promise: Promise<T>, ms: number, what: string, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${ms}ms while ${what}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
