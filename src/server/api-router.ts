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
import { controlService, listServiceViews } from "../bridge/service-tools.js";
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

/**
 * Reply to the caller with a connection that will not be reused.
 *
 * Used for the answers that outlive their own listener — stop, rotate, shutdown,
 * and the settings actions that defer them. The reply is the last thing this
 * connection carries, so declaring it non-reusable lets Node close the socket
 * gracefully after the flush (FIN after the body), and removes it from the set
 * the teardown later destroys. Without this the teardown raced the caller's read
 * and a successful rotation reached the console as ECONNRESET.
 */
function jsonAndClose(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) res.setHeader("connection", "close");
  json(res, status, body);
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

/**
 * Run `task` once this response has actually left the process.
 *
 * `setImmediate` is NOT enough here: `res.end()` only hands the bytes to the
 * socket, and the kernel may not have flushed them yet. Tearing the listener
 * down on the next tick therefore truncates the body — under load the client
 * reads most of it and then gets UND_ERR_SOCKET ("other side closed") for a
 * response the server considered delivered, which is how this shipped once and
 * failed CI on the busier runner. `finish` fires when the last byte is handed
 * to the OS, which is the earliest safe moment.
 */
function afterResponse(res: ServerResponse, task: () => void): void {
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    task();
  };
  // `finish` is the flush: the body has been handed to the OS, which is the
  // earliest moment the teardown can start without losing it. (`end()` alone is
  // not: it returns before the bytes leave the HTTP layer, which is why acting
  // on `writableFinished` truncated replies — measured, not assumed.)
  //
  // Even after the flush the bytes are only in the peer's kernel buffer, so what
  // makes this safe is the reply itself: teardown-bound answers go out through
  // jsonAndClose(), which marks the connection non-reusable so Node closes it
  // gracefully (FIN after the body) instead of leaving a socket behind for
  // stopLocalServer → closeIdleConnections() to destroy mid-read — the
  // ECONNRESET a caller used to get for a rotation that had succeeded.
  if (res.writableFinished) {
    run();
    return;
  }
  res.once("finish", run);
  // A client that hangs up mid-response must not strand the teardown: the
  // operator asked for a stop or a rotation, and it has to happen either way.
  res.once("close", run);
  // Backstop for the remaining case — a client that holds the connection open
  // but stops reading. Responses here are a few KB on loopback, so 2 s is
  // generous; `run` is idempotent, so a late fire is a no-op.
  setTimeout(run, 2_000).unref?.();
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
          jsonAndClose(res, 200, { ok: true, status: getBridgeStatus() });
          afterResponse(res, () => { void stop(); });
          return true;
        }
        case "/bridge/rotate": {
          // Rotate in-process first so this response can carry the new endpoint,
          // then rebind the listener once the response is flushed.
          await enqueueLifecycle(async () => { await rotateRouteToken(); });
          jsonAndClose(res, 200, { ok: true, status: getBridgeStatus(), reloadRequired: true });
          afterResponse(res, () => { void restartListener(); });
          return true;
        }
        case "/settings/action": {
          const result = await handleSettingsAction(await readBody(req));
          const closing = result.ok && (result.deferStop || result.deferRestart);
          (closing ? jsonAndClose : json)(res, result.ok ? 200 : 400, result);
          // Stop and rebind tear down the socket this response is on, so they
          // wait for it to be fully flushed. Doing them first is what turned a
          // successful stop/rotate into an ECONNRESET with no response body —
          // and doing them merely on the next tick still truncated the tail of
          // a large body, which reached the client as a socket error.
          if (result.ok && result.deferStop) afterResponse(res, () => { void stop(); });
          else if (result.ok && result.deferRestart) afterResponse(res, () => { void restartListener(); });
          return true;
        }
        case "/shutdown": {
          // Same rule as stop/rotate: this reply is the last thing this listener
          // will ever send, so the process must not exit before the client has
          // read it.
          jsonAndClose(res, 200, { ok: true, message: "Shutting down." });
          afterResponse(res, () => { void gracefulShutdown(); }); return true;
        }
        case "/services/action": {
          // Operator-driven service control. The MCP tools stay the way an
          // agent saves and drives services; this is the console's own path to
          // the same functions, so the two can never disagree about state.
          const body = await readBody(req) as { action?: unknown; name?: unknown } | undefined;
          const action = String(body?.action ?? "");
          const name = String(body?.name ?? "");
          if (action !== "start" && action !== "stop" && action !== "restart") {
            json(res, 400, { ok: false, error: "action must be start, stop or restart." });
            return true;
          }
          if (!name) {
            json(res, 400, { ok: false, error: "name is required." });
            return true;
          }
          try {
            const result = await controlService(action, name);
            json(res, 200, { ok: true, result, services: listServiceViews() });
          } catch (error) {
            json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          return true;
        }
        default: json(res, 404, { error: "Unknown API route." }); return true;
      }
    }
    switch (route) {
      case "/status": json(res, 200, { ok: true, status: getBridgeStatus() }); return true;
      case "/services": json(res, 200, { ok: true, services: listServiceViews() }); return true;
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
