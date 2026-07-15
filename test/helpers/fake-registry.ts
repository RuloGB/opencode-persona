// Minimal loopback HTTP server standing in for npm's
// `registry.npmjs.org/opencode-persona/latest` endpoint: tests point
// PERSONA_NPM_REGISTRY_URL at it so the plugin's update check never touches
// the real registry, and control exactly what "latest version" (or failure)
// it sees. Unlike test/helpers/fake-engram.ts (a stdio subprocess for the MCP
// client), plain HTTP needs no subprocess: the server runs in-process.
import * as http from "node:http";

export interface FakeRegistryOptions {
  /** Version reported in the JSON body; ignored when `rawBody` is set. */
  version?: string;
  /** HTTP status code to respond with (default 200). */
  status?: number;
  /** Raw response body, overriding the default `{ "version": ... }` JSON (e.g. to simulate malformed JSON). */
  rawBody?: string;
  /** Never respond, to simulate a hung connection and exercise the caller's timeout. */
  hang?: boolean;
  /** Delay before responding, in milliseconds: simulates a slow-but-eventually-successful registry. */
  delayMs?: number;
}

export interface FakeRegistry {
  url: string;
  close: () => Promise<void>;
}

export function startFakeRegistry(options: FakeRegistryOptions = {}): Promise<FakeRegistry> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      if (options.hang) return; // never respond: the client's own timeout must fire
      const respond = () => {
        const status = options.status ?? 200;
        const body = options.rawBody ?? JSON.stringify({ version: options.version ?? "0.0.0" });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      };
      if (options.delayMs) setTimeout(respond, options.delayMs);
      else respond();
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fake registry did not bind to a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () =>
          new Promise<void>((res) => {
            // Forces closed even a still-open "hang" connection; otherwise
            // server.close()'s callback would wait for it to end on its own.
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}
