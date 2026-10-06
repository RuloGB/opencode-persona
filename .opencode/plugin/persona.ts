// Dev-only shim so this repo dogfoods the plugin from source (run `npm install` at the root first); consumers install the npm package instead.
// Re-exports the module-shaped default `{ id, server, setup }` that both OpenCode v1 (>= 1.18.29) and v2 load; v2 also discovers local plugins in .opencode/plugin/ and .opencode/plugins/.
export { default } from "../../src/index.ts";
