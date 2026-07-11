import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { EngramCacheStore } from "../src/engram-cache.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const dirs: string[] = [];

function makeRoot(): string {
  const root = makeTempDir("persona-cache-");
  dirs.push(root);
  return root;
}

after(() => dirs.forEach(removeDir));

test("set persists and another instance retrieves it", () => {
  const root = makeRoot();
  new EngramCacheStore(root).set("user_role", "42");
  assert.equal(new EngramCacheStore(root).get("user_role"), "42");
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".opencode", ".persona-cache.json"), "utf-8"));
  assert.deepEqual(onDisk, { user_role: "42" });
});

test("get returns undefined without a previous cache", () => {
  assert.equal(new EngramCacheStore(makeRoot()).get("user_role"), undefined);
});

test("a corrupt cache starts clean without throwing", () => {
  const root = makeRoot();
  const cachePath = path.join(root, ".opencode", ".persona-cache.json");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, "{corrupt");
  const store = new EngramCacheStore(root);
  assert.equal(store.get("user_role"), undefined);
  store.set("user_role", "7");
  assert.equal(new EngramCacheStore(root).get("user_role"), "7");
});
