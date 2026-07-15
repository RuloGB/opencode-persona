// Full-plugin tests with a simulated OpenCode client and the fake Engram
// (via PERSONA_ENGRAM_CMD/ARGS). They cover the real cycle: bootstrap, role
// save, injection in a new session, deduplication, subagents, and degradation.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Persona } from "../src/index.ts";
import { readInstalledVersion } from "../src/update-check.ts";
import { startFakeRegistry, type FakeRegistry } from "./helpers/fake-registry.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const FIXTURE = fileURLToPath(new URL("./helpers/fake-engram.ts", import.meta.url));

// A URL nothing listens on: port 1 sits far below the OS's ephemeral port
// range, so nothing is ever listening there in a normal test run - a
// structural guarantee, unlike booting a fake registry and closing it (its
// freed ephemeral port is not reliably free for the rest of this run, since
// Node's test runner can run other test files concurrently and reclaim it
// first). Used as the default registry for every test below, so the update
// check degrades silently unless a test deliberately points it at its own
// fake registry; keeps chat.message hermetic without every unrelated test
// having to know about update checks.
const UNREACHABLE_REGISTRY_URL = "http://127.0.0.1:1/";

const dirs: string[] = [];
const registries: FakeRegistry[] = [];

after(async () => {
  dirs.forEach(removeDir);
  await Promise.all(registries.map((r) => r.close()));
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeProject(): { root: string; store: string; home: string } {
  const root = makeTempDir("persona-plugin-");
  const home = makeTempDir("persona-plugin-home-");
  dirs.push(root, home);
  // The plugin resolves ~/.persona from PERSONA_HOME: tests must never write
  // to the real user home. The fake Engram store also lives outside the
  // project so the suite can assert the project dir stays untouched.
  process.env.PERSONA_HOME = home;
  // Reset for every test: only the update-check-specific tests below point
  // this at a real fake registry, and they restore it in a finally block.
  process.env.PERSONA_NPM_REGISTRY_URL = UNREACHABLE_REGISTRY_URL;
  fs.mkdirSync(path.join(root, "harness", "user-roles"), { recursive: true });
  fs.writeFileSync(path.join(root, "harness", "user-roles", "DEV.md"), "Test DEV content");
  return { root, store: path.join(home, "fake-engram-store.json"), home };
}

function useFakeEngram(store: string): void {
  process.env.PERSONA_ENGRAM_CMD = process.execPath;
  process.env.PERSONA_ENGRAM_ARGS = JSON.stringify([FIXTURE, store]);
}

// Starts a fake registry, points the plugin at it, and tracks it for cleanup
// in the module-level `after`. Callers still restore PERSONA_NPM_REGISTRY_URL
// themselves once done, since the next makeProject() call would otherwise be
// the only thing resetting it.
async function useFakeRegistry(options: Parameters<typeof startFakeRegistry>[0]): Promise<FakeRegistry> {
  const registry = await startFakeRegistry(options);
  registries.push(registry);
  process.env.PERSONA_NPM_REGISTRY_URL = registry.url;
  return registry;
}

function fakeOpencodeClient(parentBySession: Record<string, string | undefined> = {}) {
  return {
    session: {
      get: async ({ path: p }: { path: { id: string } }) => ({
        data: { id: p.id, parentID: parentBySession[p.id] },
      }),
    },
    tui: { showToast: async () => ({}) },
  };
}

async function makePlugin(root: string, parentBySession: Record<string, string | undefined> = {}) {
  const hooks = (await Persona({
    client: fakeOpencodeClient(parentBySession),
    directory: root,
    worktree: root,
  } as never)) as Record<string, unknown>;
  return hooks as {
    tool: Record<string, { execute: (args: Record<string, unknown>, ctx: unknown) => Promise<string> }>;
    "chat.message": (input: unknown, output: unknown) => Promise<void>;
    "experimental.text.complete": (
      input: { sessionID: string; messageID: string; partID: string },
      output: { text: string }
    ) => Promise<void>;
  };
}

function makeOutput(sessionID: string): { message: { id: string; sessionID: string }; parts: Array<{ text: string }> } {
  return { message: { id: `msg-${sessionID}`, sessionID }, parts: [] };
}

test("without a saved role it injects the bootstrap that asks for the role", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  const output = makeOutput("s-bootstrap");
  await hooks["chat.message"]({ sessionID: "s-bootstrap" }, output);

  assert.equal(output.parts.length, 1);
  assert.ok(output.parts[0].text.includes("No role is configured"));
  assert.ok(output.parts[0].text.includes("language and level of detail"), "the bootstrap must present what Persona configures");
  assert.ok(output.parts[0].text.includes("local Engram"), "the bootstrap must clarify that the data is local to the user");
});

test("after saving the role, a new session injects its instructions", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  const result = await hooks.tool.save_user_role.execute({ role: "developer" }, {});
  assert.ok(result.includes("Role saved"));
  assert.ok(result.includes("Test DEV content"));
  assert.ok(result.includes("always reply in English"), "the first save must offer the optional configuration");

  const secondSave = await hooks.tool.save_user_role.execute({ role: "developer" }, {});
  assert.ok(secondSave.includes("Role saved"));
  assert.ok(!secondSave.includes("always reply in English"), "a later save does not repeat the onboarding");

  const output = makeOutput("s-with-role");
  await hooks["chat.message"]({ sessionID: "s-with-role" }, output);

  assert.equal(output.parts.length, 1);
  assert.ok(output.parts[0].text.includes("Test DEV content"));
  assert.ok(output.parts[0].text.includes("Active role instructions (developer — Developer)"));
  assert.ok(output.parts[0].text.includes("save_user_role"), "it must state how to change roles");
});

test("the plugin prepends the role announcement to the first reply of the session only", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);
  await hooks.tool.save_user_role.execute({ role: "developer" }, {});

  await hooks["chat.message"]({ sessionID: "s-announce" }, makeOutput("s-announce"));

  const first = { text: "Sure, let me look at that." };
  await hooks["experimental.text.complete"]({ sessionID: "s-announce", messageID: "m1", partID: "p1" }, first);
  assert.equal(first.text, "✨ Persona plugin: active role - Developer\n\nSure, let me look at that.");

  const second = { text: "Second reply." };
  await hooks["experimental.text.complete"]({ sessionID: "s-announce", messageID: "m2", partID: "p2" }, second);
  assert.equal(second.text, "Second reply.", "later replies must stay untouched");
});

test("without a saved role no announcement is prepended (bootstrap flow)", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  await hooks["chat.message"]({ sessionID: "s-boot-announce" }, makeOutput("s-boot-announce"));

  const reply = { text: "Hi! Choose a role." };
  await hooks["experimental.text.complete"]({ sessionID: "s-boot-announce", messageID: "m1", partID: "p1" }, reply);
  assert.equal(reply.text, "Hi! Choose a role.");
});

test("subagent replies never get the announcement", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root, { "s-sub-announce": "s-parent" });
  await hooks.tool.save_user_role.execute({ role: "developer" }, {});

  await hooks["chat.message"]({ sessionID: "s-sub-announce" }, makeOutput("s-sub-announce"));

  const reply = { text: "Subagent output." };
  await hooks["experimental.text.complete"]({ sessionID: "s-sub-announce", messageID: "m1", partID: "p1" }, reply);
  assert.equal(reply.text, "Subagent output.");
});

test("injection happens only once per session", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  await hooks["chat.message"]({ sessionID: "s-dedupe" }, makeOutput("s-dedupe"));
  const second = makeOutput("s-dedupe");
  await hooks["chat.message"]({ sessionID: "s-dedupe" }, second);

  assert.equal(second.parts.length, 0);
});

test("subagent sessions receive no injection", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root, { "s-sub": "s-parent" });

  const output = makeOutput("s-sub");
  await hooks["chat.message"]({ sessionID: "s-sub" }, output);

  assert.equal(output.parts.length, 0);
});

test("saved preferences and conventions are injected in the next session", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  await hooks.tool.save_user_role.execute({ role: "developer" }, {});
  const prefsResult = await hooks.tool.save_user_preferences.execute(
    { language: "en", verbosity: "concise" },
    {}
  );
  assert.ok(prefsResult.includes("Preferences saved"));

  const convResult = await hooks.tool.save_convention.execute(
    { convention: "Commits are written in English" },
    {}
  );
  assert.ok(convResult.includes("Convention saved with project scope"));

  const output = makeOutput("s-full");
  await hooks["chat.message"]({ sessionID: "s-full" }, output);

  const text = output.parts[0].text;
  assert.ok(text.includes("User preferences"));
  assert.ok(text.includes("Reply language: en"));
  assert.ok(text.includes("Working conventions recorded"));
  assert.ok(text.includes("Commits are written in English"));
  // The session guidance must come last, after preferences and conventions.
  assert.ok(text.indexOf("save_user_role") > text.indexOf("Working conventions recorded"));
});

test("a global convention crosses projects; a project one does not", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  await hooks.tool.save_user_role.execute({ role: "developer" }, {});
  // The project convention makes the negative assertions below meaningful:
  // the store really contains a project entry from the other root.
  await hooks.tool.save_convention.execute({ convention: "Only for this repo" }, {});
  const saved = await hooks.tool.save_convention.execute(
    { convention: "Never use any", scope: "global" },
    {}
  );
  assert.ok(saved.includes("Convention saved with global scope"));

  // A different project sharing the same Engram (same user) must receive the
  // global convention in its injection, but not the other project's one.
  const otherRoot = makeTempDir("persona-plugin-other-");
  dirs.push(otherRoot);
  const otherHooks = await makePlugin(otherRoot);
  const output = makeOutput("s-global");
  await otherHooks["chat.message"]({ sessionID: "s-global" }, output);

  const text = output.parts[0].text;
  assert.ok(text.includes("Global conventions"));
  assert.ok(text.includes("Never use any"));
  assert.ok(!text.includes("Only for this repo"), "the project convention must stay in its project");
  assert.ok(!text.includes("Conventions for this project"));

  const status = await otherHooks.tool.get_persona_status.execute({}, {});
  assert.ok(status.includes("Global conventions (1"));
  assert.ok(status.includes("Conventions for this project: none recorded"));
  assert.ok(!status.includes("Only for this repo"));
});

test("a failure reading one conventions scope still injects the other and the role", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const seed = await makePlugin(root);
  await seed.tool.save_user_role.execute({ role: "developer" }, {});
  await seed.tool.save_convention.execute({ convention: "Commits in English" }, {});
  await seed.tool.save_convention.execute({ convention: "Never use any", scope: "global" }, {});

  // Fresh home (cold id cache) so reads go through mem_search, where the
  // injected failure lives; only the global-conventions query fails.
  const failingHome = makeTempDir("persona-plugin-home-");
  dirs.push(failingHome);
  process.env.PERSONA_HOME = failingHome;
  process.env.PERSONA_ENGRAM_ARGS = JSON.stringify([FIXTURE, store, "--fail-query=global conventions"]);
  const hooks = await makePlugin(root);

  const output = makeOutput("s-degraded-global");
  await hooks["chat.message"]({ sessionID: "s-degraded-global" }, output);
  assert.equal(output.parts.length, 1, "conventions failures must never block role injection");
  const text = output.parts[0].text;
  assert.ok(text.includes("Active role instructions (developer — Developer)"));
  assert.ok(text.includes("Commits in English"), "the surviving project scope must still be injected");
  assert.ok(!text.includes("Never use any"));

  const status = await hooks.tool.get_persona_status.execute({}, {});
  assert.ok(status.includes("1. Commits in English"));
  assert.ok(status.includes("Global conventions: none recorded"));
  assert.ok(status.includes("Warning: Engram did not respond"));
});

test("a failure reading the project scope still injects the global scope", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const seed = await makePlugin(root);
  await seed.tool.save_user_role.execute({ role: "developer" }, {});
  await seed.tool.save_convention.execute({ convention: "Commits in English" }, {});
  await seed.tool.save_convention.execute({ convention: "Never use any", scope: "global" }, {});

  const failingHome = makeTempDir("persona-plugin-home-");
  dirs.push(failingHome);
  process.env.PERSONA_HOME = failingHome;
  process.env.PERSONA_ENGRAM_ARGS = JSON.stringify([FIXTURE, store, "--fail-query=project conventions"]);
  const hooks = await makePlugin(root);

  const output = makeOutput("s-degraded-project");
  await hooks["chat.message"]({ sessionID: "s-degraded-project" }, output);
  assert.equal(output.parts.length, 1, "conventions failures must never block role injection");
  const text = output.parts[0].text;
  assert.ok(text.includes("Active role instructions (developer — Developer)"));
  assert.ok(text.includes("Never use any"), "the surviving global scope must still be injected");
  assert.ok(!text.includes("Commits in English"));
});

test("preferences merge across tool calls", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  await hooks.tool.save_user_preferences.execute({ language: "galician" }, {});
  const result = await hooks.tool.save_user_preferences.execute({ verbosity: "detailed" }, {});

  assert.ok(result.includes("galician"), "the previous language must be preserved");
  assert.ok(result.includes("detailed"));
});

test("a repeated convention is not duplicated", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  await hooks.tool.save_convention.execute({ convention: "Never use any" }, {});
  const repeat = await hooks.tool.save_convention.execute({ convention: "never USE any" }, {});

  assert.ok(repeat.includes("already recorded"));
});

test("with Engram down it injects nothing and retries on the next message", async () => {
  const { root, store } = makeProject();
  process.env.PERSONA_ENGRAM_CMD = path.join(root, "does-not-exist.exe");
  process.env.PERSONA_ENGRAM_ARGS = JSON.stringify(["mcp"]);
  const hooks = await makePlugin(root);

  const down = makeOutput("s-retry");
  await hooks["chat.message"]({ sessionID: "s-retry" }, down);
  assert.equal(down.parts.length, 0, "without Engram it must inject nothing");

  useFakeEngram(store);
  const up = makeOutput("s-retry");
  await hooks["chat.message"]({ sessionID: "s-retry" }, up);
  assert.equal(up.parts.length, 1, "once Engram recovers, the same sessionID must be retried");
  assert.ok(up.parts[0].text.includes("No role is configured"));
});

test("get_persona_status returns what is recorded in Engram", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  await hooks.tool.save_user_role.execute({ role: "architect" }, {});
  await hooks.tool.save_user_preferences.execute({ language: "es" }, {});
  await hooks.tool.save_convention.execute({ convention: "Commits in English" }, {});
  await hooks.tool.save_convention.execute({ convention: "Never use any", scope: "global" }, {});

  const status = await hooks.tool.get_persona_status.execute({}, {});
  assert.ok(status.includes("Persona plugin"));
  assert.ok(status.includes("architect"));
  assert.ok(status.includes("Preferred reply language: es"));
  assert.ok(status.includes("Conventions for this project (1"));
  assert.ok(status.includes("1. Commits in English"));
  assert.ok(status.includes("Global conventions (1"));
  assert.ok(status.includes("1. Never use any"));
});

test("get_persona_status with no recorded data says so explicitly", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  const status = await hooks.tool.get_persona_status.execute({}, {});
  assert.ok(status.includes("Active role: none recorded"));
  assert.ok(status.includes("Communication preferences: none recorded"));
  assert.ok(status.includes("Global conventions: none recorded"));
  assert.ok(status.includes("Conventions for this project: none recorded"));
});

test("get_persona_status warns when Engram does not respond", async () => {
  const { root } = makeProject();
  process.env.PERSONA_ENGRAM_CMD = path.join(root, "does-not-exist.exe");
  process.env.PERSONA_ENGRAM_ARGS = JSON.stringify(["mcp"]);
  const hooks = await makePlugin(root);

  const status = await hooks.tool.get_persona_status.execute({}, {});
  assert.ok(status.includes("Warning: Engram did not respond"));
});

test("save_user_preferences with no recognizable fields saves nothing", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  const result = await hooks.tool.save_user_preferences.execute({}, {});
  assert.ok(result.includes("nothing was saved"));
});

test("the plugin writes only under the persona home, never inside the project", async () => {
  const { root, store, home } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  await hooks.tool.save_user_role.execute({ role: "developer" }, {});
  await hooks.tool.save_convention.execute({ convention: "Commits in English" }, {});
  await hooks["chat.message"]({ sessionID: "s-no-project-writes" }, makeOutput("s-no-project-writes"));

  assert.deepEqual(fs.readdirSync(root), ["harness"], "the project dir must stay untouched");
  assert.ok(fs.existsSync(path.join(home, ".persona", "persona.log")));
  assert.ok(fs.existsSync(path.join(home, ".persona", "cache", `${path.basename(root)}.json`)));
  assert.ok(fs.existsSync(path.join(home, ".persona", "projects.json")));
});

test("a newer published version is announced once, in the first reply of the session", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  await useFakeRegistry({ version: "999.0.0" });
  try {
    const hooks = await makePlugin(root);
    await hooks["chat.message"]({ sessionID: "s-update" }, makeOutput("s-update"));
    // The update check is fire-and-forget (see chat.message): give the fast
    // loopback fetch time to resolve before asserting on the first reply.
    await sleep(100);

    const first = { text: "Sure, on it." };
    await hooks["experimental.text.complete"]({ sessionID: "s-update", messageID: "m1", partID: "p1" }, first);
    assert.ok(first.text.includes("UPDATE AVAILABLE"));
    assert.ok(first.text.includes("999.0.0"), "must state the new version");
    assert.ok(first.text.includes(readInstalledVersion()), "must state the currently installed version");
    assert.ok(first.text.endsWith("Sure, on it."), "the original reply must still follow the notice");

    const second = { text: "Second reply." };
    await hooks["experimental.text.complete"]({ sessionID: "s-update", messageID: "m2", partID: "p2" }, second);
    assert.equal(second.text, "Second reply.", "the notice must not repeat on later replies");
  } finally {
    process.env.PERSONA_NPM_REGISTRY_URL = UNREACHABLE_REGISTRY_URL;
  }
});

test("no notice appears when the registry reports the same version already installed", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  await useFakeRegistry({ version: readInstalledVersion() });
  try {
    const hooks = await makePlugin(root);
    await hooks["chat.message"]({ sessionID: "s-same-version" }, makeOutput("s-same-version"));
    await sleep(100); // let the fire-and-forget check resolve before asserting

    const reply = { text: "Hello." };
    await hooks["experimental.text.complete"]({ sessionID: "s-same-version", messageID: "m1", partID: "p1" }, reply);
    assert.equal(reply.text, "Hello.");
  } finally {
    process.env.PERSONA_NPM_REGISTRY_URL = UNREACHABLE_REGISTRY_URL;
  }
});

test("no notice appears when the registry reports an older version", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  await useFakeRegistry({ version: "0.0.1" });
  try {
    const hooks = await makePlugin(root);
    await hooks["chat.message"]({ sessionID: "s-older-version" }, makeOutput("s-older-version"));
    await sleep(100); // let the fire-and-forget check resolve before asserting

    const reply = { text: "Hello." };
    await hooks["experimental.text.complete"]({ sessionID: "s-older-version", messageID: "m1", partID: "p1" }, reply);
    assert.equal(reply.text, "Hello.");
  } finally {
    process.env.PERSONA_NPM_REGISTRY_URL = UNREACHABLE_REGISTRY_URL;
  }
});

test("a registry failure never surfaces an error, leaves the role announcement intact, and is diagnosable from persona.log", async () => {
  const { root, store, home } = makeProject();
  useFakeEngram(store);
  // Default project registry (set by makeProject) already points nowhere;
  // this test just makes that failure explicit and asserts on it.
  const hooks = await makePlugin(root);
  await hooks.tool.save_user_role.execute({ role: "developer" }, {});
  await hooks["chat.message"]({ sessionID: "s-registry-down" }, makeOutput("s-registry-down"));
  // The update check is fire-and-forget (see chat.message): give the
  // background connection-refused failure time to resolve and log before
  // asserting on persona.log.
  await sleep(100);

  const reply = { text: "Working on it." };
  await hooks["experimental.text.complete"]({ sessionID: "s-registry-down", messageID: "m1", partID: "p1" }, reply);
  assert.equal(reply.text, "✨ Persona plugin: active role - Developer\n\nWorking on it.");
  assert.ok(!reply.text.includes("UPDATE AVAILABLE"));

  const log = fs.readFileSync(path.join(home, ".persona", "persona.log"), "utf-8");
  assert.ok(log.includes("update check failed"), "the registry failure must be diagnosable from persona.log");
});

test("a role announcement and an update notice appear together without clobbering each other", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  await useFakeRegistry({ version: "999.0.0" });
  try {
    const hooks = await makePlugin(root);
    await hooks.tool.save_user_role.execute({ role: "qa" }, {});
    await hooks["chat.message"]({ sessionID: "s-both" }, makeOutput("s-both"));
    await sleep(100); // let the fire-and-forget check resolve before asserting

    const reply = { text: "Working on it." };
    await hooks["experimental.text.complete"]({ sessionID: "s-both", messageID: "m1", partID: "p1" }, reply);

    assert.ok(reply.text.includes("active role - QA"));
    assert.ok(reply.text.includes("UPDATE AVAILABLE"));
    assert.ok(reply.text.includes("999.0.0"));
    assert.ok(reply.text.endsWith("Working on it."));
    assert.ok(
      reply.text.indexOf("active role - QA") < reply.text.indexOf("UPDATE AVAILABLE"),
      "role announcement comes first"
    );
    assert.ok(
      reply.text.indexOf("UPDATE AVAILABLE") < reply.text.indexOf("Working on it."),
      "the original reply still comes last"
    );
  } finally {
    process.env.PERSONA_NPM_REGISTRY_URL = UNREACHABLE_REGISTRY_URL;
  }
});

test("a slow update check does not delay the first reply, but the notice appears once it resolves on a later reply", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  // The delay must comfortably exceed chat.message's own real Engram round
  // trips (subprocess spawn + MCP handshake + role/preferences/conventions
  // reads), which run concurrently with this fetch: otherwise the check
  // could resolve before the first reply purely by chance, flaking the
  // negative assertion below.
  await useFakeRegistry({ version: "999.0.0", delayMs: 500 });
  try {
    const hooks = await makePlugin(root);
    await hooks["chat.message"]({ sessionID: "s-slow-update" }, makeOutput("s-slow-update"));

    const first = { text: "Immediate reply." };
    await hooks["experimental.text.complete"]({ sessionID: "s-slow-update", messageID: "m1", partID: "p1" }, first);
    assert.equal(first.text, "Immediate reply.", "the check cannot have resolved yet");

    await sleep(700); // comfortably longer than the registry's 500ms delay

    const second = { text: "Later reply." };
    await hooks["experimental.text.complete"]({ sessionID: "s-slow-update", messageID: "m2", partID: "p2" }, second);
    assert.ok(second.text.includes("UPDATE AVAILABLE"), "the notice appears once the check resolves");
    assert.ok(second.text.includes("999.0.0"));
  } finally {
    process.env.PERSONA_NPM_REGISTRY_URL = UNREACHABLE_REGISTRY_URL;
  }
});

test("a pending update notice survives an Engram failure and role-resolution retry on the same session", async () => {
  const { root, store } = makeProject();
  await useFakeRegistry({ version: "999.0.0" });
  try {
    // Engram is unreachable on the first message: the role read fails and
    // handledSessions is deleted to retry on the next message, but the
    // update check (a separate Set/Map pair, exactly for this reason) must
    // not be affected by that retry, and must not be re-fetched.
    process.env.PERSONA_ENGRAM_CMD = path.join(root, "does-not-exist.exe");
    process.env.PERSONA_ENGRAM_ARGS = JSON.stringify(["mcp"]);
    const hooks = await makePlugin(root);

    const down = makeOutput("s-update-retry");
    await hooks["chat.message"]({ sessionID: "s-update-retry" }, down);
    assert.equal(down.parts.length, 0, "without Engram it must inject nothing");

    // Give the backgrounded update check time to resolve, then point the
    // registry at a *different* version: if the retry below mistakenly
    // re-ran the check, this is the version that would show instead.
    await sleep(150);
    await useFakeRegistry({ version: "888.0.0" });

    useFakeEngram(store);
    const up = makeOutput("s-update-retry");
    await hooks["chat.message"]({ sessionID: "s-update-retry" }, up);
    assert.equal(up.parts.length, 1, "once Engram recovers, the same sessionID must be retried");

    const reply = { text: "Back online." };
    await hooks["experimental.text.complete"]({ sessionID: "s-update-retry", messageID: "m1", partID: "p1" }, reply);
    assert.ok(reply.text.includes("UPDATE AVAILABLE"), "the update found before the retry must still be shown");
    assert.ok(reply.text.includes("999.0.0"), "must show the version found before the retry, not a re-fetch");
    assert.ok(!reply.text.includes("888.0.0"), "must not have re-fetched the update check during the retry");
  } finally {
    process.env.PERSONA_NPM_REGISTRY_URL = UNREACHABLE_REGISTRY_URL;
  }
});
