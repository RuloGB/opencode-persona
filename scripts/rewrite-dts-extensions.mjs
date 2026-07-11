// tsc's rewriteRelativeImportExtensions rewrites JS emit only; declaration output keeps ".ts" specifiers.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
for (const name of readdirSync(dist, { recursive: true })) {
  if (!name.endsWith(".d.ts")) continue;
  const file = join(dist, name);
  const source = readFileSync(file, "utf-8");
  const rewritten = source.replace(/"(\.\.?\/[^"]*)\.ts"/g, '"$1.js"');
  if (rewritten !== source) writeFileSync(file, rewritten);
}
