// OpenCode v2 adapter: maps the shared core onto the v2 promise plugin API
// (`setup(ctx)`). The types below are hand-written structural subsets of
// @opencode/plugin 2.x (`Context`, `SessionHooks`, `ToolEditor`): v2's
// `define()` is an identity function, so no runtime or dev dependency on the
// v2 SDK is needed. v2 has no equivalent of v1's experimental.text.complete
// or TUI toasts, so it shows no role announcement and no update notice.
import { z } from "zod";
import { createPersonaCore, type PersonaTool } from "./core.ts";

interface Registration {
  readonly dispose: () => Promise<void>;
}

interface V2SystemPart {
  type: "text";
  text: string;
}

interface V2ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  readonly options?: { readonly codemode?: boolean };
  readonly execute: (input: never, context: unknown) => Promise<{ content: string }>;
}

export interface V2Context {
  readonly location: { readonly directory: string };
  readonly session: {
    get(input: { sessionID: string }): Promise<{ parentID?: string }>;
    hook(name: "prompt", callback: (event: { readonly sessionID: string }) => Promise<void> | void): Promise<Registration>;
    hook(
      name: "context",
      callback: (event: { readonly sessionID: string; system: V2SystemPart[] }) => Promise<void> | void
    ): Promise<Registration>;
  };
  readonly tool: {
    transform(callback: (editor: { add(tool: V2ToolInfo): void }) => void): Promise<Registration>;
  };
  readonly event: {
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string } }>;
  };
}

export async function setup(ctx: V2Context): Promise<() => void> {
  const core = createPersonaCore(ctx.location.directory);
  const { logger } = core;

  async function isSubagentSession(sessionID: string): Promise<boolean> {
    try {
      return Boolean((await ctx.session.get({ sessionID })).parentID);
    } catch {
      return false;
    }
  }

  // Tool definitions are built once, outside the transform: v2 may replay
  // transforms, so the callback stays synchronous, cheap and side-effect free.
  // `input` is plain JSON Schema (as in the official v1 -> v2 migration guide),
  // generated from the same zod shape v1 uses. The options match what v2
  // itself derives from a zod schema (draft 2020-12, input side, so no
  // `additionalProperties: false`). v2 sends it to the provider as-is and
  // validates each call against it before `execute`, so no second parse here.
  // Codemode is disabled: the prompts tell the model to call the tools by name,
  // as on v1, instead of through v2's Code Mode `execute` tool.
  const toolDefinitions: V2ToolInfo[] = (Object.entries(core.tools) as [string, PersonaTool][]).map(
    ([name, tool]) => ({
      name,
      description: tool.description,
      // structuredClone drops the non-enumerable `~standard` that zod 4.4
      // attaches to the result: v2 detects Standard Schemas with
      // `"~standard" in schema` and would otherwise not treat it as JSON.
      input: structuredClone(z.toJSONSchema(z.object(tool.args), { target: "draft-2020-12", io: "input" })),
      options: { codemode: false },
      execute: async (input: never) => ({ content: await tool.execute(input) }),
    })
  );
  await ctx.tool.transform((editor) => {
    for (const definition of toolDefinitions) editor.add(definition);
  });

  // First prompt of each session: compose the context once (subagent sessions
  // excluded, as on v1).
  await ctx.session.hook("prompt", async ({ sessionID }) => {
    try {
      if (!core.claimSession(sessionID)) return;
      if (await isSubagentSession(sessionID)) {
        logger.log(`session ${sessionID} belongs to a subagent; ignored`);
        return;
      }
      await core.composeContext(sessionID);
    } catch (err) {
      // The plugin must never block the user's prompt.
      logger.error("error in the v2 prompt hook", err);
    }
  });

  // `context` fires only for primary agent-loop requests (title, compaction
  // and generate have their own hooks), so no internal-agent filter is needed.
  await ctx.session.hook("context", (event) => {
    try {
      const context = core.contextFor(event.sessionID);
      if (context) event.system.push({ type: "text", text: context });
    } catch (err) {
      // The plugin must never break a request.
      logger.error("error in the v2 context hook", err);
    }
  });

  // session.deleted evicts the session's state; the subscription ends when
  // OpenCode unloads the plugin and calls the returned cleanup.
  const subscription = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
      if (event.type === "session.deleted" && event.data?.sessionID) core.forgetSession(event.data.sessionID);
    }
  })().catch((err) => {
    if (!subscription.signal.aborted) logger.error("v2 event subscription ended unexpectedly", err);
  });

  return () => subscription.abort();
}
