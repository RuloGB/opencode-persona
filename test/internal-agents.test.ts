// Unit tests for the internal-agent guard used by the system prompt
// injection: OpenCode's own agents (title, compaction, summary) must never
// receive the persona context.
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERNAL_AGENT_PROMPT_PREFIXES, isInternalAgentRequest } from "../src/internal-agents.ts";

test("every known internal agent prompt opening is detected", () => {
  for (const prefix of INTERNAL_AGENT_PROMPT_PREFIXES) {
    assert.equal(isInternalAgentRequest([prefix]), true, prefix);
    assert.equal(
      isInternalAgentRequest([`${prefix} Follow these extra instructions.`, "another block"]),
      true,
      `${prefix} (with a tail)`
    );
  }
});

test("a normal agent prompt is not treated as internal", () => {
  assert.equal(isInternalAgentRequest(["You are opencode, an interactive CLI coding agent."]), false);
});

test("an empty system array is not treated as internal", () => {
  assert.equal(isInternalAgentRequest([]), false);
});

test("a matching prefix outside the first block is ignored", () => {
  // Only system[0] carries the calling agent's own prompt; a later block is
  // user/plugin content and must not disable the injection.
  assert.equal(
    isInternalAgentRequest(["You are opencode.", "You are a title generator."]),
    false
  );
});

test("a non-string or empty first block degrades to not internal", () => {
  assert.equal(isInternalAgentRequest([""]), false);
  assert.equal(isInternalAgentRequest([undefined as unknown as string]), false);
});
