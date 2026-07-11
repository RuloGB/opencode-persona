import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOOTSTRAP_PROMPT,
  LANGUAGE_INSTRUCTION,
  PERSONA_PREFIX,
  buildPersonaStatusResult,
  buildRoleAnnouncement,
  buildSaveConventionResult,
  buildSavePreferencesResult,
  buildSaveRoleResult,
} from "../src/prompts.ts";

test("the role announcement states how to change roles and how to query the status", () => {
  const text = buildRoleAnnouncement("qa");
  assert.ok(text.includes("active role — QA"));
  assert.ok(text.includes("save_user_role"));
  assert.ok(text.includes("get_persona_status"));
});

test("buildSaveRoleResult distinguishes persisted from session-only", () => {
  assert.ok(buildSaveRoleResult("developer", true, "ctx", false).includes("Role saved"));
  assert.ok(buildSaveRoleResult("developer", false, "ctx", false).includes("for this session only"));
});

test("buildSaveRoleResult offers the optional configuration only the first time with a healthy Engram", () => {
  const first = buildSaveRoleResult("developer", true, "ctx", true);
  assert.ok(first.includes("always reply in English"));
  assert.ok(first.includes("save as a convention"));
  assert.ok(first.includes("what do I have configured in Persona"));
  assert.ok(first.includes("NOT shared"));

  const roleChange = buildSaveRoleResult("developer", true, "ctx", false);
  assert.ok(!roleChange.includes("always reply in English"));

  const notPersisted = buildSaveRoleResult("developer", false, "ctx", true);
  assert.ok(!notPersisted.includes("always reply in English"));
});

test("buildSavePreferencesResult summarizes what was saved", () => {
  const text = buildSavePreferencesResult({ language: "en", verbosity: "concise" }, true);
  assert.ok(text.includes("reply language: en"));
  assert.ok(text.includes("concise"));
  assert.ok(text.includes("future sessions"));
});

test("buildSavePreferencesResult warns when nothing persists or no fields are given", () => {
  assert.ok(buildSavePreferencesResult({ language: "en" }, false).includes("for this session only"));
  assert.ok(buildSavePreferencesResult({}, true).includes("nothing was saved"));
});

test("buildSaveConventionResult covers added, duplicate, and empty", () => {
  const texts = ["Previous rule", "Rule X"];
  assert.ok(buildSaveConventionResult("Rule X", true, texts, true).includes("Convention saved"));
  assert.ok(buildSaveConventionResult("Rule X", false, texts, false).includes("already recorded"));
  assert.ok(buildSaveConventionResult(null, false, [], false).includes("empty"));
  assert.ok(buildSaveConventionResult("Rule X", true, texts, false).includes("for this session only"));
});

test("buildSaveConventionResult includes the full current list", () => {
  const text = buildSaveConventionResult("Rule X", true, ["Previous rule", "Rule X"], true);
  assert.ok(text.includes("1. Previous rule"));
  assert.ok(text.includes("2. Rule X"));
});

test("buildSaveConventionResult clarifies that the convention is not shared with the team", () => {
  const text = buildSaveConventionResult("Rule X", true, ["Rule X"], true);
  assert.ok(text.includes("local Engram"));
  assert.ok(text.includes("NOT automatically shared"));
});

test("buildPersonaStatusResult lists role, preferences, and conventions", () => {
  const text = buildPersonaStatusResult(
    "architect",
    { language: "es", verbosity: "concise" },
    { conventions: [{ text: "Commits in English", saved_at: "today" }] },
    true
  );
  assert.ok(text.includes("Persona plugin"));
  assert.ok(text.includes("architect (Software Architect)"));
  assert.ok(text.includes("Preferred reply language: es"));
  assert.ok(text.includes("1. Commits in English"));
  assert.ok(!text.includes("Warning: Engram did not respond"));
});

test("every plugin reply demands the 🎭 prefix from the model", () => {
  const outputs = [
    buildRoleAnnouncement("developer"),
    buildSaveRoleResult("developer", true, "ctx", true),
    buildSaveRoleResult("developer", true, "ctx", false),
    buildSaveRoleResult("developer", false, "ctx", false),
    buildSavePreferencesResult({ language: "en" }, true),
    buildSavePreferencesResult({ language: "en" }, false),
    buildSavePreferencesResult({}, true),
    buildSaveConventionResult("Rule X", true, ["Rule X"], true),
    buildSaveConventionResult("Rule X", true, ["Rule X"], false),
    buildSaveConventionResult("Rule X", false, ["Rule X"], false),
    buildSaveConventionResult(null, false, [], false),
    buildPersonaStatusResult(null, {}, { conventions: [] }, true),
  ];
  for (const output of outputs) {
    assert.ok(output.includes(PERSONA_PREFIX), `missing prefix in: ${output.slice(0, 80)}...`);
  }
});

test("every model-facing prompt states the language-matching rule", () => {
  const outputs = [
    BOOTSTRAP_PROMPT,
    buildRoleAnnouncement("developer"),
    buildSaveRoleResult("developer", true, "ctx", true),
    buildSaveRoleResult("developer", true, "ctx", false),
    buildSaveRoleResult("developer", false, "ctx", false),
    buildSavePreferencesResult({ language: "en" }, true),
    buildSavePreferencesResult({ language: "en" }, false),
    buildSavePreferencesResult({}, true),
    buildSaveConventionResult("Rule X", true, ["Rule X"], true),
    buildSaveConventionResult("Rule X", true, ["Rule X"], false),
    buildSaveConventionResult("Rule X", false, ["Rule X"], false),
    buildSaveConventionResult(null, false, [], false),
    buildPersonaStatusResult(null, {}, { conventions: [] }, true),
  ];
  for (const output of outputs) {
    assert.ok(output.includes(LANGUAGE_INSTRUCTION), `missing language rule in: ${output.slice(0, 80)}...`);
  }
});

test("buildPersonaStatusResult distinguishes empty state from Engram being down", () => {
  const empty = buildPersonaStatusResult(null, {}, { conventions: [] }, true);
  assert.ok(empty.includes("Active role: none recorded"));
  assert.ok(empty.includes("Communication preferences: none recorded"));
  assert.ok(empty.includes("Conventions for this project: none recorded"));

  const degraded = buildPersonaStatusResult(null, {}, { conventions: [] }, false);
  assert.ok(degraded.includes("Warning: Engram did not respond"));
});
