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
import { buildSettingsState, buildTunnelView, handleSettingsAction } from "./settings-handler.js";
import { controlService, listServiceViews } from "../bridge/service-tools.js";
import { start, stop, webAiPrompt } from "../bridge/lifecycle.js";
import { buildStaleness } from "../bridge/build-staleness.js";
import { selfProbe } from "../bridge/self-probe.js";
import { authEnabled } from "../http/auth.js";
import { nodeHost } from "../host/node-host.js";
import { redactSensitiveText } from "../bridge/state.js";
import { lockSnapshot } from "../bridge/resource-locks.js";
import { loadTodoStore } from "../bridge/todo-store.js";
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

/**
 * How many trailing log lines a newly connected console is given.
 *
 * Matches the pane's own 800-line cap: sending more would be discarded by the
 * client on arrival, sending fewer would leave a reload showing less history
 * than the session it replaced.
 */
const LOG_BACKFILL_LINES = 800;

/** Bytes of the log's tail to read for that backfill. */
const LOG_BACKFILL_BYTES = 512 * 1024;

/**
 * The tail of bridge.log, oldest first.
 *
 * Reads a bounded window from the END of the file rather than the whole thing:
 * the log rotates at 10 MB and slurping that into memory to show the last 800
 * lines would be a self-inflicted stall on every console reload.
 */
async function recentLogLines(): Promise<string[]> {
  try {
    const file = nodeHost().bridgeLog.path();
    const handle = await fs.open(file, "r");
    try {
      const { size } = await handle.stat();
      const windowStart = Math.max(0, size - LOG_BACKFILL_BYTES);
      const length = size - windowStart;
      if (length <= 0) return [];
      const buffer = Buffer.alloc(Number(length));
      await handle.read(buffer, 0, Number(length), windowStart);
      const text = buffer.toString("utf8");
      // A non-zero offset almost certainly lands mid-line; drop that fragment
      // rather than emit a half line that reads like a truncated log entry.
      const lines = (windowStart > 0 ? text.slice(text.indexOf("\n") + 1) : text)
        .split(/\r?\n/)
        .filter(line => line.length > 0);
      return lines.slice(-LOG_BACKFILL_LINES);
    } finally {
      await handle.close();
    }
  } catch {
    // No log file yet (first run), or it vanished under a rotation: an empty
    // backfill is the honest answer and the live stream still works.
    return [];
  }
}

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
      // The todo list an AI is working through, as a list rather than a count.
      // `/sessions` has carried `todos: <number>` since todos existed, which
      // tells an operator that work is in flight but never what the work IS —
      // the one question the console could not answer while an agent ran.
      case "/todos": sendJson(res, 200, { ok: true, ...todoView() }); return true;
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
        // Carried over from the 状态 page's own health action, which this
        // endpoint replaced: a bearer gate that silently fails open is worse
        // than no gate, because the operator believes they are covered. The
        // only way to know is to send an anonymous request and require a 401.
        //
        // selfProbe, never fetch: a fetch to our own port parks the connection
        // in undici's keep-alive pool inside this process, and shutdown then
        // destroys a socket whose client handle is still live — on Windows and
        // Node 24 that aborts in libuv and turns a clean stop into a fastfail
        // exit. AGENTS.md records the incident.
        if (authEnabled()) {
          const anonymous = await selfProbe(state.port, `/mcp/${state.routeToken}`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0", id: 1, method: "initialize",
              params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health", version: "1" } },
            }),
          });
          check(
            "auth_gate",
            anonymous.status === 401 ? "ok" : "fail",
            anonymous.status === 401
              ? "已生效：匿名请求被拒（401）"
              : `异常：匿名请求返回 ${anonymous.status || anonymous.body}，预期 401`,
          );
        }
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
      // Read-only tunnel reconnaissance, its own endpoint because producing it
      // spawns the tailscale CLI and may call ngrok's API: the settings page must
      // not wait on that to render. Carries no credential — the authtoken is used
      // server-side and reported only as its source.
      case "/tunnel": sendJson(res, 200, { ok: true, tunnel: await buildTunnelView() }); return true;
      case "/prompt": sendJson(res, 200, { ok: true, prompt: webAiPrompt() }); return true;
      case "/logs/stream": {
        ensureLogStreamWired();
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        // Replay the tail before going live. The stream only ever carried lines
        // written from this moment on, so every console reload showed an empty
        // pane — on a quiet instance it stayed empty indefinitely, and a log
        // file with 21k lines in it looked like a broken page. This backfill is
        // what makes 日志 answer "what just happened", not only "what happens
        // next". Same redaction as the live path: these lines take the same
        // route to the same browser.
        for (const line of await recentLogLines()) {
          res.write(`data: ${JSON.stringify({ line: redactSensitiveText(line) })}\n\n`);
        }
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

/** A todo as `set_todos` validates it: id, title, and one of three states. */
interface TodoView {
  id: string;
  title: string;
  status: string;
}

/** Accept only what set_todos would have written; skip anything else. */
function asTodo(value: unknown): TodoView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = typeof raw.title === "string" ? raw.title : "";
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!id || !title) return undefined;
  return { id, title, status: ["pending", "in_progress", "completed"].includes(status) ? status : "pending" };
}

/**
 * The todo list for the console's 任务 page.
 *
 * Two sources, deliberately not merged: the live MCP session holds what the
 * connected AI is working on right now, while the persisted per-workspace
 * store survives a disconnect. Preferring the live session keeps the page
 * honest while an agent runs; falling back to the store means closing the tab
 * (or a crashed agent — the case that motivated the idle watchdog) leaves the
 * last known plan on screen instead of an empty list.
 *
 * `stale` is that distinction made explicit rather than left for the reader to
 * infer from a timestamp: a list nobody is currently driving is still useful,
 * but it must not look like live progress.
 *
 * The progress line gets the SAME treatment, separately, because the two halves
 * of the stored document age independently. A real report of this: a fresh
 * 任务 list sat under a 23-hour-old 最新进展 from a previous agent, the list
 * badged 实时 and the progress line reading like it had just been sent. The
 * merge that carries lastProgress across a set_todos write is deliberate (it
 * stops concurrent writers clobbering each other's fields), so the fix is to
 * label what was carried over, not to stop carrying it.
 */
function todoView(): Record<string, unknown> {
  const stored = loadTodoStore();
  const session = state.latestSession;
  const live = Array.isArray(session?.todos) ? session.todos : undefined;
  // An empty live list is still an answer ("the agent cleared its plan"), so
  // the fallback tests for a session, not for a non-empty array.
  const source = live !== undefined ? live : stored.todos;
  const todos = (Array.isArray(source) ? source : [])
    .map(asTodo)
    .filter((todo): todo is TodoView => todo !== undefined);
  const counts = { total: todos.length, pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) {
    if (todo.status === "completed") counts.completed += 1;
    else if (todo.status === "in_progress") counts.in_progress += 1;
    else counts.pending += 1;
  }
  // Whose progress line this is. An entry with no sessionId predates the field
  // and therefore cannot belong to the session connected right now.
  const liveSessionId = session
    ? [...state.sessions.entries()].find(([, candidate]) => candidate === session)?.[0]
    : undefined;
  const progressStale = stored.lastProgress
    ? !liveSessionId || stored.lastProgress.sessionId !== liveSessionId
    : false;
  return {
    todos,
    counts,
    stale: live === undefined,
    updated_at: stored.updatedAt,
    last_progress: stored.lastProgress,
    progress_stale: progressStale,
    idle_ms: session ? Math.max(0, Date.now() - session.lastUsed) : null,
  };
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
