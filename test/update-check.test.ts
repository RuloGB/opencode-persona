// Unit-level tests for the npm update check, isolated from the plugin's
// session wiring (that integration lives in persona.test.ts). Every test
// points PERSONA_NPM_REGISTRY_URL at the loopback fake registry: the real
// npm registry is never reached.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { PersonaLogger } from "../src/logger.ts";
import { checkForNewerVersion, isNewerVersion, readInstalledVersion } from "../src/update-check.ts";
import { startFakeRegistry, type FakeRegistry } from "./helpers/fake-registry.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const registries: FakeRegistry[] = [];
const dirs: string[] = [];

after(async () => {
  await Promise.all(registries.map((r) => r.close()));
  dirs.forEach(removeDir);
  delete process.env.PERSONA_NPM_REGISTRY_URL;
});

async function useFakeRegistry(options: Parameters<typeof startFakeRegistry>[0]): Promise<FakeRegistry> {
  const registry = await startFakeRegistry(options);
  registries.push(registry);
  process.env.PERSONA_NPM_REGISTRY_URL = registry.url;
  return registry;
}

test("a newer version on the registry is reported with both version numbers", async () => {
  await useFakeRegistry({ version: "999.0.0" });
  const result = await checkForNewerVersion();
  assert.deepEqual(result, { currentVersion: readInstalledVersion(), latestVersion: "999.0.0" });
});

test("the same version on the registry reports no update", async () => {
  await useFakeRegistry({ version: readInstalledVersion() });
  assert.equal(await checkForNewerVersion(), null);
});

test("an older version on the registry reports no update", async () => {
  await useFakeRegistry({ version: "0.0.1" });
  assert.equal(await checkForNewerVersion(), null);
});

test("a hung registry times out silently instead of blocking", async () => {
  await useFakeRegistry({ hang: true });
  const result = await checkForNewerVersion(undefined, 200);
  assert.equal(result, null);
});

test("a non-200 status reports no update, and the failure is diagnosable from persona.log", async () => {
  await useFakeRegistry({ status: 500, rawBody: "internal error" });
  const home = makeTempDir("persona-update-check-home-");
  dirs.push(home);
  const logger = new PersonaLogger("update-check-test-project", home);
  assert.equal(await checkForNewerVersion(logger), null);
  const log = fs.readFileSync(path.join(home, ".persona", "persona.log"), "utf-8");
  assert.ok(log.includes("update check failed"), "the failure must be diagnosable from persona.log");
});

test("a malformed JSON body reports no update", async () => {
  await useFakeRegistry({ rawBody: "not json at all" });
  assert.equal(await checkForNewerVersion(), null);
});

test("a JSON body without a version field reports no update", async () => {
  await useFakeRegistry({ rawBody: JSON.stringify({ notVersion: "1.2.3" }) });
  assert.equal(await checkForNewerVersion(), null);
});

test("an unreachable registry (connection refused) reports no update", async () => {
  // Port 1 sits far below the OS's ephemeral port range, so nothing is ever
  // listening there in a normal test run: a structural guarantee, unlike
  // booting a fake registry and closing it (its freed ephemeral port is not
  // reliably free for the rest of this run, since Node's test runner can run
  // other test files concurrently and reclaim it first).
  process.env.PERSONA_NPM_REGISTRY_URL = "http://127.0.0.1:1/";
  assert.equal(await checkForNewerVersion(), null);
});

test("readInstalledVersion reads this package's real version from package.json", () => {
  const version = readInstalledVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("a double-digit minor version rollover is correctly recognized as newer", () => {
  assert.equal(isNewerVersion("2.10.0", "2.9.0"), true);
  assert.equal(isNewerVersion("2.9.0", "2.10.0"), false);
});

test("a release is newer than its own pre-release, and never the reverse", () => {
  assert.equal(isNewerVersion("2.10.0", "2.10.0-beta.1"), true);
  assert.equal(isNewerVersion("2.10.0-beta.1", "2.10.0"), false);
});
