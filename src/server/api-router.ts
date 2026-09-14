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
 *    matching the route token. A cross-origin page cannot read the token (these
 *    surfaces get no CORS grant — see the per-path `corsGrant` block in
 *    `src/bridge/http-listener.ts`, which is what enforces this) and cannot even
 *    SEND the header without a preflight we never answer — CSRF is dead by
 *    construction. The console HTML (loopback-only) has the token injected
 *    server-side.
 *  - GET endpoints are loopback-gated only, and they are NOT free of secrets:
 *    /api/settings (`state.mcpUrl`), /api/prompt and /api/status all carry the route
 *    token in their bodies. Same-origin + no CORS grant is what keeps those readable
 *    only by the console; adding CORS here would hand the token to whatever page the
 *    operator has open, since a cross-origin request to 127.0.0.1 passes the Host
 *    gate. The console's own page (served below) has the token injected
 *    server-side.
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
import { start, stop, webAiPrompt } from "../bridge/lifecycle.js";
import { buildStaleness } from "../bridge/build-staleness.js";
import { nodeHost } from "../host/node-host.js";
import { redactSensitiveText } from "../bridge/state.js";
import { lockSnapshot } from "../bridge/resource-locks.js";
import { listToolDefinitions } from "../bridge/tool-catalog.js";
import { CORE_TOOLS } from "../mcp/tool-definitions.js";
import { handleOAuthRequest, oauthConsoleView } from "../http/oauth.js";
import { sendJson } from "../http/json-response.js";

const CONSOLE_HEADER = "x-open-bridge-console";

/** dist/server/api-router.js -> <root>/dist/ui (vite output). */
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");

/**
 * Reply to the caller with a connection that will not be reused.
 *
 * Used for the answers that outlive their own listener — stop, shutdown, and the
 * settings actions that defer them. The reply is the last thing this connection
 * carries, so declaring it non-reusable lets Node close the socket gracefully
 * after the flush (FIN after the body), and removes it from the set the teardown
 * later destroys. Without this the teardown raced the caller's read and a
 * successful stop reached the console as ECONNRESET.
 */
function jsonAndClose(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) res.setHeader("connection", "close");
  sendJson(res, status, body);
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
  // decodeURIComponent throws on malformed escapes ("%zz"): the handler runs
  // OUTSIDE the router's catch, so a stray local request (or a public website
  // driving the operator's browser at the loopback console) killed the process.
  let requested: string;
  try {
    requested = decodeURIComponent(url.pathname).replace(/^\/console\/?/, "");
  } catch {
    sendJson(res, 400, { error: "Bad request path." });
    return;
  }
  try {
  // A request that looks like a file (assets/*.js, *.css, ...) must never be
  // answered with the HTML shell: the browser asked for a script and would get
  // markup with a text/html content type, which fails quietly. Only page paths
  // get the fallback.
  const fileLike = !requested.endsWith("/") && path.extname(requested) !== "";
  let rel = requested;
  if (!rel || rel.endsWith("/")) rel = `${rel}console.html`;
  // Never let ../ escape the console directory. path.relative (not startsWith —
  // a sibling "dist/ui-extra" would prefix-match "dist/ui") decides containment.
  const full = path.normalize(path.join(UI_DIR, rel));
  const within = path.relative(UI_DIR, full);
  if (within.startsWith("..") || path.isAbsolute(within)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }
  const found = existsSync(full) && statSync(full).isFile();
  if (!found && fileLike) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }
  const file = found ? full : path.join(UI_DIR, "console.html");
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
    sendJson(res, 503, {
      error: "Console UI is not built. Run `npm run build` (or `open-bridge doctor` for details).",
    });
  }
  } catch (error) {
    // The stat/read race (file vanishing between existsSync and readFile) must
    // not escape: serveConsole runs outside the router's own try/catch.
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
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

  // The OAuth endpoints are consulted BEFORE the loopback gate, and that order is
  // the whole point: a remote MCP client has to discover the authorization
  // server and complete the flow over the tunnel, so these must be publicly
  // reachable once OAuth is switched on. `/api` and `/console` stay
  // loopback-only exactly as before — OAuth does not widen them. When OAuth is
  // off this is a single config read returning false.
  if (await handleOAuthRequest(req, res, url)) return true;

  if (!isApi && !isConsole) return false;

  if (!isLoopbackHost(req.headers.host, state.port)) {
    sendJson(res, 403, { error: "The console and API are loopback-only." });
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
    sendJson(res, 403, { error: "Missing or invalid console token." });
    return true;
  }

  try {
    if (req.method === "POST") {
      switch (route) {
        case "/bridge/start": { await start(); sendJson(res, 200, { ok: true, status: getBridgeStatus() }); return true; }
        case "/bridge/stop": {
          // Answer first, tear down second: this response travels over the very
          // listener stop() closes, so awaiting it here handed the caller a
          // connection reset for a stop that had in fact succeeded.
          jsonAndClose(res, 200, { ok: true, status: getBridgeStatus() });
          afterResponse(res, () => { void stop(); });
          return true;
        }
        case "/bridge/rotate": {
          // Delegates to the console's rotate action: this route used to repeat
          // the same rotate-then-rebind dance, so a fix applied to one could
          // silently miss the other. It now carries that action's verdict
          // instead of an unconditional ok — the route used to report success
          // even when the rotation underneath had failed.
          const rotated = await handleSettingsAction({ command: "rotateEndpoint" });
          jsonAndClose(res, rotated.ok ? 200 : 400, {
            ok: rotated.ok,
            status: getBridgeStatus(),
            reloadRequired: rotated.ok,
            error: rotated.error,
          });
          return true;
        }
        case "/sessions/close": {
          // "Who is connected" is only useful with a way to act on it: an
          // operator who sees a session they do not recognise must be able to
          // close it from the same page. Accepts an id or a prefix, but ONLY an
          // unambiguous one: the console shows a shortened id, and a short
          // prefix that matched several sessions used to close whichever came
          // first in insertion order — not necessarily the intended one.
          const body = await readBody(req) as { id?: unknown } | undefined;
          const wanted = String(body?.id ?? "");
          if (!wanted) { sendJson(res, 400, { ok: false, error: "id is required." }); return true; }
          const matches = [...state.sessions.entries()].filter(([id]) => id === wanted || id.startsWith(wanted));
          if (matches.length === 0) { sendJson(res, 404, { ok: false, error: "会话不存在（可能已经自己断开）。" }); return true; }
          if (matches.length > 1) {
            sendJson(res, 400, { ok: false, error: `id 前缀不唯一（匹配到 ${matches.length} 个会话），请使用更长的前缀。` });
            return true;
          }
          const [closedId, session] = matches[0]!;
          state.sessions.delete(closedId);
          void session.transport.close();
          sendJson(res, 200, { ok: true, closed: closedId, sessions: sessionViews() });
          return true;
        }
        case "/settings/action": {
          const result = await handleSettingsAction(await readBody(req));
          const closing = result.ok && result.deferStop;
          (closing ? jsonAndClose : sendJson)(res, result.ok ? 200 : 400, result);
          // Stop tears down the socket this response is on, so it waits for the
          // reply to be fully flushed. Doing it first is what turned a
          // successful stop into an ECONNRESET with no response body — and doing
          // it merely on the next tick still truncated the tail of a large body,
          // which reached the client as a socket error.
          if (result.ok && result.deferStop) afterResponse(res, () => { void stop(); });
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
            sendJson(res, 400, { ok: false, error: "action must be start, stop or restart." });
            return true;
          }
          if (!name) {
            sendJson(res, 400, { ok: false, error: "name is required." });
            return true;
          }
          try {
            const result = await controlService(action, name);
            sendJson(res, 200, { ok: true, result, services: listServiceViews() });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          return true;
        }
        default: sendJson(res, 404, { error: "Unknown API route." }); return true;
      }
    }
    switch (route) {
      case "/status": sendJson(res, 200, { ok: true, status: getBridgeStatus() }); return true;
      case "/sessions": sendJson(res, 200, { ok: true, sessions: sessionViews(), locks: lockSnapshot() }); return true;
      case "/tools": {
        const profile = String((getBridgeStatus() as Record<string, unknown>).tool_profile ?? "full");
        const tools = listToolDefinitions().map(tool => ({
          name: tool.name,
          description: firstLine(tool.description),
          core: CORE_TOOLS.has(tool.name),
        }));
        sendJson(res, 200, { ok: true, profile, count: tools.length, tools });
        return true;
      }
      case "/health": {
        // A real report, not a restatement of /status: the public leg is an
        // actual request through the tunnel, which is the only way to know a
        // client could connect. Bounded by a timeout so the page cannot hang.
        const status = getBridgeStatus() as Record<string, unknown>;
        type Level = "ok" | "warn" | "fail";
        const checks: Array<{ name: string; level: Level; ok: boolean; detail: string }> = [];
        // `ok` stays for callers that only want a boolean; `level` lets the page
        // say 提醒 for a risk that is not a defect. public-open is a state the
        // operator may be choosing on purpose, and reporting it as 异常 made
        // every healthy instance look broken.
        const check = (name: string, level: Level, detail: string): void => {
          checks.push({ name, level, ok: level !== "fail", detail });
        };
        check("instance", status.state === "running" ? "ok" : "fail", `state=${String(status.state ?? "?")}`);
        check("workspace", "ok", String(status.workspace_root ?? ""));
        check("tools", Number(status.tool_count ?? 0) > 0 ? "ok" : "fail",
          `${String(status.tool_count ?? 0)} 个（${String(status.tool_profile ?? "?")}）`);
        // A rebuild does not touch a running process. Reporting it here keeps a
        // green health page from hiding "you are running the previous build".
        const build = buildStaleness();
        if (build) {
          check("build", build.stale ? "warn" : "ok", build.stale
            ? "磁盘上的 dist 比运行中的实例新：关掉承载实例的终端窗口，再双击一键启动脚本重新启动即可换上新构建"
            : "与运行中的实例一致");
        }
        const publicUrl = typeof status.public_url === "string" ? status.public_url : "";
        check("tunnel", "ok", publicUrl
          ? `${String(status.tunnel_role ?? "?")} — ${publicUrl}`
          : "未开启（仅本机可用）");
        if (publicUrl && state.routeToken) {
          const origin = new URL(publicUrl).origin;
          const startedAt = Date.now();
          try {
            const probe = await fetch(`${origin}/healthz/${state.routeToken}`, {
              headers: { "ngrok-skip-browser-warning": "true" },
              signal: AbortSignal.timeout(6_000),
            });
            check("public", probe.ok ? "ok" : "fail", `HTTP ${probe.status}（${Date.now() - startedAt} ms）`);
          } catch (error) {
            check("public", "fail", `探测失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const exposure = String(status.exposure ?? "local");
        check("exposure", exposure === "public-open" ? "warn" : "ok", exposure === "public-open"
          ? "公网可达且未开启鉴权：拿到 URL 的人都能读写文件、执行命令"
          : exposure);
        sendJson(res, 200, { ok: true, health: { checks, exposure } });
        return true;
      }
      case "/services": sendJson(res, 200, { ok: true, services: listServiceViews() }); return true;
      case "/activity": sendJson(res, 200, { ok: true, activity: state.activity }); return true;
      case "/usage": sendJson(res, 200, { ok: true, usage: getUsageStats() }); return true;
      // Which OAuth clients are registered and how many credentials are live.
      // Loopback-gated like every other /api read; the client list carries no
      // secrets (tokens are stored hashed and never leave the store).
      case "/oauth": sendJson(res, 200, { ok: true, oauth: await oauthConsoleView() }); return true;
      case "/settings": sendJson(res, 200, { ok: true, state: await buildSettingsState() }); return true;
      case "/prompt": sendJson(res, 200, { ok: true, prompt: webAiPrompt() }); return true;
      case "/logs/stream": {
        ensureLogStreamWired();
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ line: "--- log stream connected ---" })}

`);
        const client: SseClient = { res }; sseClients.add(client);
        req.on("close", () => { sseClients.delete(client); }); return true;
      }
      default: sendJson(res, 404, { error: "Unknown API route." }); return true;
    }
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}

/** One row per live MCP session: who, how idle, what it is doing. */
function sessionViews(): Array<Record<string, unknown>> {
  const now = Date.now();
  return [...state.sessions.entries()]
    .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    .map(([id, session]) => ({
      id,
      client: session.client ?? "未标识客户端",
      connected_at: new Date(session.connectedAt ?? session.lastUsed).toISOString(),
      calls: session.calls ?? 0,
      last_used: new Date(session.lastUsed).toISOString(),
      idle_ms: Math.max(0, now - session.lastUsed),
      active_requests: session.activeRequests,
      todos: Array.isArray(session.todos) ? session.todos.length : 0,
    }));
}

/** Tool descriptions are long; the catalog page wants one line per tool. */
function firstLine(text: unknown): string {
  const value = typeof text === "string" ? text : "";
  return value.split("\n")[0]!.trim();
}

let shutdownHook: (() => Promise<void>) | undefined;

/** The CLI installs the real shutdown path (lifecycle stop + process exit). */
export function setShutdownHook(hook: () => Promise<void>): void {
  shutdownHook = hook;
}

async function gracefulShutdown(): Promise<void> {
  if (shutdownHook) await shutdownHook();
}
