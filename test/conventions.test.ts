import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CONVENTIONS,
  MAX_CONVENTION_LENGTH,
  appendConvention,
  buildConventionsContext,
  sanitizeConventions,
  type ProjectConventions,
} from "../src/conventions.ts";

const EMPTY: ProjectConventions = { conventions: [] };

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

test("buildConventionsContext returns null without conventions and a list with them", () => {
  assert.equal(buildConventionsContext(EMPTY), null);
  const current = appendConvention(EMPTY, "Never use any").updated;
  const text = buildConventionsContext(current);
  assert.ok(text?.includes("Working conventions recorded"));
  assert.ok(text?.includes("local Engram"), "it must make clear the scope is the user's local Engram");
  assert.ok(text?.includes("- Never use any"));
});
