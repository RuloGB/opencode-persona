import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ENTRY_GLOBAL_CONVENTIONS,
  ENTRY_PROJECT_CONVENTIONS,
  ENTRY_USER_ROLE,
  EngramClient,
  EngramUnavailableError,
} from "../src/engram-client.ts";
import { cachePath } from "../src/storage-paths.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const FIXTURE = fileURLToPath(new URL("./helpers/fake-engram.ts", import.meta.url));

// The client persists its id cache under ~/.persona; every client gets an
// explicit home override so the tests never touch the real one.
const HOME = makeTempDir("persona-client-home-");

const dirs: string[] = [HOME];
const clients: EngramClient[] = [];

function makeRoot(): string {
  const root = makeTempDir("persona-client-");
  dirs.push(root);
  return root;
}

function makeClient(projectRoot: string, storePath: string, extraArgs: string[] = []): EngramClient {
  const client = new EngramClient(projectRoot, undefined, {
    command: process.execPath,
    args: [FIXTURE, storePath, ...extraArgs],
    connectTimeoutMs: 10_000,
    callTimeoutMs: 10_000,
    home: HOME,
  });
  clients.push(client);
  return client;
}

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  dirs.forEach(removeDir);
});

test("saves and retrieves a personal entry", async () => {
  const root = makeRoot();
  const store = path.join(root, "store.json");
  const client = makeClient(root, store);

  await client.save(ENTRY_USER_ROLE, { role: "qa", source: "test" });
  const payload = await client.get<{ role?: string }>(ENTRY_USER_ROLE);
  assert.equal(payload?.role, "qa");
});

test("saving the same topic twice does not duplicate (upsert)", async () => {
  const root = makeRoot();
  const store = path.join(root, "store.json");
  const client = makeClient(root, store);

  await client.save(ENTRY_USER_ROLE, { role: "developer" });
  await client.save(ENTRY_USER_ROLE, { role: "architect" });

  const onDisk = JSON.parse(fs.readFileSync(store, "utf-8"));
  assert.equal(onDisk.entries.length, 1);
  const payload = await client.get<{ role?: string }>(ENTRY_USER_ROLE);
  assert.equal(payload?.role, "architect");
});

test("project entries are saved with project scope", async () => {
  const root = makeRoot();
  const store = path.join(root, "store.json");
  const client = makeClient(root, store);

  await client.save(ENTRY_PROJECT_CONVENTIONS, { conventions: [{ text: "Rule", saved_at: "today" }] });

  const onDisk = JSON.parse(fs.readFileSync(store, "utf-8"));
  assert.equal(onDisk.entries[0].scope, "project");
  const payload = await client.get<{ conventions?: unknown[] }>(ENTRY_PROJECT_CONVENTIONS);
  assert.equal(payload?.conventions?.length, 1);
});

test("project entries are not found from another project root", async () => {
  const root = makeRoot();
  const store = path.join(root, "store.json");
  const writer = makeClient(root, store);

  await writer.save(ENTRY_PROJECT_CONVENTIONS, { conventions: [{ text: "Rule", saved_at: "today" }] });

  // The client sends all_projects only for personal entries: a project entry
  // saved under a different root must stay invisible from this one.
  const reader = makeClient(makeRoot(), store);
  assert.equal(await reader.get(ENTRY_PROJECT_CONVENTIONS), null);
});

test("global conventions use personal scope and are found from another project", async () => {
  const root = makeRoot();
  const store = path.join(root, "store.json");
  const writer = makeClient(root, store);

  await writer.save(ENTRY_GLOBAL_CONVENTIONS, { conventions: [{ text: "Rule", saved_at: "today" }] });

  const onDisk = JSON.parse(fs.readFileSync(store, "utf-8"));
  assert.equal(onDisk.entries[0].scope, "personal");
  assert.equal(onDisk.entries[0].topic_key, "persona/global-conventions");

  // A different project root starts with a cold cache and must relocate the
  // entry via mem_search across projects.
  const reader = makeClient(makeRoot(), store);
  const payload = await reader.get<{ conventions?: unknown[] }>(ENTRY_GLOBAL_CONVENTIONS);
  assert.equal(payload?.conventions?.length, 1);
});

test("a stale cached id falls back to mem_search and repairs the cache", async () => {
  const root = makeRoot();
  const store = path.join(root, "store.json");
  const writer = makeClient(root, store);
  await writer.save(ENTRY_USER_ROLE, { role: "analyst" });
  await writer.close();

  const cacheFile = cachePath(root, HOME);
  fs.writeFileSync(cacheFile, JSON.stringify({ [ENTRY_USER_ROLE.key]: "999" }));

  const reader = makeClient(root, store);
  const payload = await reader.get<{ role?: string }>(ENTRY_USER_ROLE);
  assert.equal(payload?.role, "analyst");

  const repaired = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
  assert.notEqual(repaired[ENTRY_USER_ROLE.key], "999");
});

test("returns null when no entry is saved", async () => {
  const root = makeRoot();
  const client = makeClient(root, path.join(root, "store.json"));
  assert.equal(await client.get(ENTRY_USER_ROLE), null);
});

test("a missing binary degrades with EngramUnavailableError", async () => {
  const root = makeRoot();
  const client = new EngramClient(root, undefined, {
    command: path.join(root, "does-not-exist.exe"),
    args: ["mcp"],
    connectTimeoutMs: 5000,
    home: HOME,
  });
  clients.push(client);
  await assert.rejects(client.get(ENTRY_USER_ROLE), EngramUnavailableError);
});

test("a hung handshake degrades via timeout without blocking", async () => {
  const root = makeRoot();
  const client = new EngramClient(root, undefined, {
    command: process.execPath,
    args: [FIXTURE, path.join(root, "store.json"), "--hang"],
    connectTimeoutMs: 500,
    home: HOME,
  });
  clients.push(client);
  await assert.rejects(client.get(ENTRY_USER_ROLE), EngramUnavailableError);
});
