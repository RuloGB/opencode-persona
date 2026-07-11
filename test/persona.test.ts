// Full-plugin tests with a simulated OpenCode client and the fake Engram
// (via PERSONA_ENGRAM_CMD/ARGS). They cover the real cycle: bootstrap, role
// save, injection in a new session, deduplication, subagents, and degradation.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Persona } from "../src/index.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const FIXTURE = fileURLToPath(new URL("./helpers/fake-engram.ts", import.meta.url));

const dirs: string[] = [];

after(() => dirs.forEach(removeDir));

function makeProject(): { root: string; store: string } {
  const root = makeTempDir("persona-plugin-");
  dirs.push(root);
  fs.mkdirSync(path.join(root, "harness", "user-roles"), { recursive: true });
  fs.writeFileSync(path.join(root, "harness", "user-roles", "DEV.md"), "Test DEV content");
  return { root, store: path.join(root, "fake-engram-store.json") };
}

function useFakeEngram(store: string): void {
  process.env.PERSONA_ENGRAM_CMD = process.execPath;
  process.env.PERSONA_ENGRAM_ARGS = JSON.stringify([FIXTURE, store]);
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
  assert.ok(output.parts[0].text.includes("active role — Developer"));
  assert.ok(output.parts[0].text.includes("save_user_role"), "it must state how to change roles");
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

  const convResult = await hooks.tool.save_project_convention.execute(
    { convention: "Commits are written in English" },
    {}
  );
  assert.ok(convResult.includes("Convention saved"));

  const output = makeOutput("s-full");
  await hooks["chat.message"]({ sessionID: "s-full" }, output);

  const text = output.parts[0].text;
  assert.ok(text.includes("User preferences"));
  assert.ok(text.includes("Reply language: en"));
  assert.ok(text.includes("Working conventions recorded"));
  assert.ok(text.includes("Commits are written in English"));
  // The kickoff announcement must come last, after preferences and conventions.
  assert.ok(text.indexOf("Start your next reply") > text.indexOf("Working conventions recorded"));
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

  await hooks.tool.save_project_convention.execute({ convention: "Never use any" }, {});
  const repeat = await hooks.tool.save_project_convention.execute({ convention: "never USE any" }, {});

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
  await hooks.tool.save_project_convention.execute({ convention: "Commits in English" }, {});

  const status = await hooks.tool.get_persona_status.execute({}, {});
  assert.ok(status.includes("Persona plugin"));
  assert.ok(status.includes("architect"));
  assert.ok(status.includes("Preferred reply language: es"));
  assert.ok(status.includes("1. Commits in English"));
});

test("get_persona_status with no recorded data says so explicitly", async () => {
  const { root, store } = makeProject();
  useFakeEngram(store);
  const hooks = await makePlugin(root);

  const status = await hooks.tool.get_persona_status.execute({}, {});
  assert.ok(status.includes("Active role: none recorded"));
  assert.ok(status.includes("Communication preferences: none recorded"));
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
