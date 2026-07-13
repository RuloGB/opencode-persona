import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { EngramCacheStore } from "../src/engram-cache.ts";
import { cachePath } from "../src/storage-paths.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const dirs: string[] = [];

function makeDirs(): { root: string; home: string } {
  const root = makeTempDir("persona-cache-root-");
  const home = makeTempDir("persona-cache-home-");
  dirs.push(root, home);
  return { root, home };
}

after(() => dirs.forEach(removeDir));

test("set persists under the home cache dir and another instance retrieves it", () => {
  const { root, home } = makeDirs();
  new EngramCacheStore(root, home).set("user_role", "42");
  assert.equal(new EngramCacheStore(root, home).get("user_role"), "42");
  const file = path.join(home, ".persona", "cache", `${path.basename(root)}.json`);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(onDisk, { user_role: "42" });
});

test("get returns undefined without a previous cache", () => {
  const { root, home } = makeDirs();
  assert.equal(new EngramCacheStore(root, home).get("user_role"), undefined);
});

test("a corrupt cache starts clean without throwing", () => {
  const { root, home } = makeDirs();
  const file = cachePath(root, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{corrupt");
  const store = new EngramCacheStore(root, home);
  assert.equal(store.get("user_role"), undefined);
  store.set("user_role", "7");
  assert.equal(new EngramCacheStore(root, home).get("user_role"), "7");
});

test("a failed write keeps the cache working in memory", () => {
  const { root, home } = makeDirs();
  // A file where the cache directory should be makes every write fail.
  fs.mkdirSync(path.join(home, ".persona"), { recursive: true });
  fs.writeFileSync(path.join(home, ".persona", "cache"), "not a directory");
  const store = new EngramCacheStore(root, home);
  assert.doesNotThrow(() => store.set("user_role", "42"));
  assert.equal(store.get("user_role"), "42");
  assert.ok(!fs.existsSync(cachePath(root, home)));
});
