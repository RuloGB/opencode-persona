import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CONVENTIONS,
  MAX_CONVENTION_LENGTH,
  appendConvention,
  buildConventionsContext,
  sanitizeConventions,
  type ConventionList,
} from "../src/conventions.ts";

const EMPTY: ConventionList = { conventions: [] };

test("appendConvention adds normalizing whitespace and line breaks", () => {
  const { updated, added, normalized } = appendConvention(EMPTY, "  Commits \n  in English  ");
  assert.equal(added, true);
  assert.equal(normalized, "Commits in English");
  assert.deepEqual(
    updated.conventions.map((c) => c.text),
    ["Commits in English"]
  );
});

test("appendConvention does not duplicate ignoring case", () => {
  const first = appendConvention(EMPTY, "Commits in English").updated;
  const { updated, added, normalized } = appendConvention(first, "commits IN english");
  assert.equal(added, false);
  assert.equal(normalized, "commits IN english");
  assert.equal(updated.conventions.length, 1);
});

test("appendConvention rejects empty inputs", () => {
  const { added, normalized } = appendConvention(EMPTY, "   \n  ");
  assert.equal(added, false);
  assert.equal(normalized, null);
});

test("appendConvention trims texts above the maximum", () => {
  const { normalized } = appendConvention(EMPTY, "x".repeat(MAX_CONVENTION_LENGTH + 50));
  assert.equal(normalized?.length, MAX_CONVENTION_LENGTH);
});

test("appendConvention drops the oldest entry past the cap", () => {
  let current = EMPTY;
  for (let i = 0; i < MAX_CONVENTIONS + 3; i++) {
    current = appendConvention(current, `Rule number ${i}`).updated;
  }
  assert.equal(current.conventions.length, MAX_CONVENTIONS);
  assert.equal(current.conventions[0].text, "Rule number 3");
  assert.equal(current.conventions.at(-1)?.text, `Rule number ${MAX_CONVENTIONS + 2}`);
});

test("sanitizeConventions drops corrupt entries without throwing", () => {
  assert.deepEqual(sanitizeConventions(null), EMPTY);
  assert.deepEqual(sanitizeConventions({ conventions: "not-an-array" }), EMPTY);
  const result = sanitizeConventions({
    conventions: [{ text: "Valid rule", saved_at: "2026-07-06" }, { text: 42 }, "garbage", null],
  });
  assert.deepEqual(
    result.conventions.map((c) => c.text),
    ["Valid rule"]
  );
});

test("buildConventionsContext returns null when both scopes are empty", () => {
  assert.equal(buildConventionsContext(EMPTY, EMPTY), null);
});

test("buildConventionsContext renders the project block alone", () => {
  const project = appendConvention(EMPTY, "Never use any").updated;
  const text = buildConventionsContext(EMPTY, project);
  assert.ok(text?.includes("Working conventions recorded"));
  assert.ok(text?.includes("local Engram"), "it must make clear the scope is the user's local Engram");
  assert.ok(text?.includes("Conventions for this project:"));
  assert.ok(text?.includes("- Never use any"));
  assert.ok(!text?.includes("Global conventions"));
});

test("buildConventionsContext renders the global block alone", () => {
  const global = appendConvention(EMPTY, "Reply in English").updated;
  const text = buildConventionsContext(global, EMPTY);
  assert.ok(text?.includes("Global conventions (they apply in ALL of the user's projects):"));
  assert.ok(text?.includes("- Reply in English"));
  assert.ok(!text?.includes("Conventions for this project"));
});

test("buildConventionsContext renders both blocks with global first", () => {
  const global = appendConvention(EMPTY, "Reply in English").updated;
  const project = appendConvention(EMPTY, "Never use any").updated;
  const text = buildConventionsContext(global, project) ?? "";
  assert.ok(text.includes("- Reply in English"));
  assert.ok(text.includes("- Never use any"));
  assert.ok(text.indexOf("Global conventions") < text.indexOf("Conventions for this project"));
});

test("a convention present in both scopes is listed only once, in the project block", () => {
  const global = appendConvention(EMPTY, "never USE any").updated;
  const project = appendConvention(EMPTY, "Never use any").updated;
  const text = buildConventionsContext(global, project) ?? "";
  assert.ok(!text.includes("Global conventions"), "an emptied global block must disappear");
  assert.equal((text.match(/use any/gi) ?? []).length, 1);
  assert.ok(text.includes("- Never use any"), "the project spelling wins");
});

test("dedupe keeps global conventions absent from the project list", () => {
  let global = appendConvention(EMPTY, "Rule A").updated;
  global = appendConvention(global, "Rule B").updated;
  const project = appendConvention(EMPTY, "rule b").updated;
  const text = buildConventionsContext(global, project) ?? "";
  const globalBlock = text.slice(text.indexOf("Global conventions"), text.indexOf("Conventions for this project"));
  assert.ok(globalBlock.includes("- Rule A"));
  assert.ok(!globalBlock.includes("- Rule B"));
  assert.ok(text.includes("- rule b"));
});
