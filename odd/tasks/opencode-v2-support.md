# OpenCode v2 support

## Objective

Make `opencode-persona` load and work on OpenCode v2 (`@opencode/cli` 2.x) while
keeping it working on OpenCode v1 (>= 1.3.4), from a single published module.

## Problem

OpenCode v2 rejects the plugin at load time:

```
PluginModule.LoadError: Plugin must export a default definition with an id and
an effect or setup function. (cause: SchemaError(Expected object at ["default"]))
```

`src/index.ts` exports a v1 `Plugin` function as `default`. The v2 loader
(`packages/core/src/plugin/module.ts:60-73` on the `v2` branch) decodes
`default` as `{ id: string, effect: fn } | { id: string, setup: fn }`.

## Why

v2 is the stable OpenCode line (`@opencode/cli` / `@opencode/plugin` latest =
2.0.24). v1 users must keep working, so the plugin has to serve both.

## Verified facts (research, 2026-10-06)

- v1 loader (v1.18.34, `packages/opencode/src/plugin/index.ts:114-125`,
  `shared.ts:272-304`): when `default` is `{ id?, server }` it runs only
  `server`, ignores other named exports and does not reject unknown keys. This
  module shape exists since v1.3.4; older v1 calls every export as a function.
- v2 loader: effect Schema with default `onExcessProperty: "ignore"`, so an
  extra `server` key is dropped; `setup` is wrapped with `fromPromise`
  automatically. Named exports are irrelevant. Both loaders resolve the same
  entrypoint, so it must be one module.
- v2 hook mapping (`@opencode/plugin` 2.0.24 typings):
  - `chat.message` -> `ctx.session.hook("prompt", e)` (`e.sessionID`)
  - `experimental.chat.system.transform` -> `ctx.session.hook("context", e)`,
    push `{ type: "text", text }` into `e.system`. Fires only for primary
    agent-loop requests (title/compaction/generate have their own hooks), so
    the `internal-agents.ts` filter is not needed on v2.
  - `tool` -> `ctx.tool.transform(editor => editor.add({ name, description,
    input, execute }))`; `input` accepts zod (`z.object(args)`); result is
    `{ content: string }`.
  - `client.session.get` -> `ctx.session.get(...)`, subagent = has `parentID`.
  - `directory`/`worktree` -> `ctx.location.directory` /
    `ctx.location.project.directory`.
  - `experimental.text.complete` -> no equivalent; `client.tui.showToast` ->
    not available to server plugins.
- `define()` in the v2 SDK is an identity function: no runtime dependency on
  the v2 SDK is needed; minimal structural types are enough.

## Decisions

- Support v1 + v2 in one package (user decision).
- v2 shows no role announcement banner and no update notice (user decision:
  no synthetic message). The role context is still injected.
- Raise `peerDependencies["@opencode-ai/plugin"]` floor to `>=1.3.4`.
- No commits without explicit user authorization (user rule overrides ODD
  work-unit commits).

## Scope

In: module shape, shared core extraction, v2 adapter, tests, docs
(README, docs/INSTALL.md, AGENTS.md), package metadata.
Out: v2 banner/update notice, TUI plugin, publishing a release.

## Delivery

Strategy: `ask-on-risk`. Forecast ~500-700 authored changed lines (refactor +
adapter + tests + docs); chain strategy to be asked before any PR.

## Tasks

- [x] T1 Extract runtime-agnostic core from `src/index.ts` (Engram, context
      composition, tool bodies, session state) so v1 and v2 adapters share it.
      No behavior change on v1. Route: delegated writer (2+ non-trivial files).
- [x] T2 v2 adapter: `setup(ctx)` wiring `prompt` + `context` hooks, the four
      tools via `tool.transform`, subagent skip via `session.get`. Minimal
      structural types; no banner. Session cleanup only if the v2 event name
      for session deletion is verified. Tests with a fake v2 context.
      Route: delegated writer.
- [x] T3 Module shape `export default { id: "opencode-persona", server, setup }`
      plus named `Persona`; peer dependency `>=1.3.4`; test the default shape
      against both loader contracts; docs (README, INSTALL, AGENTS.md).
      Route: delegated writer.

- [x] T4 Align with the official v2 migration guide
      (https://opencode.ai/v2/docs/build/plugins/migrate-v1): v1 floor
      `>=1.18.29`; v2 tool `input` as plain JSON Schema; v2 `plugins` config
      key and local plugin discovery in docs. Route: delegated writer
      (rationale: the guide was reviewed after T1-T3).

### Implementation notes (T1-T3, 2026-10-06)

- T1: `src/core.ts` (`createPersonaCore(cwd)`: Engram, context composition,
  `claimSession`/`composeContext`/`contextFor`/`forgetSession`, four tool
  bodies with zod raw-shape args). `src/plugin-v1.ts` holds the unchanged v1
  hooks (`Persona`) on top of it; banners, toast and update check stay v1-only.
- T2: `src/plugin-v2.ts` `setup(ctx)` with hand-written structural types.
  Verified in `oc-v2`: `ctx.session.get({ sessionID })` resolves the session
  info directly (`core/src/plugin/warming.ts:60`); hooks register through
  `ctx.session.hook(name, cb)` returning `Promise<Registration>`
  (`plugin/src/promise/adapter.ts:579-584`); `system` parts are
  `{ type: "text", text }` (`ai/src/schema/messages.ts:21`).
- T2 session cleanup: DONE. `session.deleted` with `data.sessionID` is a v2
  durable event (`schema/src/session-event.ts:177-184`, `Base = { sessionID }`);
  the promise adapter exposes `ctx.event.subscribe({ signal })` as an
  AsyncIterable of encoded events (`adapter.ts:324-332`). `setup` consumes it
  and returns a cleanup that aborts the subscription.
- Deviation (T2): v2 tools default to Code Mode (`core/src/tool.ts:233-235`:
  only `options.codemode === false` tools are direct). Prompts name the tools,
  so they are added with `options: { codemode: false }`, like core's own
  `read`/`glob`/`question` tools.
- T3 runtime dependency choice: `src/` keeps only `import type` from
  `@opencode-ai/plugin` (test-enforced); tool args use `zod` directly, added
  as `dependencies.zod: ^4.4.3` (already installed transitively at 4.4.3);
  peer floor `>=1.3.4` with `peerDependenciesMeta` optional so v2 installs do
  not pull the v1 SDK. The v1 adapter passes plain tool objects (v1 `tool()`
  is identity) with a type-only cast: the SDK typings pin a nested zod 4.1
  whose `_zod.version.minor` literal differs from 4.4.
- T3 shim: `.opencode/plugin/persona.ts` now re-exports the default object so
  the repo dogfoods on v1 >= 1.3.4 and v2.
- v2 config: v2 still reads the v1 `plugin` key
  (`core/src/config/normalize.ts:185-190`), documented in README/INSTALL.

### Implementation notes (T4, 2026-10-06)

- Version floor: peer `>=1.18.29` and every doc/comment/test mention moved
  from 1.3.4 to 1.18.29 (user decision: follow the guide's claim that v1
  object entrypoints are supported from 1.18.29; our reading found
  `readV1Plugin` unchanged since 1.3.4, but older releases cannot be tested).
  Docs call older v1 "unsupported", not "fails". The 1.3.4 mentions earlier in
  this document are historical rationale.
- JSON Schema input, verified in `oc-v2` `core/src/tool/runtime.ts`: a raw
  JSON Schema `input` is sent to the provider as-is (`inputJsonSchema`) and
  validated by converting it to an Effect codec (`jsonSchema()`, draft chosen
  from `$schema`, default 2020-12). Exercised that exact conversion with the
  pinned `effect@4.0.0-rc.112` on our four schemas: valid inputs pass, bad
  enum / missing required / bad optional enum fail, with or without
  `$schema`. So v2 validates itself and `execute` does not re-parse; `$schema`
  is kept (harmless, identical to what v2 derived from zod in T2).
- Deviation (T4): zod 4.4's `z.toJSONSchema` result carries a non-enumerable
  `~standard` property, which v2's `"~standard" in schema` check would treat
  as a Standard Schema. The adapter wraps it in `structuredClone` to get plain
  JSON. Options `{ target: "draft-2020-12", io: "input" }` match what v2 used
  for zod (no `additionalProperties: false`). Definitions are built once,
  before the synchronous, side-effect-free `tool.transform` callback.
- Docs: v2 `plugins` key shown as recommended (README, INSTALL), noting v2
  normalizes the v1 `plugin` key (`core/src/config/normalize.ts:185-190`);
  local discovery in `.opencode/plugin/` and `.opencode/plugins/`
  (`core/src/plugin/source-directory.ts:7`) noted where the dogfood shim is
  described (AGENTS.md, INSTALL, shim comment). Shim not moved.
- RED/GREEN: the tightened tool-registration tests in `test/plugin-v2.test.ts`
  failed 2/7 before the change (input was a zod object; then the leaked
  `~standard`), 7/7 after.

## Acceptance criteria

- `npm run typecheck`, `npm test` and `npm run build` pass.
- `dist/index.js` default export is an object with string `id`, function
  `server` and function `setup`, and no `effect` or `tui` keys.
- v1 behavior unchanged (existing suite green).
- v2 adapter injects the composed context into `system` for primary requests
  and registers the four tools.

## Checks

`npm install && npm run typecheck && npm test && npm run build`

## Progress

- 2026-10-06: research done, branch `feature/opencode-v2-support` created.
- 2026-10-06: T1-T3 implemented by one delegated writer (route: delegated
  direct; trigger: 2+ non-trivial files). RED observed first: the 7 new tests
  in `test/plugin-v2.test.ts` failed 7/7 before implementation, then GREEN.
  No commit (user rule). Native review not run (no commit candidate).
- Verification evidence (observed):
  - `npm install`: exit 0
  - `npm run typecheck`: exit 0
  - `npm test`: 122 tests, 122 pass, 0 fail (115 existing + 7 new)
  - `npm run build`: exit 0
  - default-shape check on `dist/index.js`: `object string function function
    false false function`
  - `npm pack --dry-run`: only `LICENSE`, `README.md`, `package.json`,
    `dist/*`, `templates/user-roles/*`
- Engram mirror `odd/opencode-v2-support/tasks`: PENDING (Engram MCP failed to
  connect this session).

## Next step

Manual dogfood on a real OpenCode v2 install (prompt + context injection,
tools callable directly, no Code Mode detour), then the user decides on
commits and the delivery chain.
