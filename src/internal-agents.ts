// Recognizes OpenCode's own internal agents so the persona context is never
// injected into their system prompt.
//
// OpenCode builds the system prompt as an array whose FIRST entry is the
// calling agent's own prompt. Its internal agents (the ones that summarize or
// label a conversation rather than talk to the user) each start with a fixed
// sentence, so matching the opening of system[0] identifies them without any
// public API for it.
//
// This matters most for the title generator: it also skips user messages
// whose parts are all synthetic, which is why the persona block used to end
// up as the session title.
//
// If upstream rewords one of these prompts the check simply stops matching
// and that agent receives the context again - the previous behavior, never a
// broken request.
export const INTERNAL_AGENT_PROMPT_PREFIXES = [
  "You are a title generator.", // session title agent
  "You are a context summarization agent.", // compaction agent
  "Summarize what was done in this conversation.", // summary agent
] as const;

/** True when the system prompt belongs to one of OpenCode's internal agents. */
export function isInternalAgentRequest(system: string[]): boolean {
  const agentPrompt = system[0];
  if (typeof agentPrompt !== "string" || agentPrompt === "") return false;
  return INTERNAL_AGENT_PROMPT_PREFIXES.some((prefix) => agentPrompt.startsWith(prefix));
}
