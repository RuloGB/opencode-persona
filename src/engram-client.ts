// In-house Engram client over MCP (an `engram mcp` subprocess via stdio),
// independent from whatever MCP server the LLM uses. Schema verified against
// engram (2026-07): scope "project" | "personal" (there is no "global"),
// numeric observation ids, and responses as JSON serialized in content[0].text.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EngramCacheStore } from "./engram-cache.ts";
import type { PersonaLogger } from "./logger.ts";

export interface EngramEntryDef {
  /** Internal logical key, also used in the local id cache. */
  key: string;
  /** topic_key in Engram: the same value implies upsert, never a duplicate. */
  topicKey: string;
  title: string;
  type: "config" | "decision" | "architecture" | "bugfix" | "pattern" | "discovery" | "learning";
  /**
   * Scope WITHIN the user's local Engram (never across people):
   * "personal" travels with the user across projects; "project" stays bound to the current project.
   */
  scope: "personal" | "project";
  /** mem_search query used to relocate the observation if the cache is lost. */
  searchQuery: string;
}

// title and searchQuery are persisted lookup keys: renaming them orphans data
// already saved under the old values — only change them in a breaking release.
export const ENTRY_USER_ROLE: EngramEntryDef = {
  key: "user_role",
  topicKey: "persona/user-role",
  title: "Persona: user role",
  type: "config",
  scope: "personal",
  searchQuery: "persona user role",
};

export const ENTRY_USER_PREFERENCES: EngramEntryDef = {
  key: "user_preferences",
  topicKey: "persona/user-preferences",
  title: "Persona: user preferences",
  type: "config",
  scope: "personal",
  searchQuery: "persona user preferences",
};

export const ENTRY_PROJECT_CONVENTIONS: EngramEntryDef = {
  key: "project_conventions",
  topicKey: "persona/project-conventions",
  title: "Persona: project conventions",
  type: "config",
  scope: "project",
  searchQuery: "persona project conventions",
};

/** Engram unavailable (missing binary, dropped connection...); callers degrade to default behavior. */
export class EngramUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Engram unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "EngramUnavailableError";
  }
}

/** Alternative transport to Engram; used by tests and environments with the binary in a non-standard path. */
export interface EngramTransportOptions {
  command?: string;
  args?: string[];
  /** Maximum wait to start `engram mcp`; once exceeded, degrade as Engram unavailable. */
  connectTimeoutMs?: number;
  /** Maximum wait per individual MCP call. */
  callTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_CALL_TIMEOUT_MS = 8000;

export class EngramClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connecting: Promise<Client> | null = null;
  private readonly cache: EngramCacheStore;
  private readonly projectRoot: string;
  private readonly logger: PersonaLogger | undefined;
  private readonly options: EngramTransportOptions;

  constructor(projectRoot: string, logger?: PersonaLogger, options?: EngramTransportOptions) {
    this.projectRoot = projectRoot;
    this.cache = new EngramCacheStore(projectRoot);
    this.logger = logger;
    this.options = options ?? {};
  }

  async save(def: EngramEntryDef, payload: unknown): Promise<void> {
    const client = await this.ensureConnected();
    const result = await this.callTool(client, {
      name: "mem_save",
      arguments: {
        title: def.title,
        type: def.type,
        scope: def.scope,
        topic_key: def.topicKey,
        content: serializePayload(def, payload),
        capture_prompt: false,
      },
    });

    const parsed = parseToolJson(result);
    const id = parsed?.id;
    if (id !== undefined && id !== null) {
      this.cache.set(def.key, String(id));
      this.logger?.log(`saved to Engram (${def.key} -> observation #${id})`);
    } else {
      this.logger?.log("mem_save returned no recognizable id", parsed);
    }
  }

  async get<T = unknown>(def: EngramEntryDef): Promise<T | null> {
    const client = await this.ensureConnected();

    const cachedId = this.cache.get(def.key);
    if (cachedId !== undefined) {
      const payload = await this.tryFetchById(Number(cachedId), def);
      if (payload !== null) {
        this.logger?.log(`read from Engram via cached id (${def.key} -> #${cachedId})`);
        return payload as T;
      }
      this.logger?.log(`cached id #${cachedId} is stale for ${def.key}; falling back to mem_search`);
    }

    // Personal entries travel across projects; project entries are searched
    // only in the current project (engram infers it from the cwd).
    const searchResult = await this.callTool(client, {
      name: "mem_search",
      arguments: {
        query: def.searchQuery,
        scope: def.scope,
        all_projects: def.scope === "personal",
        limit: 20,
      },
    });
    const results = parseToolJson(searchResult)?.results;
    const candidates: Array<{ id?: unknown; title?: unknown }> = Array.isArray(results) ? results : [];

    // mem_search results do not include topic_key: filter by title and verify
    // the actual topic by reading each candidate by id.
    for (const candidate of candidates) {
      if (candidate?.title !== def.title || candidate?.id === undefined) continue;
      const payload = await this.tryFetchById(Number(candidate.id), def);
      if (payload !== null) {
        this.cache.set(def.key, String(candidate.id));
        this.logger?.log(`recovered via mem_search (${def.key} -> #${candidate.id})`);
        return payload as T;
      }
    }

    this.logger?.log(`no data in Engram for ${def.key}`);
    return null;
  }

  /** Closes the `engram mcp` subprocess; the next call reconnects. Needed by tests and clean shutdowns. */
  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.connecting = null;
    try {
      await client?.close();
    } catch {
      // Best-effort close; the transport is closed regardless.
    }
    try {
      await transport?.close();
    } catch {
      // Without a live process there is nothing to close.
    }
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const command = this.options.command ?? process.env.PERSONA_ENGRAM_CMD ?? resolveEngramCommand();
      const args = this.options.args ?? resolveEngramArgs();
      const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      let transport: StdioClientTransport | null = null;
      try {
        // cwd pinned to the project root: engram infers the "project" from the
        // cwd basename, even if OpenCode is launched from a subfolder.
        transport = new StdioClientTransport({
          command,
          args,
          cwd: this.projectRoot,
        });
        const client = new Client({ name: "persona-plugin", version: "1.0.0" });
        // A hung `engram mcp` without a timeout would leave the session without injection forever.
        await withTimeout(client.connect(transport), timeoutMs, `connecting to Engram (${command})`);
        this.client = client;
        this.transport = transport;
        this.logger?.log(`connected to Engram (${command})`);
        return client;
      } catch (err) {
        this.connecting = null; // do not cache the failure: allows retrying on the next call
        void transport?.close().catch(() => {}); // kills the hung subprocess if it ever started
        this.logger?.error(`could not connect to Engram (${command})`, err);
        throw new EngramUnavailableError(err);
      }
    })();

    return this.connecting;
  }

  private callTool(client: Client, params: { name: string; arguments: Record<string, unknown> }) {
    return client.callTool(params, undefined, {
      timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    });
  }

  /** Reads an observation and returns its payload only if the topic matches; null if missing or unreadable. */
  private async tryFetchById(id: number, def: EngramEntryDef): Promise<unknown | null> {
    if (!Number.isFinite(id)) return null;
    try {
      const client = await this.ensureConnected();
      const result = await this.callTool(client, { name: "mem_get_observation", arguments: { id } });
      const raw: string = parseToolJson(result)?.result ?? "";
      const topicMatch = raw.match(/^Topic:\s*(.+)\s*$/m);
      if (!topicMatch || topicMatch[1].trim() !== def.topicKey) return null;
      return extractPayload(raw);
    } catch {
      return null;
    }
  }
}

// The PATH inherited by OpenCode does not always include engram (it depends on
// how the app was launched): resolve the binary explicitly, with fallback paths.
function resolveEngramCommand(): string {
  const isWin = process.platform === "win32";
  const names = isWin ? ["engram.exe", "engram.cmd", "engram.bat"] : ["engram"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSafe(candidate)) return candidate;
    }
  }
  const fallbacks = isWin
    ? [path.join(process.env.LOCALAPPDATA ?? "", "engram", "bin", "engram.exe")]
    : [
        "/opt/homebrew/bin/engram",
        "/usr/local/bin/engram",
        path.join(os.homedir(), ".local", "bin", "engram"),
      ];
  for (const candidate of fallbacks) {
    if (candidate && existsSafe(candidate)) return candidate;
  }
  return "engram"; // last resort: let spawn itself resolve it
}

// PERSONA_ENGRAM_ARGS allows replacing `mcp` with other arguments (JSON array);
// together with PERSONA_ENGRAM_CMD it serves diagnostics and the tests.
function resolveEngramArgs(): string[] {
  const raw = process.env.PERSONA_ENGRAM_ARGS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((a) => typeof a === "string")) return parsed;
    } catch {
      // Invalid JSON: ignore it and use the default arguments.
    }
  }
  return ["mcp"];
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms while ${what}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function existsSafe(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

// serializePayload and extractPayload jointly define the format of the content
// field in Engram: if one changes, the other must change too.
function serializePayload(def: EngramEntryDef, payload: unknown): string {
  return `**What**: ${def.title}.\n**Why**: Persona configuration.\n**Where**: N/A.\n**Learned**: ${JSON.stringify(payload)}`;
}

function extractPayload(rawContent: string): unknown | null {
  const learnedMatch = rawContent.match(/\*\*Learned\*\*:\s*(\{[^\n]*\})/);
  if (!learnedMatch) return null;
  try {
    return JSON.parse(learnedMatch[1]);
  } catch {
    return null;
  }
}

function parseToolJson(result: unknown): any {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find((c) => c?.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
