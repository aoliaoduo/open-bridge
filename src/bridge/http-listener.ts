/**
 * The loopback listener: the single endpoint every client reaches, over MCP or
 * through the tunnel.
 *
 * It owns host/token routing (including the peer proxy), preflight answers, the
 * bearer gate, the request trace, the two protocol eras' dispatch, the session
 * lookup, the self-verify that runs before any tunnel is published, and the
 * shutdown that drains it. Extracted from lifecycle so the file that decides
 * *when* the instance runs is not also the file that reads sockets.
 */
import { host } from "../host/host.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { classifyInboundRequest } from "@modelcontextprotocol/server";
import { bridgeTokenFromPath, findPeerIn, proxyToPeer } from "../http/peers.js";
import { bridgeAllowedHosts, isAllowedBridgeHost } from "../http/request-policy.js";
import { authorizeRequest } from "../http/auth.js";
import { record, state, type SessionState } from "./state.js";
import { exchangeLine, isNoteworthy, traceId, tracedFormat, tracedMethod, type TracedEra } from "./request-trace.js";
import { root } from "./paths.js";
import { buildServeTitle, clearServeConsoleTitle, installServeConsoleTitle } from "./console-title.js";
import { loadTodoStore } from "./todo-store.js";
import { createMcp, headerValue, modernNodeHandlerOf, sharedEventStore } from "./mcp-endpoint.js";
import { currentExtraRouteHandler, notifyLocalServerReady } from "./route-hooks.js";
import { makeRoomForSession, pruneSessions, startSessionPruneLoop } from "./session-table.js";
import { publishSelf, readablePeerFiles, startRepublishLoop } from "./peer-registry.js";
import { readJsonBody } from "../http/request-body.js";


/** Bind loopback, wire request handling (CORS, caps, sessions) and self-verify. */
/**
 * Reply to a request the bearer gate refused, and record it.
 *
 * Extracted from the request handler: the rejection path is the security
 * boundary, and it is easier to audit on its own than nested three levels
 * deep in the transport setup.
 */
function rejectUnauthorized(
  res: ServerResponse,
  gate: { status: number; reason: string; retryAfterMs?: number; challenge?: string },
  securityHeaders: Record<string, string>,
): void {
  record("bridge", "error", `Unauthenticated request rejected (${gate.reason}).`);
  const headers: Record<string, string> = {
    ...securityHeaders,
    "content-type": "application/json",
    // An OAuth client finds the authorization server through this header, so the
    // gate supplies the spec-shaped challenge (with resource_metadata) when it
    // rejected for OAuth reasons, and the plain bearer challenge otherwise.
    "www-authenticate": gate.challenge ?? 'Bearer realm="open-bridge", error="invalid_token"',
  };
  if (gate.retryAfterMs) headers["retry-after"] = String(Math.ceil(gate.retryAfterMs / 1000));
  if (!res.headersSent) res.writeHead(gate.status, headers);
  res.end(JSON.stringify({
    error: gate.status === 429 ? "Too many failed attempts. Retry later." : "Unauthorized.",
  }));
}

/** Close the loopback listener and clear its pointers (used by failure paths and stop). */
export async function stopLocalServer(): Promise<void> {
  const activeServer = state.server;
  state.server = undefined;
  if (!activeServer) return;
  record("bridge", "progress", "Shutdown started: closing the MCP listener.");
  clearServeConsoleTitle();
  try {
    // Drop idle keep-alive connections immediately so stop()/reload does not
    // wait on Node's keepAliveTimeout; in-flight requests still drain.
    activeServer.closeIdleConnections();
  } catch {
    // best-effort: very old runtimes without closeIdleConnections still close below
  }
  const inflight = state.sessions.size;
  await new Promise<void>(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    // stop() must never hang: server.close() waits for every ACTIVE connection,
    // and a proxied peer SSE stream (peers.ts) is not tracked in state.sessions,
    // so it would keep stop() pending forever and wedge the lifecycle queue.
    // Force-destroy stragglers after a short grace period, then resolve.
    timer = setTimeout(() => {
      // Named, not silent: an operator seeing this line knows a client was cut
      // off rather than that shutdown was slow for no reason.
      record("bridge", "warning", "Shutdown: grace period elapsed, closing connections that had not drained.");
      try { activeServer.closeAllConnections?.(); } catch { /* very old runtimes lack it */ }
      // In the worst case (close still not signalled) resolve shortly after.
      timer = setTimeout(() => { record("bridge", "progress", "Shutdown completed: stragglers closed."); finish(); }, 250);
    }, 1_500);
    timer.unref?.();
    // Announce the wait only when there is something to wait for, so an idle
    // stop stays one line instead of three.
    if (inflight > 0) {
      record("bridge", "progress", `Shutdown: draining ${inflight} open session(s) before exit.`);
    }
    try {
      activeServer.close(() => {
        record("bridge", "progress", inflight > 0 ? "Shutdown: all sessions drained." : "Shutdown completed: listener closed.");
        finish();
      });
    } catch {
      finish();
    }
  });
}
export async function startHttpInternal(): Promise<void> {
  const configuredPort = host().config.get<number>("port", 0);
  // An ephemeral bind must not move on a rebind: the console was loaded from
  // this origin, `runtime.json` advertises this port to the CLI, and the tunnel
  // forwards to it. Port 0 means "any free port", which is fine for the first
  // bind and wrong for the second, so the port we already chose wins.
  const listenPort = configuredPort === 0 && state.boundPort ? state.boundPort : configuredPort;
  state.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Outermost safety net for the WHOLE handler body: an async handler that
    // rejects surfaces as an unhandled rejection, and Node's default for that
    // kills the process — one malformed request line was enough (WHATWG URL
    // throws on targets Node's own HTTP parser accepted: absolute-form with an
    // out-of-range port). The body keeps its original indentation so this diff
    // stays surgical; its inner try/catches are unchanged and still fire first.
    try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const securityHeaders = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    // CORS is safe here because the route token IS the credential: browser-hosted
    // MCP clients could otherwise never call the endpoint cross-origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id, authorization");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    const reject = (status: number, message = "Not found"): void => {
      if (!res.headersSent) res.writeHead(status, { ...securityHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    };
    const reqHost = req.headers.host;
    const configuredDomain = String(host().config.get<string>("ngrokDomain", ""))
      .trim()
      .toLowerCase();
    const allowedHosts = bridgeAllowedHosts(state.port, configuredDomain);
    if (!isAllowedBridgeHost(reqHost, state.port, configuredDomain)) {
      reject(403, "Host is not allowed.");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === `/healthz/${state.routeToken}`) {
      res.writeHead(200, { ...securityHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const wanted = bridgeTokenFromPath(url.pathname);
    if (wanted && wanted.token !== state.routeToken) {
      const peer = await findPeerIn(readablePeerFiles(), wanted.token);
      if (peer) {
        await proxyToPeer(
          peer,
          req,
          res,
          wanted.kind === "mcp" ? `/mcp/${wanted.token}${url.search}` : `/healthz/${wanted.token}`,
        );
        return;
      }
    }
    if (url.pathname !== `/mcp/${state.routeToken}`) {
      // App-shell surfaces (/api, /console) get a chance before the 404.
      const extraRoute = currentExtraRouteHandler();
  if (extraRoute && await extraRoute(req, res, url)) return;
      reject(404);
      return;
    }
    // Optional bearer gate, disabled by default. It runs before the MCP
    // transport so an unauthenticated request never reaches the session table,
    // the event store, or a tool handler. /healthz stays exempt: the tunnel
    // readiness probe and the public-bridge ownership probe both hit it, and it
    // returns nothing but { ok: true }.
    const gate = await authorizeRequest(req, url);
    if (!gate.ok) {
      rejectUnauthorized(res, gate, securityHeaders);
      return;
    }
    // Trace this MCP exchange. `close` fires even when the client disconnects
    // mid-response, which is the case worth recording and the one an
    // `end`-based hook would miss. Everything written is allow-listed or hashed
    // (see request-trace.ts) — the method string comes from a closed set, the
    // session and tool are hashes, and the error is a fingerprint plus a bounded
    // one-liner.
    const exchangeStartedAt = Date.now();
    const headerEra: TracedEra = headerValue(req.headers["mcp-protocol-version"]) ? "modern" : "legacy";
    const methodHint = headerValue(req.headers["mcp-method"]);
    // The modern era names its target in a header; the legacy era names it in
    // `params.name`. Seed from the header and let the body fill the gap below.
    let toolNameHint = headerValue(req.headers["mcp-name"]);
    res.once("close", () => {
      const outcome = {
        method: tracedMethod(methodHint),
        era: headerEra,
        httpStatus: res.statusCode,
        durationMs: Date.now() - exchangeStartedAt,
        // writableFinished is false when the response never completed, which is
        // what a walked-away client looks like from here.
        aborted: !res.writableFinished,
        format: tracedFormat(res.getHeader("content-type")),
        sessionHash: traceId(req.headers["mcp-session-id"]),
        toolHash: traceId(toolNameHint),
      };
      if (!isNoteworthy(outcome)) return;
      record("mcp", outcome.aborted ? "warning" : "progress", exchangeLine(outcome));
    });
    try {
      pruneSessions();
      const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      let session = sessionId ? state.sessions.get(sessionId) : undefined;
      // Size-cap POST bodies before the transport buffers them.
      let parsedBody: unknown;
      if (req.method === "POST") {
        try {
          parsedBody = await readJsonBody(req);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // The client may already be gone (aborted upload): do not write on a
          // destroyed response.
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.writeHead(400, { ...securityHeaders, "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message } }));
          }
          return;
        }
      }
      // Trace the legacy tool name too, so both eras report the same field.
      // Read defensively from an unvalidated body: this is logging, and a
      // malformed shape must not turn into a thrown error on the request path.
      if (!toolNameHint) {
        const body = parsedBody as { method?: unknown; params?: { name?: unknown } } | undefined;
        if (body && typeof body === "object" && body.method === "tools/call" && typeof body.params?.name === "string") {
          toolNameHint = body.params.name;
        }
      }
      // Two protocol eras share this one endpoint, and the request itself
      // decides which one serves it — a client never has to be told, and no
      // configuration selects a "mode".
      //
      //  - 2026-07-28 (modern): a per-request envelope in `params._meta` plus
      //    `MCP-Protocol-Version` / `MCP-Method` headers. Stateless: no session
      //    id is minted or required. Served by the v2 handler.
      //  - 2025-era (legacy): an `initialize` handshake and a stateful session.
      //    Served by the session path below, unchanged.
      //
      // The classifier is the v2 SDK's own, so the boundary between eras is
      // whatever the spec says it is rather than our guess at it. Anything that
      // is neither (a malformed modern envelope) is handed to the v2 handler so
      // the client receives the spec's own error, with its `data.envelope`.
      let era: "modern" | "legacy" = "legacy";
      const classification = classifyInboundRequest({
        httpMethod: req.method ?? "GET",
        protocolVersionHeader: headerValue(req.headers["mcp-protocol-version"]),
        mcpMethodHeader: headerValue(req.headers["mcp-method"]),
        mcpNameHeader: headerValue(req.headers["mcp-name"]),
        body: parsedBody,
      });
      if (classification.kind !== "legacy") era = "modern";

      if (era === "modern") {
        try {
          await modernNodeHandlerOf()(req, res, parsedBody);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          record("bridge", "error", `Modern MCP handler failed: ${message}`);
          if (!res.headersSent) res.writeHead(500, { ...securityHeaders, "content-type": "application/json" });
          if (!res.writableEnded) res.end(JSON.stringify({ error: message }));
        }
        return;
      }

      if (!session) {
        if (!makeRoomForSession()) {
          if (!res.headersSent) res.writeHead(503, { ...securityHeaders, "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Bridge session capacity reached. Close an existing MCP session and retry." }));
          return;
        }
        // Only an initialize mints a session, and only then is there a client
        // name to show: the console prints "cursor/0.42 · 空闲 2 分钟" instead of
        // a bare count. onsessioninitialized below never sees the parsed body,
        // so the label is handed over here — same call, same tick.
        pendingClientLabel = clientLabelFrom(parsedBody);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomBytes(16).toString("hex"),
          enableDnsRebindingProtection: true,
          allowedHosts,
          eventStore: sharedEventStore,
          // SSE keep-alive comment frames every 15 s so proxies (ngrok edge
          // included) do not reap idle streams; retryInterval hints clients to
          // reconnect after 2 s (ShunCode parity).
          keepAliveMs: 15_000,
          retryInterval: 2_000,
          onsessioninitialized: id => {
            state.sessions.set(id, newSession);
            pruneSessions();
            // Keep the panel's session count live instead of ≤30 s stale.
            host().ui.update();
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            state.sessions.delete(transport.sessionId);
            host().ui.update();
          }
        };
        const persisted = loadTodoStore();
        const persistedTodos = Array.isArray(persisted.todos) ? persisted.todos.map(t => (t !== null && typeof t === "object" ? { ...t as object } : t)) : [];
        const newSession: SessionState = { transport, lastUsed: Date.now(), connectedAt: Date.now(), calls: 0, client: pendingClientLabel, todos: persistedTodos, activeRequests: 0 };
        session = newSession;
        const mcpServer = createMcp(newSession);
        newSession.mcp = mcpServer as unknown as NonNullable<SessionState["mcp"]>;
        await mcpServer.connect(transport);
      }
      session.lastUsed = Date.now();
      state.latestSession = session;
      session.activeRequests += 1;
      try {
        await session.transport.handleRequest(req, res, parsedBody);
      } finally {
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        session.lastUsed = Date.now();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) res.writeHead(500, { ...securityHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    } catch (error) {
      // See the try above: turns "process dies on a stray request" into a 400.
      const message = error instanceof Error ? error.message : String(error);
      record("bridge", "error", `Request handler failed: ${message}`);
      try {
        if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
        if (!res.writableEnded) res.end(JSON.stringify({ error: message }));
      } catch { /* the socket is already gone */ }
    }
  });
  // Do not race the client's keep-alive timer. Node destroys an idle connection
  // once keepAliveTimeout elapses (5 s by default), and a browser or pool that
  // reuses that socket at the same instant sees ECONNRESET while writing the
  // request — which is how a rotation failed on the busier CI runner while
  // passing locally. The client, which decides for itself when to drop an idle
  // socket, should always be the one to close it; leftovers are closed
  // explicitly by stopLocalServer(). Node requires headersTimeout to exceed
  // keepAliveTimeout.
  state.server.keepAliveTimeout = 60_000;
  state.server.headersTimeout = 66_000;
  await new Promise<void>((resolve, reject) => {
    state.server!.once("error", reject);
    state.server!.listen(listenPort, "127.0.0.1", () => resolve());
  });
  state.port = (state.server.address() as { port: number }).port;
  state.boundPort = state.port;
  // Name this window after the instance it is running. Children share the console
  // (that is how closing the window stops the tunnel too), and cmd.exe/npm write
  // their own titles into it — see console-title.ts. cosmetic, but it is the
  // operator's only clue about which workspace this window is serving.
  installServeConsoleTitle(buildServeTitle(path.basename(root()), state.port));
  notifyLocalServerReady();
  // Post-listen backstop: without these, a runtime failure (or unexpected
  // close) used to be swallowed after the one-shot listen error handler was
  // consumed, leaving the panel "running" on a dead port.
  const listeningServer = state.server;
  listeningServer.on("error", (error: Error) => {
    if (state.server !== listeningServer) return;
    record("bridge", "error", `HTTP server error: ${error.message}`);
  });
  listeningServer.on("close", () => {
    if (state.server !== listeningServer) return; // deliberate stop cleaned up already
    state.server = undefined;
    state.port = 0;
    record("bridge", "error", "HTTP server closed unexpectedly; the Bridge is offline. Start it again from the panel.");
    host().ui.refresh();
  });
  startSessionPruneLoop();
  await publishSelf();
  if (state.peersRegistered) startRepublishLoop();
  // Self-verify before publishing any tunnel: fail fast on a broken listener
  // instead of after the tunnel is up.
  const health = await fetch(`http://127.0.0.1:${state.port}/healthz/${state.routeToken}`, { signal: AbortSignal.timeout(3_000) })
    .then(async response => {
      if (!response.ok) return `HTTP ${response.status}`;
      const payload = await response.json().catch(() => undefined) as { ok?: unknown } | undefined;
      return payload?.ok === true ? undefined : "healthz did not confirm readiness";
    })
    .catch(error => error instanceof Error ? error.message : String(error));
  if (health) throw new Error(`Local Bridge health check failed: ${health}`);
}

/** Ensure one slot is free before creating a session; false when all are busy. */
/**
 * clientInfo from the initialize request that is about to create a session.
 *
 * The session object is built inside `onsessioninitialized`, which never sees
 * the parsed body, so the label travels through this variable. Single-threaded
 * request handling makes that safe: it is written and consumed within one
 * handleRequest() call.
 */
let pendingClientLabel: string | undefined;
function clientLabelFrom(body: unknown): string | undefined {
  const info = (body as { params?: { clientInfo?: { name?: unknown; version?: unknown } } } | undefined)
    ?.params?.clientInfo;
  if (!info || typeof info.name !== "string" || !info.name) return undefined;
  return typeof info.version === "string" && info.version ? `${info.name}/${info.version}` : info.name;
}
