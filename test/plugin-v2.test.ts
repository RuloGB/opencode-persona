// OpenCode v2 adapter tests with a simulated v2 plugin context and the fake
// Engram (via PERSONA_ENGRAM_CMD/ARGS). They also pin the published module
// shape that both loaders decode: v1 (>= 1.18.29) reads `default.server`, v2
// reads `default.setup`.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import PersonaModule, { Persona } from "../src/index.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const FIXTURE = fileURLToPath(new URL("./helpers/fake-engram.ts", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));
const TOOL_NAMES = ["save_user_role", "save_user_preferences", "save_convention", "get_persona_status"];

const dirs: string[] = [];
after(() => dirs.forEach(removeDir));

function makeProject(): { root: string; store: string } {
  const root = makeTempDir("persona-v2-");
  const home = makeTempDir("persona-v2-home-");
  dirs.push(root, home);
  process.env.PERSONA_HOME = home;
  process.env.PERSONA_ENGRAM_CMD = process.execPath;
  const store = path.join(home, "fake-engram-store.json");
  process.env.PERSONA_ENGRAM_ARGS = JSON.stringify([FIXTURE, store]);
  fs.mkdirSync(path.join(root, "harness", "user-roles"), { recursive: true });
  fs.writeFileSync(path.join(root, "harness", "user-roles", "DEV.md"), "Test DEV content");
  return { root, store };
}

interface FakeTool {
  name: string;
  description: string;
  input: unknown;
  options?: { codemode?: boolean };
  execute: (input: Record<string, unknown>, context: unknown) => Promise<{ content: string }>;
}

type SystemPart = { type: "text"; text: string };

// Minimal stand-in for the v2 plugin context: records hook callbacks and
// added tools, and exposes an event stream the test can push into.
function fakeV2Context(root: string, parentBySession: Record<string, string | undefined> = {}) {
  const hooks = new Map<string, (event: never) => Promise<void> | void>();
  const tools: FakeTool[] = [];
  const queued: unknown[] = [];
  let wake: (() => void) | undefined;
  let subscribed: AbortSignal | undefined;

  const context = {
    location: { directory: root, project: { id: "p", directory: root, canonical: root } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parentBySession[sessionID] }),
      hook: async (name: string, callback: (event: never) => Promise<void> | void) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (tool: FakeTool) => void }) => void) => {
        callback({ add: (tool) => tools.push(tool) });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }): AsyncIterable<unknown> => {
        subscribed = options?.signal;
        return {
          async *[Symbol.asyncIterator]() {
            while (!subscribed?.aborted) {
              if (queued.length === 0) {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  subscribed?.addEventListener("abort", () => resolve(), { once: true });
                });
                continue;
              }
              yield queued.shift();
            }
          },
        };
      },
    },
  };

  return {
    context,
    tools,
    hooks,
    subscribedSignal: () => subscribed,
    async emit(event: unknown): Promise<void> {
      queued.push(event);
      wake?.();
      // Let the plugin's consumer loop drain the event.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

async function setupPlugin(root: string, parentBySession: Record<string, string | undefined> = {}) {
  const fake = fakeV2Context(root, parentBySession);
  const cleanup = await PersonaModule.setup(fake.context as never);
  const tool = (name: string) => {
    const found = fake.tools.find((t) => t.name === name);
    assert.ok(found, `tool ${name} must be registered`);
    return found;
  };
  async function prompt(sessionID: string): Promise<void> {
    await fake.hooks.get("prompt")?.({ sessionID, messageID: "m1", prompt: {}, delivery: "immediate" } as never);
  }
  async function system(sessionID: string): Promise<string> {
    const base: SystemPart = { type: "text", text: "You are opencode." };
    const event = { sessionID, model: {}, agent: "build", system: [base], messages: [], options: {}, tools: {} };
    await fake.hooks.get("context")?.(event as never);
    assert.deepEqual(event.system[0], base, "existing system parts must stay untouched");
    return (event.system.slice(1) as SystemPart[])
      .map((part) => {
        assert.equal(part.type, "text");
        return part.text;
      })
      .join("\n\n");
  }
  return { fake, cleanup, tool, prompt, system };
}

test("the default export satisfies both loaders: id + server (v1) and setup (v2)", () => {
  assert.equal(typeof PersonaModule.id, "string");
  assert.equal(PersonaModule.id, "opencode-persona");
  assert.equal(typeof PersonaModule.server, "function");
  assert.equal(typeof PersonaModule.setup, "function");
  assert.ok(!("effect" in PersonaModule), "an effect key would make v2 pick the Effect branch");
  assert.ok(!("tui" in PersonaModule), "v1 rejects a module exporting both server and tui");
  assert.equal(PersonaModule.server, Persona, "the named export stays the v1 server plugin");
});

test("no source module imports @opencode-ai/plugin as a runtime value", () => {
  for (const file of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts"))) {
    const source = fs.readFileSync(path.join(SRC_DIR, file), "utf8");
    const valueImport = /^import\s+(?!type\s)[^;]*from\s+["']@opencode-ai\/plugin["']/m;
    assert.ok(!valueImport.test(source), `${file} must use import type for @opencode-ai/plugin (absent on v2)`);
  }
});

test("v2 setup registers the four tools, directly callable by name", async () => {
  const { root } = makeProject();
  const { fake, cleanup } = await setupPlugin(root);

  assert.deepEqual(fake.tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of fake.tools) {
    assert.ok(tool.description.length > 0);
    // Plain JSON Schema, as the official v2 migration guide shows: v2 sends it
    // to the provider as-is and validates the input against it itself.
    const input = tool.input as Record<string, unknown>;
    assert.equal(input.type, "object", `${tool.name} input must be an object JSON Schema`);
    assert.equal(typeof input.properties, "object");
    assert.ok(!("~standard" in input), `${tool.name} input must not be a Standard Schema (zod) object`);
    assert.deepEqual(JSON.parse(JSON.stringify(input)), input, `${tool.name} input must be plain JSON`);
    assert.equal(tool.options?.codemode, false, "prompts name the tools, so they must not hide behind Code Mode");
  }
  await cleanup?.();
});

test("v2 injects the bootstrap into the system parts after the first prompt", async () => {
  const { root } = makeProject();
  const { prompt, system, cleanup } = await setupPlugin(root);

  assert.equal(await system("s-v2-boot"), "", "nothing is injected before the first prompt");
  await prompt("s-v2-boot");
  const text = await system("s-v2-boot");
  assert.ok(text.includes("No role is configured"));
  assert.equal(await system("s-v2-boot"), text, "the same context is injected on every request");
  await cleanup?.();
});

test("v2 tools return content and a saved role reaches the next session", async () => {
  const { root } = makeProject();
  const { tool, prompt, system, cleanup } = await setupPlugin(root);

  const roleInput = tool("save_user_role").input as { properties: { role: { enum: string[] } }; required: string[] };
  assert.ok(roleInput.properties.role.enum.includes("developer"), "the role enum survives the JSON Schema conversion");
  assert.deepEqual(roleInput.required, ["role"]);

  const saved = await tool("save_user_role").execute({ role: "developer" }, {});
  assert.equal(typeof saved.content, "string");
  assert.ok(saved.content.includes("Test DEV content"));

  await prompt("s-v2-role");
  assert.ok((await system("s-v2-role")).includes("Test DEV content"));

  const status = await tool("get_persona_status").execute({}, {});
  assert.ok(status.content.includes("developer"));
  await cleanup?.();
});

test("v2 skips subagent sessions", async () => {
  const { root } = makeProject();
  const { prompt, system, cleanup } = await setupPlugin(root, { "s-v2-sub": "s-v2-parent" });

  await prompt("s-v2-sub");
  assert.equal(await system("s-v2-sub"), "", "a subagent session receives no injection");
  await cleanup?.();
});

test("v2 session.deleted drops the stored context, and cleanup ends the subscription", async () => {
  const { root } = makeProject();
  const { fake, prompt, system, cleanup } = await setupPlugin(root);

  await prompt("s-v2-del");
  assert.ok((await system("s-v2-del")) !== "");

  await fake.emit({ type: "session.deleted", data: { sessionID: "s-v2-del" } });
  assert.equal(await system("s-v2-del"), "", "a deleted session keeps nothing in memory");

  assert.equal(typeof cleanup, "function");
  await cleanup?.();
  assert.equal(fake.subscribedSignal()?.aborted, true, "cleanup must abort the event subscription");
});
