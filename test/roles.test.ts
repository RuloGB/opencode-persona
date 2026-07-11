import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { buildRoleContext, findProjectRoot, isRole } from "../src/roles.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const dirs: string[] = [];

function makeProject(withRoleFile: boolean): string {
  const root = makeTempDir("persona-roles-");
  dirs.push(root);
  fs.mkdirSync(path.join(root, "harness", "user-roles"), { recursive: true });
  if (withRoleFile) {
    fs.writeFileSync(path.join(root, "harness", "user-roles", "DEV.md"), "Test DEV content");
  }
  return root;
}

after(() => dirs.forEach(removeDir));

test("isRole accepts only the roles in the catalog", () => {
  assert.equal(isRole("developer"), true);
  assert.equal(isRole("qa"), true);
  assert.equal(isRole("manager"), false);
  assert.equal(isRole(1), false);
});

test("findProjectRoot walks up to the folder containing harness/user-roles", () => {
  const root = makeProject(false);
  const nested = path.join(root, "src", "modules", "deep");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findProjectRoot(nested), root);
});

test("findProjectRoot returns null without harness/user-roles in the ancestor directories", () => {
  const orphan = makeTempDir("persona-orphan-");
  dirs.push(orphan);
  assert.equal(findProjectRoot(orphan), null);
});

test("buildRoleContext includes the role file's instructions", () => {
  const root = makeProject(true);
  const text = buildRoleContext("developer", root);
  assert.ok(text.includes("Test DEV content"));
  assert.ok(text.includes("developer"));
});

test("buildRoleContext degrades with a clear message when the file is missing", () => {
  const root = makeProject(false);
  const text = buildRoleContext("qa", root);
  assert.ok(text.includes("was not found"));
  assert.ok(text.includes("QA.md"));
});
