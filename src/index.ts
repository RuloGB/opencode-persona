// Published entry point, loaded by both OpenCode lines from the same module:
// - v1 (>= 1.18.29) reads `default` as `{ id, server }` and runs only `server`.
// - v2 decodes `default` as `{ id, setup }` (extra keys are ignored).
// The object must have no `effect` key (v2 would take its Effect branch) and
// no `tui` key (v1 rejects a module exporting both server and tui).
import type { Plugin } from "@opencode-ai/plugin";
import { Persona } from "./plugin-v1.ts";
import { setup, type V2Context } from "./plugin-v2.ts";

export { Persona };

// Typed as an intersection rather than v1's PluginModule: its `tui?: never`
// and excess-property checks would reject the v2 `setup` key.
const PersonaPlugin: { id: string; server: Plugin } & { setup: (ctx: V2Context) => Promise<() => void> } = {
  id: "opencode-persona",
  server: Persona,
  setup,
};

export default PersonaPlugin;
