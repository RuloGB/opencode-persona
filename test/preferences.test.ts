import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPreferencesContext,
  hasPreferences,
  isVerbosity,
  mergePreferences,
  sanitizePreferences,
} from "../src/preferences.ts";

test("isVerbosity accepts only the levels in the catalog", () => {
  assert.equal(isVerbosity("concise"), true);
  assert.equal(isVerbosity("balanced"), true);
  assert.equal(isVerbosity("detailed"), true);
  assert.equal(isVerbosity("verbose"), false);
  assert.equal(isVerbosity(42), false);
  assert.equal(isVerbosity(undefined), false);
});

test("sanitizePreferences drops corrupt fields without throwing", () => {
  assert.deepEqual(sanitizePreferences(null), {});
  assert.deepEqual(sanitizePreferences("text"), {});
  assert.deepEqual(sanitizePreferences({ language: 42, verbosity: "wat" }), {});
  assert.deepEqual(sanitizePreferences({ language: "  en  ", verbosity: "concise" }), {
    language: "en",
    verbosity: "concise",
  });
});

test("sanitizePreferences rejects oversized or empty languages", () => {
  assert.deepEqual(sanitizePreferences({ language: "   " }), {});
  assert.deepEqual(sanitizePreferences({ language: "x".repeat(41) }), {});
  assert.deepEqual(sanitizePreferences({ language: "x".repeat(40) }), { language: "x".repeat(40) });
});

test("mergePreferences keeps whatever is not provided", () => {
  const merged = mergePreferences({ language: "es", verbosity: "detailed" }, { verbosity: "concise" });
  assert.deepEqual(merged, { language: "es", verbosity: "concise" });
});

test("mergePreferences ignores invalid values from the model", () => {
  const merged = mergePreferences({ language: "es" }, { language: "", verbosity: "wat" as never });
  assert.deepEqual(merged, { language: "es" });
});

test("buildPreferencesContext returns null without preferences", () => {
  assert.equal(buildPreferencesContext({}), null);
  assert.equal(hasPreferences({}), false);
});

test("buildPreferencesContext lists only the fields present", () => {
  const text = buildPreferencesContext({ language: "en" });
  assert.ok(text?.includes("Reply language: en"));
  assert.ok(!text?.includes("Level of detail"));

  const full = buildPreferencesContext({ language: "en", verbosity: "concise" });
  assert.ok(full?.includes("Reply language: en"));
  assert.ok(full?.includes("Level of detail: concise"));
});

test("buildPreferencesContext states that the saved language wins over mirroring", () => {
  const text = buildPreferencesContext({ language: "en" });
  assert.ok(text?.includes("takes precedence over the language the user writes in"));
});

test("buildPreferencesContext omits the precedence sentence with verbosity only", () => {
  const text = buildPreferencesContext({ verbosity: "concise" });
  assert.ok(text?.includes("Level of detail: concise"));
  assert.ok(!text?.includes("takes precedence"));
});
