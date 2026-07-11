// Fake MCP server that mimics `engram mcp` for the tests: persists the
// observations in the JSON file at argv[2] and replicates the real response
// format (JSON serialized in content[0].text). With "--hang" it simulates a
// binary that never completes the handshake, to test the connection timeout.
import * as fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

interface StoredEntry {
  id: number;
  title: string;
  type: string;
  scope: string;
  topic_key: string;
  content: string;
}

interface Store {
  nextId: number;
  entries: StoredEntry[];
}

const storePath = process.argv[2];
const mode = process.argv[3];

// If the test process dies, the stdin close avoids leaving orphans behind.
process.stdin.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));

if (!storePath) {
  process.exit(2);
} else if (mode === "--hang") {
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

    if (name === "mem_save") {
      const topicKey = String(args.topic_key ?? "");
      const scope = String(args.scope ?? "project");
      let entry = store.entries.find((e) => e.topic_key === topicKey && e.scope === scope);
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
          content: String(args.content ?? ""),
        };
        store.entries.push(entry);
      }
      saveStore(store);
      return json({ id: entry.id });
    }

    if (name === "mem_search") {
      const scope = args.scope === undefined ? null : String(args.scope);
      const results = store.entries
        .filter((e) => scope === null || e.scope === scope)
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
