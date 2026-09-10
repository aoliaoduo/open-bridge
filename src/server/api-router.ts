/**
 * /api JSON endpoints + /console static hosting — the standalone host's local
 * surfaces, wired into the Bridge request chain via setExtraRouteHandler.
 *
 * Security model (same posture the VS Code panel had, adapted to HTTP):
 *
 *  - Loopback gate: /api and /console answer ONLY when the Host header is
 *    127.0.0.1:<port> or localhost:<port>. The ngrok tunnel forwards with the
 *    public Host, so the admin surface can never be reached over the tunnel —
 *    /mcp stays the only public route, exactly like the extension days.
 *  - Mutation gate: every POST also requires the X-Open-Bridge-Console header
 *    matching the route token. A cross-origin page cannot read the token
 *    (no CORS headers are emitted) and cannot even SEND the header without a
 *    preflight we never answer — CSRF is dead by construction. The console
 *    HTML (loopback-only) has the token injected server-side.
 *  - GET endpoints carry no secret-bearing data beyond what the panel showed.
 */

import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { state } from "../bridge/state.js";
import { getBridgeStatus, getUsageStats } from "../bridge/meta-tools.js";
import { buildSettingsState, handleSettingsAction } from "./settings-handler.js";
import { start, stop, rotateRouteToken, restartListener, enqueueLifecycle, webAiPrompt } from "../bridge/lifecycle.js";
import { nodeHost } from "../host/node-host.js";
import { redactSensitiveText } from "../bridge/state.js";

const CONSOLE_HEADER = "x-open-bridge-console";

/** dist/server/api-router.js -> <root>/dist/ui (vite output). */
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");

function json(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  }
  res.end(JSON.stringify(body));
}

/** Host must name this machine; the ngrok public host is refused. */
function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
    || host === `127.0.0.1` || host === `localhost`;
}

function hasConsoleToken(req: IncomingMessage): boolean {
  const presented = req.headers[CONSOLE_HEADER];
  return typeof presented === "string" && presented.length > 0 && presented === state.routeToken;
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// --- SSE log stream ---------------------------------------------------------

interface SseClient { res: ServerResponse }

const sseClients = new Set<SseClient>();

function ssePush(line: string): void {
  const payload = `data: ${JSON.stringify({ line: redactSensitiveText(line) })}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(payload); } catch { sseClients.delete(client); }
  }
}

let sseWired = false;

function ensureLogStreamWired(): void {
  if (sseWired) return;
  sseWired = true;
  try {
    nodeHost().bridgeLog.onLine(line => ssePush(line));
  } catch {
    // Host not installed yet; wiring retries on the next subscriber.
    sseWired = false;
  }
}

// --- Static console assets --------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function serveConsole(res: ServerResponse, url: URL): Promise<void> {
  let rel = decodeURIComponent(url.pathname).replace(/^\/console\/?/, "");
  if (!rel || rel.endsWith("/")) rel = `${rel}console.html`;
  // Never let ../ escape the console directory.
  const full = path.normalize(path.join(UI_DIR, rel));
  if (!full.startsWith(UI_DIR)) {
    json(res, 403, { error: "Forbidden." });
    return;
  }
  const file = existsSync(full) && statSync(full).isFile() ? full : path.join(UI_DIR, "console.html");
  try {
    let body = await fs.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    if (type.startsWith("text/html")) {
      // Inject only a meta value; no inline script is permitted by the CSP.
      const escaped = state.routeToken.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const html = body.toString("utf8").replace(
        "</head>",
        `<meta name="open-bridge-console-token" content="${escaped}"></head>`,
      );
      body = Buffer.from(html, "utf8");
    }
    res.writeHead(200, {
      "content-type": type,
      "cache-control": type.startsWith("text/html") ? "no-store" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  } catch {
    json(res, 503, {
      error: "Console UI is not built. Run `npm run build` (or `open-bridge doctor` for details).",
    });
  }
}

// --- Router -----------------------------------------------------------------

/** The extra route handler installed into the Bridge request chain. */
export async function apiRouteHandler(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  const isConsole = url.pathname === "/console" || url.pathname.startsWith("/console/");
  if (!isApi && !isConsole) return false;

  if (!isLoopbackHost(req.headers.host, state.port)) {
    json(res, 403, { error: "The console and API are loopback-only." });
    return true;
  }

  if (isConsole) {
    // Deliberately token-free. The console HTML is where the token is delivered
    // (injected into <head> server-side), so demanding it here would deadlock:
    // no browser could ever load the page that hands out the token. The
    // loopback Host gate above is the boundary — and anything served here a
    // same-machine process could already read straight from the data dir.
    await serveConsole(res, url);
    return true;
  }

  const route = url.pathname.replace(/^\/api/, "") || "/";
  // Reads are loopback-gated only; mutations must additionally prove possession
  // of the console token. A cross-origin page can neither read these responses
  // (no CORS headers are emitted) nor send this header without a preflight we
  // never answer, so the mutation gate stays CSRF-proof on its own.
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && !hasConsoleToken(req)) {
    json(res, 403, { error: "Missing or invalid console token." });
    return true;
  }

  try {
    if (req.method === "POST") {
      switch (route) {
        case "/bridge/start": { await start(); json(res, 200, { ok: true, status: getBridgeStatus() }); return true; }
        case "/bridge/stop": {
          // Answer first, tear down second: this response travels over the very
          // listener stop() closes, so awaiting it here handed the caller a
          // connection reset for a stop that had in fact succeeded.
          json(res, 200, { ok: true, status: getBridgeStatus() });
          setImmediate(() => { void stop(); });
          return true;
        }
        case "/bridge/rotate": {
          // Rotate in-process first so this response can carry the new endpoint,
          // then rebind the listener once the response is flushed.
          await enqueueLifecycle(async () => { await rotateRouteToken(); });
          json(res, 200, { ok: true, status: getBridgeStatus(), reloadRequired: true });
          setImmediate(() => { void restartListener(); });
          return true;
        }
        case "/settings/action": {
          const result = await handleSettingsAction(await readBody(req));
          json(res, result.ok ? 200 : 400, result);
          // Stop and rebind tear down the socket this response is on, so they
          // run only after it has been flushed. Doing them first is what turned
          // a successful stop/rotate into an ECONNRESET with no response body.
          if (result.ok && result.deferStop) setImmediate(() => { void stop(); });
          else if (result.ok && result.deferRestart) setImmediate(() => { void restartListener(); });
          return true;
        }
        case "/shutdown": {
          json(res, 200, { ok: true, message: "Shutting down." });
          setImmediate(() => { void gracefulShutdown(); }); return true;
        }
        default: json(res, 404, { error: "Unknown API route." }); return true;
      }
    }
    switch (route) {
      case "/status": json(res, 200, { ok: true, status: getBridgeStatus() }); return true;
      case "/activity": json(res, 200, { ok: true, activity: state.activity }); return true;
      case "/usage": json(res, 200, { ok: true, usage: getUsageStats() }); return true;
      case "/settings": json(res, 200, { ok: true, state: await buildSettingsState() }); return true;
      case "/prompt": json(res, 200, { ok: true, prompt: webAiPrompt() }); return true;
      case "/logs/stream": {
        ensureLogStreamWired();
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ line: "--- log stream connected ---" })}

`);
        const client: SseClient = { res }; sseClients.add(client);
        req.on("close", () => { sseClients.delete(client); }); return true;
      }
      default: json(res, 404, { error: "Unknown API route." }); return true;
    }
  } catch (error) {
    json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

let shutdownHook: (() => Promise<void>) | undefined;

/** The CLI installs the real shutdown path (lifecycle stop + process exit). */
export function setShutdownHook(hook: () => Promise<void>): void {
  shutdownHook = hook;
}

async function gracefulShutdown(): Promise<void> {
  if (shutdownHook) await shutdownHook();
}
