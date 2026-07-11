# Persona — Project technical guide

Project containing the **Persona** plugin for OpenCode and the role file
templates. This guide is technical only; the role logic lives in the plugin,
not here.

## Structure

The repo root is the npm package `opencode-persona`; consumers enable it with
`"plugin": ["opencode-persona"]` in their project's `opencode.json`.

```
src/
├── index.ts          ← OpenCode plugin entry (hooks + tools save_user_role,
│                       save_user_preferences, save_project_convention and
│                       get_persona_status); named export + default alias
├── conventions.ts    ← team-conventions domain (bounded list, dedupe)
├── engram-cache.ts   ← local cache: logical key -> observation id
├── engram-client.ts  ← Engram MCP client (`engram mcp` subprocess, timeouts)
├── logger.ts         ← diagnostics log -> .opencode/persona.log
├── preferences.ts    ← user-preferences domain (language, detail)
├── prompts.ts        ← model-facing texts (bootstrap, announcement, tools)
└── roles.ts          ← roles domain: catalog and instruction loading
test/
├── helpers/
│   ├── fake-engram.ts ← fake MCP server that mimics `engram mcp` (fixture)
│   └── tmp.ts         ← temporary directories for tests
└── *.test.ts          ← node:test suite (unit + plugin integration)
.opencode/
└── plugin/persona.ts ← dev-only shim re-exporting src/index.ts so this repo
                        dogfoods the plugin; needs `npm install` at the root
templates/
└── user-roles/       ← per-role instruction templates (DEV.md, ARQ.md,
                        BA.md, QA.md) and _TEMPLATE.md, the shared role template
harness/
└── user-roles/       ← git-ignored: each consuming project creates this
                        folder (e.g. from templates/user-roles/) and owns it
docs/INSTALL.md       ← consumer installation guide (opencode.json flow)
dist/                 ← built ESM output (`npm run build`), git-ignored; npm
                        publishes it together with templates/
package.json          ← npm package (main/types -> dist, files whitelist)
tsconfig.json         ← dev/test typecheck (noEmit, NodeNext)
tsconfig.build.json   ← emits dist/ (rewriteRelativeImportExtensions)
scripts/rewrite-dts-extensions.mjs ← post-build: ".ts" -> ".js" in dist/*.d.ts
README.md             ← public plugin documentation
```

## Data Persona stores in Engram

| Entry (`topic_key`) | Scope | Content | Tool that writes it |
|---------------------|-------|---------|---------------------|
| `persona/user-role` | personal | User's role (developer/architect/analyst/qa) | `save_user_role` (also for role changes) |
| `persona/user-preferences` | personal | Reply language and level of detail | `save_user_preferences` (merge: what is not provided is kept) |
| `persona/project-conventions` | project | Project working rules (max. 20, no duplicates) | `save_project_convention` |

The Engram scope ALWAYS delimits within the user's local database, never
across people: "personal" travels with the user across projects, "project"
stays bound to the current project. Conventions are NOT shared with the rest
of the team (each member has their own Engram). Careful when renaming an
entry's `topicKey` or `title`: reads verify both, so data already saved under
the old name is orphaned (done knowingly during testing with
`persona/team-conventions` → `persona/project-conventions`, and again before
the first public release when `title`/`searchQuery` moved from Spanish to English).

All three are injected on the first `chat.message` of each session: role +
preferences + conventions, with the kickoff announcement always last.
Preferences or conventions failures degrade separately and never prevent
injecting the role; a failure reading the role is retried on the next message.

The read-only tool `get_persona_status` queries the three entries live. The
session announcement instructs the model to use it when the user asks what
they have recorded in Persona: the injected blocks are labeled as coming from
the plugin, but without the tool the model tended to answer those questions
from AGENTS.md (Persona's conventions are not the repo's technical
conventions).

## Important OpenCode constraints (learned through failures)

- OpenCode tries to load EVERY `.ts` file inside a project's
  `.opencode/plugin/` as a plugin (it invokes their exports as functions).
  In this repo that folder holds only the dev shim; auxiliary modules live in
  `src/` — putting them in `.opencode/plugin/` breaks loading of all plugins
  with "Class constructor ... cannot be invoked without 'new'".
- OpenCode initializes every function export of a plugin module and dedupes
  them by reference. `src/index.ts` exports `Persona` and a `default` alias of
  the SAME value; exporting a distinct value as default would load the plugin
  twice, and any non-function export makes the loader throw.
- The `session.created` event only fires when a session is CREATED: resumed
  sessions (e.g. reopening the desktop app) never emit it. That is why the
  role injection happens in the `chat.message` hook (first user message of
  each session, deduplicated per process), appending a `synthetic: true` part
  to the message itself.
- NEVER `await client.tui.*` during plugin initialization: the TUI is not
  connected yet and the await blocks OpenCode's entire startup (black screen).
  Toasts are always fire-and-forget with `.catch()`.
- The CLI runs plugins with Bun, but the desktop app runs them with Node
  (type-stripping): relative imports MUST carry an explicit `.ts` extension
  (`./logger.ts`), or the dogfood shim fails only in the desktop app.
  `allowImportingTsExtensions` is enabled in tsconfig for this reason, and
  `erasableSyntaxOnly` makes tsc reject non-erasable TS syntax that Node
  cannot execute (enums, parameter properties, namespaces). The published
  build keeps working because `rewriteRelativeImportExtensions` turns them
  into `.js` in `dist/*.js`; tsc does NOT rewrite declaration output, so
  `scripts/rewrite-dts-extensions.mjs` patches `dist/*.d.ts` after `tsc`.
- Do not use `console.error`/`console.log` in the plugin: it paints over the
  TUI and corrupts the screen. Diagnostics only via `.opencode/persona.log`.

## Conventions

- Strict TypeScript; the plugin must not throw exceptions toward OpenCode
  (fail-safe on every path: try/catch + degrade to default behavior).
- Node imports with the `node:` prefix (`node:fs`, `node:path`, `node:os`).
- Comments and model-facing texts in English. Prompts instruct the model to
  reply in the user's language, with a saved language preference taking
  precedence; keep that instruction when editing prompts.

## Verification

```
npm install && npm run typecheck && npm test
```

The suite (`node:test`, 55 tests) does not touch the real Engram database:
the integration tests launch `test/helpers/fake-engram.ts`, a fake MCP server
that replicates the `engram mcp` response format over a temporary JSON file.
Operational details:

- `npm test` uses `--test-force-exit` and an explicit glob (`test/*.test.ts`):
  `node --test <directory>` does not work on Node 22, and without force-exit
  the tests' MCP subprocesses keep the runner alive.
- `PERSONA_ENGRAM_CMD` and `PERSONA_ENGRAM_ARGS` (JSON array) allow replacing
  the `engram` binary and its arguments: the plugin tests use them and they
  also serve diagnostics with binaries in non-standard paths.
- The Engram connection has a timeout (8 s by default): a hung `engram mcp`
  degrades to default behavior instead of blocking the injection forever.

Build and packaging: `npm run build` emits `dist/` (ESM `.js` + `.d.ts`);
`npm pack --dry-run` must list only `dist/`, `templates/`, `README.md`,
`LICENSE`, and `package.json` (the `files` whitelist governs the tarball).
`prepublishOnly` chains typecheck + tests + build before any publish.

The manual test is still opening OpenCode at the repo root: it loads the
dogfood shim `.opencode/plugin/persona.ts` (a re-export of `src/index.ts`)
whose imports resolve against the root `node_modules/`, so run `npm install`
first. It requires the `engram` binary on the PATH (the plugin starts it as
a subprocess via `engram mcp`); without it, the plugin degrades to default
behavior without blocking the session.

`.opencode/.persona-cache.json` is a local per-machine cache (ids from
Engram's local SQLite database) — it is in `.gitignore` and is never
versioned.
