import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { PersonaLogger } from "../src/logger.ts";
import { makeTempDir, removeDir } from "./helpers/tmp.ts";

const dirs: string[] = [];

function makeDirs(): { root: string; home: string } {
  const root = makeTempDir("persona-logger-root-");
  const home = makeTempDir("persona-logger-home-");
  dirs.push(root, home);
  return { root, home };
}

function readLog(home: string): string {
  return fs.readFileSync(path.join(home, ".persona", "persona.log"), "utf-8");
}

after(() => dirs.forEach(removeDir));

test("log writes to <home>/.persona/persona.log, tagging the line with the project key", () => {
  const { root, home } = makeDirs();
  new PersonaLogger(root, home).log("hello", { a: 1 });
  const key = path.basename(root);
  assert.match(readLog(home), new RegExp(`^\\[\\d{4}-\\d{2}-\\d{2}T[^\\]]+\\] \\[${key}\\] hello \\{"a":1\\}\\n$`));
});

test("projects share the log file but keep distinct tags", () => {
  const { root, home } = makeDirs();
  const otherRoot = makeTempDir("persona-logger-other-");
  dirs.push(otherRoot);
  new PersonaLogger(root, home).log("first");
  new PersonaLogger(otherRoot, home).log("second");
  const content = readLog(home);
  assert.ok(content.includes(`[${path.basename(root)}] first`));
  assert.ok(content.includes(`[${path.basename(otherRoot)}] second`));
});

test("error prefixes ERROR and serializes the Error message", () => {
  const { root, home } = makeDirs();
  new PersonaLogger(root, home).error("boom", new Error("cause"));
  assert.ok(readLog(home).includes("ERROR: boom cause"));
});

test("an unwritable home never throws", () => {
  const { root, home } = makeDirs();
  // A file where <home>/.persona should be makes every append fail.
  fs.writeFileSync(path.join(home, ".persona"), "not a directory");
  const logger = new PersonaLogger(root, home);
  assert.doesNotThrow(() => logger.log("dropped"));
  assert.doesNotThrow(() => logger.error("dropped too", new Error("x")));
});
