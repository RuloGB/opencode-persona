// Fake MCP server that mimics `engram mcp` for the tests: persists the
// observations in the JSON file at argv[2] and replicates the real response
// format (JSON serialized in content[0].text). Like the real Engram, it
// infers the project from the cwd basename (EngramClient pins the subprocess
// cwd to the project root): observations record the project they were saved
// in, and mem_search only crosses projects when the caller sends
// all_projects: true. Extra flags after the store path:
// - "--hang" simulates a binary that never completes the handshake, to test
//   the connection timeout.
// - "--fail-query=<substring>" makes mem_search calls whose query contains
//   the substring fail, to test per-entry degradation (each Persona entry
//   has a distinct searchQuery).
import * as fs from "node:fs";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

interface StoredEntry {
  id: number;
  title: string;
  type: string;
  scope: string;
  topic_key: string;
  project: string;
  content: string;
}

interface Store {
  nextId: number;
  entries: StoredEntry[];
}

const storePath = process.argv[2];
const extraArgs = process.argv.slice(3);
const failQuery = extraArgs.find((a) => a.startsWith("--fail-query="))?.slice("--fail-query=".length) ?? null;

// If the test process dies, the stdin close avoids leaving orphans behind.
process.stdin.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));

if (!storePath) {
  process.exit(2);
} else if (extraArgs.includes("--hang")) {
  setInterval(() => {}, 60_000);
} else {
  main();
}

function loadStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(storePath, "utf-8"));
  } catch {
    return { nextId: 1, entries: [] };
  }
}

function saveStore(store: Store): void {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function main(): void {
  const server = new Server({ name: "fake-engram", version: "0.0.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "mem_save", inputSchema: { type: "object" as const } },
      { name: "mem_search", inputSchema: { type: "object" as const } },
      { name: "mem_get_observation", inputSchema: { type: "object" as const } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const store = loadStore();
    const project = path.basename(process.cwd());

    if (name === "mem_save") {
      const topicKey = String(args.topic_key ?? "");
      const scope = String(args.scope ?? "project");
      // Personal topics upsert across projects (user-level data); project
      // topics upsert only within the project that saved them.
      let entry = store.entries.find(
        (e) => e.topic_key === topicKey && e.scope === scope && (scope === "personal" || e.project === project)
      );
      if (entry) {
        entry.title = String(args.title ?? entry.title);
        entry.content = String(args.content ?? "");
      } else {
        entry = {
          id: store.nextId++,
          title: String(args.title ?? ""),
          type: String(args.type ?? ""),
          scope,
          topic_key: topicKey,
          project,
          content: String(args.content ?? ""),
        };
        store.entries.push(entry);
      }
      saveStore(store);
      return json({ id: entry.id });
    }

    if (name === "mem_search") {
      const query = String(args.query ?? "");
      if (failQuery !== null && query.includes(failQuery)) {
        throw new Error(`injected failure for mem_search query containing "${failQuery}"`);
      }
      const scope = args.scope === undefined ? null : String(args.scope);
      const allProjects = args.all_projects === true;
      const results = store.entries
        .filter((e) => scope === null || e.scope === scope)
        .filter((e) => allProjects || e.project === project)
        .map((e) => ({ id: e.id, title: e.title }));
      return json({ results });
    }

    if (name === "mem_get_observation") {
      const id = Number(args.id);
      const entry = store.entries.find((e) => e.id === id);
      if (!entry) return json({ result: "observation not found" });
      return json({
        result: `# ${entry.title}\nTopic: ${entry.topic_key}\nScope: ${entry.scope}\n\n${entry.content}`,
      });
    }

    return json({ error: `unknown tool: ${name}` });
  });

  const transport = new StdioServerTransport();
  void server.connect(transport);
}
