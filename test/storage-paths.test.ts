import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  cachePath,
  logPath,
  personaHome,
  projectKey,
  projectsIndexPath,
  registerProject,
} from "../src/storage-paths.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const dirs: string[] = [];

function makeHome(): string {
  const home = makeTempDir("persona-paths-home-");
  dirs.push(home);
  return home;
}

after(() => dirs.forEach(removeDir));

test("projectKey is the basename of the normalized project root", () => {
  const root = path.join(makeHome(), "sub", "my-app");
  assert.equal(projectKey(root), "my-app");
  assert.equal(projectKey(root + path.sep), "my-app");
  assert.equal(projectKey(root + path.sep + "nested" + path.sep + ".."), "my-app");
});

test("projectKey falls back for degenerate roots without a basename", () => {
  const fsRoot = path.parse(process.cwd()).root; // "C:\\" on Windows, "/" elsewhere
  assert.equal(projectKey(fsRoot), "unknown-project");
});

test("all paths hang from <home>/.persona when a home override is given", () => {
  const home = makeHome();
  const root = path.join(home, "projects", "demo");
  assert.equal(personaHome(home), path.join(home, ".persona"));
  assert.equal(logPath(home), path.join(home, ".persona", "persona.log"));
  assert.equal(cachePath(root, home), path.join(home, ".persona", "cache", "demo.json"));
  assert.equal(projectsIndexPath(home), path.join(home, ".persona", "projects.json"));
});

test("registerProject creates the index with root and lastSeen", () => {
  const home = makeHome();
  const root = path.join(home, "projects", "demo");
  registerProject(root, home);
  const index = JSON.parse(fs.readFileSync(projectsIndexPath(home), "utf-8"));
  assert.equal(index.demo.root, path.resolve(root));
  assert.ok(!Number.isNaN(Date.parse(index.demo.lastSeen)), "lastSeen must be a parseable timestamp");
});

test("registerProject upserts by project key without dropping other projects", () => {
  const home = makeHome();
  registerProject(path.join(home, "a", "demo"), home);
  registerProject(path.join(home, "other-app"), home);
  registerProject(path.join(home, "b", "demo"), home); // same key, new root
  const index = JSON.parse(fs.readFileSync(projectsIndexPath(home), "utf-8"));
  assert.deepEqual(Object.keys(index).sort(), ["demo", "other-app"]);
  assert.equal(index.demo.root, path.resolve(path.join(home, "b", "demo")));
});

test("a corrupt projects index starts clean without throwing", () => {
  const home = makeHome();
  fs.mkdirSync(personaHome(home), { recursive: true });
  fs.writeFileSync(projectsIndexPath(home), "{corrupt");
  registerProject(path.join(home, "demo"), home);
  const index = JSON.parse(fs.readFileSync(projectsIndexPath(home), "utf-8"));
  assert.deepEqual(Object.keys(index), ["demo"]);

  // An index with the wrong shape is discarded just like invalid JSON.
  fs.writeFileSync(projectsIndexPath(home), JSON.stringify(["not", "an", "object"]));
  registerProject(path.join(home, "demo2"), home);
  const again = JSON.parse(fs.readFileSync(projectsIndexPath(home), "utf-8"));
  assert.deepEqual(Object.keys(again), ["demo2"]);
});

test("a failed index write never throws", () => {
  const home = makeHome();
  fs.mkdirSync(projectsIndexPath(home), { recursive: true }); // a directory blocks both read and write
  assert.doesNotThrow(() => registerProject(path.join(home, "demo"), home));
});
