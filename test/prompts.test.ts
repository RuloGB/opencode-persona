import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BOOTSTRAP_PROMPT,
  LANGUAGE_INSTRUCTION,
  PERSONA_PREFIX,
  SAVE_CONVENTION_TOOL_DESCRIPTION,
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

test("the role announcement is scoped to the first reply of the session only", () => {
  const text = buildRoleAnnouncement("developer");
  assert.ok(text.includes("ONLY to your very first reply"));
  assert.ok(text.includes("do NOT start with that line"));
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

test("the save-convention description explains both scopes so the model picks correctly", () => {
  assert.ok(SAVE_CONVENTION_TOOL_DESCRIPTION.includes("'project'"));
  assert.ok(SAVE_CONVENTION_TOOL_DESCRIPTION.includes("'global'"));
  assert.ok(SAVE_CONVENTION_TOOL_DESCRIPTION.includes("default"));
});

test("buildSaveConventionResult covers added, duplicate, and empty", () => {
  const texts = ["Previous rule", "Rule X"];
  assert.ok(buildSaveConventionResult("Rule X", true, texts, true, "project").includes("Convention saved"));
  assert.ok(buildSaveConventionResult("Rule X", false, texts, false, "project").includes("already recorded"));
  assert.ok(buildSaveConventionResult(null, false, [], false, "project").includes("empty"));
  assert.ok(buildSaveConventionResult("Rule X", true, texts, false, "project").includes("for this session only"));
});

test("buildSaveConventionResult states the scope that was saved", () => {
  const project = buildSaveConventionResult("Rule X", true, ["Rule X"], true, "project");
  assert.ok(project.includes("project scope"));
  assert.ok(project.includes("this project"));

  const global = buildSaveConventionResult("Rule X", true, ["Rule X"], true, "global");
  assert.ok(global.includes("global scope"));
  assert.ok(global.includes("ALL of their projects"));

  const globalDuplicate = buildSaveConventionResult("Rule X", false, ["Rule X"], false, "global");
  assert.ok(globalDuplicate.includes("already recorded for all of the user's projects"));
});

test("buildSaveConventionResult includes the full current list", () => {
  const text = buildSaveConventionResult("Rule X", true, ["Previous rule", "Rule X"], true, "project");
  assert.ok(text.includes("1. Previous rule"));
  assert.ok(text.includes("2. Rule X"));
});

test("buildSaveConventionResult clarifies that the convention is not shared with the team", () => {
  for (const scope of ["project", "global"] as const) {
    const text = buildSaveConventionResult("Rule X", true, ["Rule X"], true, scope);
    assert.ok(text.includes("local Engram"));
    assert.ok(text.includes("NOT automatically shared"));
  }
});

test("buildPersonaStatusResult lists role, preferences, and conventions", () => {
  const text = buildPersonaStatusResult(
    "architect",
    { language: "es", verbosity: "concise" },
    { conventions: [] },
    { conventions: [{ text: "Commits in English", saved_at: "today" }] },
    true
  );
  assert.ok(text.includes("Persona plugin"));
  assert.ok(text.includes("architect (Software Architect)"));
  assert.ok(text.includes("Preferred reply language: es"));
  assert.ok(text.includes("1. Commits in English"));
  assert.ok(text.includes("Global conventions: none recorded"));
  assert.ok(!text.includes("Warning: Engram did not respond"));
});

test("buildPersonaStatusResult lists global and project conventions separately", () => {
  const text = buildPersonaStatusResult(
    null,
    {},
    { conventions: [{ text: "Never use any", saved_at: "today" }] },
    { conventions: [{ text: "Commits in English", saved_at: "today" }] },
    true
  );
  assert.ok(text.includes("Global conventions (1"));
  assert.ok(text.includes("Conventions for this project (1"));
  assert.ok(text.indexOf("Never use any") < text.indexOf("Commits in English"), "the global block comes first");
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
    buildSaveConventionResult("Rule X", true, ["Rule X"], true, "project"),
    buildSaveConventionResult("Rule X", true, ["Rule X"], true, "global"),
    buildSaveConventionResult("Rule X", true, ["Rule X"], false, "project"),
    buildSaveConventionResult("Rule X", false, ["Rule X"], false, "global"),
    buildSaveConventionResult(null, false, [], false, "project"),
    buildPersonaStatusResult(null, {}, { conventions: [] }, { conventions: [] }, true),
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
    buildSaveConventionResult("Rule X", true, ["Rule X"], true, "project"),
    buildSaveConventionResult("Rule X", true, ["Rule X"], true, "global"),
    buildSaveConventionResult("Rule X", true, ["Rule X"], false, "project"),
    buildSaveConventionResult("Rule X", false, ["Rule X"], false, "global"),
    buildSaveConventionResult(null, false, [], false, "project"),
    buildPersonaStatusResult(null, {}, { conventions: [] }, { conventions: [] }, true),
  ];
  for (const output of outputs) {
    assert.ok(output.includes(LANGUAGE_INSTRUCTION), `missing language rule in: ${output.slice(0, 80)}...`);
  }
});

test("buildPersonaStatusResult distinguishes empty state from Engram being down", () => {
  const empty = buildPersonaStatusResult(null, {}, { conventions: [] }, { conventions: [] }, true);
  assert.ok(empty.includes("Active role: none recorded"));
  assert.ok(empty.includes("Communication preferences: none recorded"));
  assert.ok(empty.includes("Global conventions: none recorded"));
  assert.ok(empty.includes("Conventions for this project: none recorded"));

  const degraded = buildPersonaStatusResult(null, {}, { conventions: [] }, { conventions: [] }, false);
  assert.ok(degraded.includes("Warning: Engram did not respond"));
});
