# Installing the Persona plugin for OpenCode

Persona detects each user's professional role (developer, architect, analyst, or QA) the first time they open a session, saves it in Engram (once per user and machine), and from then on automatically loads that role's instructions in every OpenCode session.

Besides the role, Persona persists in Engram the user's **communication preferences** (reply language and level of detail, personal scope) and the **project's working conventions** (project scope), and injects all of them at the start of every session. Just say them in the chat: "always reply in English", "be more brief", "commits in this repo are written in English".

> **Important:** Engram is a local, per-user, per-machine database. Everything Persona saves — role, preferences, and also the project conventions — belongs to each user: conventions are NOT automatically shared with the rest of the team; each member records their own.

The plugin's prompts are written in English, but the assistant always replies in the language the user writes in; a saved language preference takes precedence over that mirroring.

## Prerequisites

- [ ] **OpenCode** installed (CLI or desktop app).
- [ ] **Engram** installed and reachable on the PATH. The plugin launches `engram mcp` as a subprocess; check it with `which engram` (macOS/Linux) or `where engram` (Windows). See the [Engram repository](https://github.com/Gentleman-Programming/engram).

Node.js and npm are **not** required: the plugin is distributed as the npm package `opencode-persona`, and OpenCode downloads and installs it automatically with its bundled Bun.

## Installation

1. **Add the plugin to your project's `opencode.json`** (create the file in the project root if it does not exist):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-persona"]
   }
   ```

   OpenCode installs the package automatically the next time it starts in that project. To pin an exact version (recommended for teams, so everyone runs the same one):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-persona@2.0.0"]
   }
   ```

   > If your project already has an `opencode.json` with a `plugin` array, just append `"opencode-persona"` to it.

2. **Create the role instructions folder** in your project by copying the `templates/user-roles/` folder shipped with this repository (it is also included in the npm package), then adapt each file to how you want the roles to behave in that project:

   ```bash
   # from your project root
   cp -r <path-to-a-clone-of-this-repo>/templates/user-roles harness/user-roles
   ```

   One file per role, in the project root:

   | Role | File |
   |------|------|
   | Developer | `harness/user-roles/DEV.md` |
   | Software Architect | `harness/user-roles/ARQ.md` |
   | Analyst | `harness/user-roles/BA.md` |
   | QA | `harness/user-roles/QA.md` |

   `_TEMPLATE.md` documents the expected structure; the plugin only loads the four files above.

3. **Keep the plugin's local runtime files out of version control**: at runtime the plugin writes `.opencode/persona.log` and `.opencode/.persona-cache.json` inside your project (creating the `.opencode/` folder if it does not exist). Add both paths to your project's `.gitignore`.

4. **Open OpenCode in the root of your project.**

## Where the plugin lives, updating, and uninstalling

- **Where it lives**: OpenCode installs plugin packages with its bundled Bun into its own cache (`~/.cache/opencode/`), not into your project. Your project only carries the one-line `plugin` entry.
- **Updating**: if you pinned a version, change the pin (e.g. `"opencode-persona@2.1.0"`) and restart OpenCode. If you did not pin, OpenCode resolves the latest version when it first installs the plugin and then reuses its cached copy; pinning a newer version is the reliable way to force an update.
- **Uninstalling**: remove the `"opencode-persona"` entry from the `plugin` array. Optionally delete the cached copy under `~/.cache/opencode/` and the `.opencode/persona.log` / `.opencode/.persona-cache.json` files from your project.

## Local development (contributors)

To run the plugin from a local checkout instead of npm:

```bash
git clone https://github.com/RuloGB/opencode-persona.git persona
cd persona
npm install
npm run build
```

Then point your test project's `opencode.json` at the built entry file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/persona/dist/index.js"]
}
```

Rebuild (`npm run build`) after every source change. This repository also dogfoods the plugin directly: opening OpenCode at the repo root loads `.opencode/plugin/persona.ts`, a shim that re-exports `src/index.ts` (run `npm install` at the root first).

## Verification

In the first session, the plugin introduces itself, asks for the user's role (options 1-4), and saves it on answer; the confirmation also offers the optional configuration (language, level of detail, and project conventions) with example phrases to do it right then or in any future session. In later sessions, the assistant's reply starts with the active-role announcement:

```
🎭 Persona plugin: active role — Developer.
```

All plugin activity is logged to `.opencode/persona.log` in your project (or `~/.persona/persona.log` if the project is not writable); check it if something does not behave as expected.

Optional code verification (from a clone of this repository):

```bash
npm install
npm run typecheck && npm test
```

The test suite does not need Engram installed: it uses a fake MCP server included in `test/helpers/` and never touches your real database.

## Behavior details

| Topic | Behavior |
|-------|----------|
| Visual marker | Every reply generated by the plugin (role announcement, save confirmations, status) starts with `🎭 Persona plugin:`, to tell it apart at a glance from the assistant's normal replies. |
| Persistence | The role is saved in Engram with personal scope: once per user and machine, shared across projects. |
| Role change | Ask in the chat "change my role to QA" (or the one that applies); the plugin updates the saved role without duplicating it. |
| Preferences | "Always reply in English" or "be more brief" are saved (personal scope) and apply in all your sessions, in any project. Each field updates separately. |
| Reply language | The assistant mirrors the language you write in; a saved language preference takes precedence over the mirroring. |
| Project conventions | "Commits in this repo are written in English" is saved with project scope (maximum 20, no duplicates) and injected at the start of each of **your** sessions in that project. It lives in your local Engram: it is not automatically shared with other people. |
| Querying what is recorded | Ask "what do I have recorded in Persona?" (role, preferences, or conventions); the assistant queries Engram with the `get_persona_status` tool and answers with the actual list, not with repository documents. |
| Without Engram | The plugin degrades to default behavior without blocking the session; the role will be asked again once Engram is available. A hung `engram mcp` is cut off by a timeout (8 s). |
| Missing role file | If the role's `.md` file is missing from `harness/user-roles/`, the assistant runs with its default behavior and says so. |
| Subagent sessions | Injection only happens in main sessions; subagent sessions are ignored. |
| Local cache | `.opencode/.persona-cache.json` stores local Engram ids. It is per machine and must not be versioned. |
| Diagnostics | Everything is logged to `.opencode/persona.log` (or `~/.persona/persona.log` if the project is not writable). |

## Troubleshooting

| Symptom | Probable cause | Action |
|---------|----------------|--------|
| The plugin never activates | The `plugin` entry is missing or misspelled, or the first auto-install failed | Check `opencode.json` (valid JSON, `"plugin": ["opencode-persona"]`) and that the machine had network access the first time OpenCode started with the entry; then restart OpenCode |
| The role is not asked in the first session | Engram is not on the PATH that OpenCode inherits | Check `engram` on the PATH and review `.opencode/persona.log`; the plugin degrades gracefully and asks for the role once Engram is reachable |
| The role is announced but no instructions apply | The role's `.md` file is missing | Create the matching file in `harness/user-roles/`; until then the assistant notes it and uses its default behavior |
| The role is asked again | Saving to Engram failed in the previous session | Review `persona.log`; with Engram available, the next save persists |
| No injection appears in a session | It is a subagent session | Expected: Persona ignores subagent sessions and only injects in main sessions |
| An old version keeps running after publishing a new one | OpenCode reuses its cached copy | Pin the new version in `opencode.json` (e.g. `"opencode-persona@2.1.0"`) and restart OpenCode |
