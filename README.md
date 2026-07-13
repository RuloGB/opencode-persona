<p align="center">
  <img width="1280" height="640" alt="opencode-persona — one project, every role, the right assistant for each teammate" src=".github/social-preview.png" />
</p>

<p align="center">
  <strong>One project. Every role. The right assistant for each teammate.</strong><br>
  <em>On a shared codebase, each person need the AI to work differently. Persona gives every teammate the assistant their role expects — automatically, from the same repo.</em>
</p>

<p align="center">
  <a href="#built-for-teams-one-project-many-roles">Built for teams</a> &bull;
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#requirements">Requirements</a> &bull;
  <a href="#what-persona-does">What it does</a> &bull;
  <a href="#tools">Tools</a> &bull;
  <a href="#data--scope">Data &amp; Scope</a> &bull;
  <a href="#installation">Installation</a> &bull;
  <a href="docs/INSTALL.md">Full docs</a>
</p>

---

## Built for teams: one project, many roles

A real project is not worked by a single kind of person. A **business analyst**, a **developer**, a **software architect** and a **QA engineer** all open OpenCode in the *same* repository, over the *same* code and the *same* documents — but each one needs the assistant to behave in a completely different way.

Take one feature, *"add discount codes at checkout"*:

- The **analyst** needs requirements: user stories and Given/When/Then acceptance criteria, in business language, **no code**.
- The **developer** needs an implementation: the files it touches, the code, the tests, and the technical trade-offs.
- The **architect** needs the decision first: whether it fits the current architecture, the alternatives with their trade-offs, and an ADR to record it.
- The **QA engineer** needs to break it: a test plan of happy, edge, and error cases derived from those acceptance criteria.

Same repo. Same feature. Same `opencode` command. Without Persona, everyone gets the same generic assistant and has to re-explain their role every session. **Persona resolves this** — it loads each teammate's role automatically, so the analyst gets an analyst's assistant and the developer gets a developer's, from the exact same project.

What makes it work is a deliberate split:

- **The role definitions are shared.** How each role behaves *in this project* lives in `harness/user-roles/` (`DEV.md`, `ARQ.md`, `BA.md`, `QA.md`), versioned in the repo. The team agrees on them once and they travel with the code.
- **The role assignment is personal.** Which role *you* are is saved locally, per user and per machine — never shared. Your teammate on the same repo runs as their role; you run as yours.

---

Every reply produced by the plugin opens with the `🎭 Persona plugin:` marker, so you always know when Persona is driving:

```
🎭 Persona plugin: active role — Developer.
```

## Quick Start

> **Before you start:** Persona needs **OpenCode** and **[Engram](https://github.com/Gentleman-Programming/engram)** installed — that's where your role and preferences are stored. See [Requirements](#requirements) below before installing so the first session doesn't fail.

**1. Install the plugin.** Two ways — pick whichever you prefer:

<table>
<tr><th>Option A — Ask the assistant</th><th>Option B — Edit <code>opencode.json</code></th></tr>
<tr valign="top"><td>

Open OpenCode in your project and say:

> Install the `opencode-persona` plugin in this project:
> https://github.com/RuloGB/opencode-persona

The assistant adds the plugin entry **and sets up the `harness/user-roles/` folder** from the templates.

</td><td>

Add the plugin to your project's `opencode.json` (create it in the project root if it doesn't exist):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-persona"]
}
```

</td></tr>
</table>

OpenCode installs the package automatically the next time it starts in that project — no `npm install` required.

**2. Set up the role instructions.** Persona reads one instruction file per role from `harness/user-roles/` (`DEV.md`, `ARQ.md`, `BA.md`, `QA.md`), which you adapt to how each role should behave in this project.

- **Option A** — the assistant typically creates this folder from the templates as part of the install; just review and tweak the files (create it as below if it's missing).
- **Option B** — copy the templates in yourself:

  ```bash
  # from your project root
  cp -r <path-to-a-clone-of-this-repo>/templates/user-roles harness/user-roles
  ```

**3. Open OpenCode in the project.** The first session introduces Persona and asks for your role. Answer once and you're set — every session from then on loads it automatically.

For version pinning, updates, local development, and troubleshooting, see [docs/INSTALL.md](docs/INSTALL.md).

## Requirements

Persona stores everything it learns in **Engram**, so it must be installed **before** you use the plugin — otherwise the first session can't save your role.

- **OpenCode** — CLI or desktop app.
- **Engram** — installed and reachable on the `PATH`. The plugin launches `engram mcp` as a subprocess; verify with `which engram` (macOS/Linux) or `where engram` (Windows). See the [Engram repository](https://github.com/Gentleman-Programming/engram).
- **A `harness/user-roles/` folder** in the project root, one instruction file per role (created in step 2 of the Quick Start).

Node.js and npm are **not** needed to use Persona: OpenCode downloads and installs it with its bundled Bun. They are only required to contribute to this repository.

> If Engram is missing, Persona **does not block your session** — it falls back to the default behavior and asks for your role again once Engram becomes reachable.

## What Persona does

You configure Persona by talking to it. No commands, no config files to hand-edit — just say what you want, and the plugin saves it to your local database and reuses it forever.

```
  FIRST SESSION                 LOCAL DATABASE                EVERY SESSION
  ─────────────                 ──────────────                ─────────────
  You state your role,   ──▶    Stored once, per       ──▶   Role, preferences,
  preferences, and              user:                          and conventions
  conventions by chat           · role (personal)              are injected into
                                · preferences (personal)       every session —
                                · conventions (project/global) automatically
```

| Capability | How you use it | What happens |
|------------|----------------|--------------|
| **Role detection & loading** | Answered once on the first session (Developer, Architect, Analyst, QA) | The role's instructions are injected automatically into every future session. Each project defines its own behavior per role in `harness/user-roles/`, so the same role can act differently across projects. |
| **Hot role switching** | "change my role to QA" | The stored role is updated in place — no duplicates, no repeated onboarding. |
| **Communication preferences** *(personal)* | "always reply in English", "be more brief" | Reply language and level of detail travel with you across every project. Each field updates independently. |
| **Project conventions** *(project)* | "commits in this repo are written in English" | Up to 20 conventions per project, injected only in your sessions inside that project. |
| **Global conventions** *(personal)* | "save as a global convention: never use `any`" | Up to 20 conventions that follow you into every project. A rule recorded in both scopes is injected once, under the project block. |
| **Status query** | "what do I have recorded in Persona?" | The assistant reads back your real role, preferences, and conventions from the local database — not from repo docs. |
| **Language mirroring** | Just write in your language | The assistant always replies in the language you use; a saved language preference takes precedence over mirroring. |

**Built to stay out of the way.** If the local database is down, Persona degrades gracefully instead of blocking the session (hung connections time out at 8 s). If preferences or conventions fail to load, the role is still injected. Subagent sessions are ignored. A missing role file is reported, and the assistant continues with its default behavior. Everything is logged to `~/.persona/persona.log` for diagnostics — the plugin keeps all its runtime files in your user home and writes nothing inside your project.

## Tools

The assistant calls these on its own whenever you express a role, a preference, or a convention — you never invoke them manually.

| Tool | What it does |
|------|--------------|
| `save_user_role` | Saves or updates the user's role (upsert, no duplicates). |
| `save_user_preferences` | Saves the reply language and/or level of detail. |
| `save_convention` | Adds a working convention to the current project (default) or, with global scope, to all of your projects. |
| `get_persona_status` | Returns the role, preferences, and conventions recorded in the local database. |

## Data & Scope

Persona's memory is a **local, per-user, per-machine** database. Nothing it stores is shared between people — each teammate records their own, even on the same repository.

| Data | Scope | Shared across your projects? | Shared with the team? |
|------|-------|------------------------------|------------------------|
| Role | Personal | ✅ Asked once, applies everywhere | ❌ No |
| Preferences (language, detail) | Personal | ✅ Yes | ❌ No |
| Project conventions | Project | ❌ No — bound to the project | ❌ No |
| Global conventions | Personal | ✅ Yes | ❌ No |

Your **role and preferences** are effectively "global": saved once with personal scope, they follow you into every project that enables the plugin. **Conventions** stay bound to the project where you recorded them, unless you save them as global — then they follow you everywhere too.

The one thing the **team shares** is the role *definitions* in `harness/user-roles/`: versioned in the repo and modifiable via pull request. Everyone reads the same role instructions; each teammate simply runs as their own role.

## Installation

Persona is enabled **per project** (opt-in): the `plugin` entry lives in each project's `opencode.json`, so it only activates where you declare it. This is deliberate — role instructions live in each project's `harness/user-roles/`, so a global install would add little in projects that haven't set them up. Enabling per project does **not** mean reconfiguring per project: your role and preferences are personal and follow you everywhere.

See the [Quick Start](#quick-start) above to get running, or [docs/INSTALL.md](docs/INSTALL.md) for the detailed guide — version pinning, updates, local development, verification, behavior details, and troubleshooting.

## Repository structure

```
.
├── src/
│   ├── index.ts             # Plugin entry point
│   └── *.ts                 # Internal modules (roles, preferences, conventions, database client...)
├── test/                    # Test suite (node:test + a fake MCP server)
├── templates/
│   └── user-roles/          # Role instruction templates: DEV.md, ARQ.md, BA.md, QA.md, _TEMPLATE.md
├── docs/
│   └── INSTALL.md           # Detailed installation guide, verification, and troubleshooting
└── dist/                    # Built ESM output (generated by `npm run build`, published to npm)
```

`harness/user-roles/` is not part of this repository: each consuming project creates it (for example, by copying `templates/user-roles/`) and owns its contents.

## Tests

```bash
npm install
npm run typecheck && npm test
```

The suite needs no local database installed: it uses a fake MCP server included in `test/helpers/` and never touches your real data.

## Additional documentation

- [docs/INSTALL.md](docs/INSTALL.md) — detailed installation, verification, behavior details, and troubleshooting.
