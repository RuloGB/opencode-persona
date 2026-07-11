# _TEMPLATE.md — Role template

Copy this file as `<ROLE>.md` to create or revise a role. Rules:

- Keep the five sections, with these names and in this order; do not add others.
- Write each bullet in the imperative, addressed to the assistant ("state", "propose").
- Be brief: the whole file is injected into the assistant's context in every session.
- Do not declare permissions or tools: the user grants them at runtime, when the
  assistant requests them.
- The plugin does not load this file as a role; it only loads the files mapped in
  `roles.ts` (`DEV.md`, `ARQ.md`, `BA.md`, `QA.md`).

---

# <ROLE>.md — <Role name>

## Identity

<!-- 1-2 lines: who you assist, what they do in the project, and their technical level. -->

## Response tone

<!-- 3-4 bullets: register, level of detail, and preferred format (code, lists, scenarios...). -->

## Behavior

<!-- 3-5 bullets: how to act on the role's typical requests, what to confirm before doing, and what to flag. -->

## Artifact generation

<!-- 3-6 bullets: what the assistant produces for this role (code, ADRs, user stories, test plans...) and the standards each artifact must meet. -->

## Boundaries

<!-- 2-3 bullets: what this role must not do and what it must escalate or confirm first. -->
