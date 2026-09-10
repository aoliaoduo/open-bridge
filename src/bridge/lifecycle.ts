import { host } from "../host/host.js";
import * as fsSync from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { StreamableHTTPServerTransport, type EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS } from "../mcp/tool-definitions.js";
import { listToolDefinitions } from "./tool-catalog.js";
import {
  bridgeTokenFromPath, findPeerForToken, healthCheckUrl, probePublicBridge,
  proxyToPeer, publishPeer, withdrawPeer,
} from "../http/peers.js";
import { bridgeAllowedHosts, isAllowedBridgeHost, validateNgrokDomain } from "../http/request-policy.js";
import { authorizeRequest, authEnabled } from "../http/auth.js";
import { isDeterministicNetworkFailure } from "../network/net-failure.js";
import {
  MAX_SESSIONS, RECONNECT_DELAYS_MS, ROUTE_TOKEN_KEY,
  asStructuredContent, clientMcpUrl, record, state, text, redactedPublicUrl,
  type SessionState,
} from "./state.js";
import { root, workspaceStateSuffix } from "./paths.js";
import { invoke } from "./dispatcher.js";
import { loadTodoStore } from "./todo-store.js";
import { loadUsageStats, persistUsageStats } from "./usage-store.js";
import { cancelAllPendingRestarts, pruneCommands, terminateProcess } from "./processes.js";

/**
 * Extra route handler hook for the app shell: /api and /console live outside
 * the core (they are the standalone host's surfaces, not the Bridge's). The
 * handler returns true when it answered the request.
 */
export type ExtraRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean>;

let extraRouteHandler: ExtraRouteHandler | undefined;

export function setExtraRouteHandler(handler: ExtraRouteHandler | undefined): void {
  extraRouteHandler = handler;
}

/** Serialize bridge lifecycle transitions so start/stop/rotate cannot overlap. */
export function enqueueLifecycle(task: () => Promise<void>): Promise<void> {
  const next = state.lifecycleTail.then(task, task);
  state.lifecycleTail = next.catch(() => undefined);
  return next;
}

// --- Lifecycle constants (ShunCode-derived hardening values) ---
/** Hard cap on a single MCP request body; larger uploads are destroyed mid-stream. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** Idle MCP sessions are reclaimed after this long without activity. */
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** How often the idle-session reclamation sweep runs. */
const SESSION_PRUNE_INTERVAL_MS = 60_000;
/** Consecutive deterministic (DNS/refused/TLS) health failures before aborting startup early. */
const PUBLIC_HEALTH_DETERMINISTIC_FAILURE_LIMIT = 3;
/** SSE events retained for stream resumption (Last-Event-ID replay). */
const SESSION_EVENT_STORE_LIMIT = 512;

/**
 * Bounded in-memory event store enabling MCP stream resumability: when a
 * client's SSE connection drops mid-response, its reconnect replays everything
 * after the last event it saw instead of losing the response. One store is
 * shared by all sessions — replay filters by streamId — and the FIFO is
 * capped so memory stays bounded.
 */
class BoundedInMemoryEventStore implements EventStore {
  private readonly events = new Map<string, { streamId: string; message: unknown }>();
  private readonly order: string[] = [];
  private sequence = 0;

  async storeEvent(streamId: string, message: unknown): Promise<string> {
    const eventId = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${randomBytes(8).toString("hex")}`;
    this.events.set(eventId, { streamId, message });
    this.order.push(eventId);
    while (this.order.length > SESSION_EVENT_STORE_LIMIT) {
      const oldest = this.order.shift();
      if (oldest) this.events.delete(oldest);
    }
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: unknown) => Promise<void> },
  ): Promise<string> {
    const previous = this.events.get(lastEventId);
    if (!previous) return "";
    let found = false;
    for (const eventId of this.order) {
      if (eventId === lastEventId) {
        found = true;
        continue;
      }
      if (!found) continue;
      const event = this.events.get(eventId);
      if (event?.streamId === previous.streamId) {
        await send(eventId, event.message);
      }
    }
    return previous.streamId;
  }
}

const sharedEventStore = new BoundedInMemoryEventStore();

/**
 * Read (and size-cap) a POST body before handing the parsed JSON to the MCP
 * transport: without this, one runaway upload would be buffered without bound.
 * On overflow the stream keeps draining (so the socket can answer 400) but no
 * further bytes are retained.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      if (overflowed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BYTES) {
        overflowed = true;
        chunks.length = 0;
        reject(new Error(`MCP request body exceeds ${MAX_REQUEST_BYTES} bytes.`));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (overflowed) return;
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("MCP request body is not valid JSON."));
      }
    });
    req.on("error", reject);
    // A client that disconnects mid-upload does not always emit 'error'; on
    // several Node paths only 'aborted'/'close' fire. Without these listeners
    // the promise would never settle and the request handler would leak.
    req.on("aborted", () => reject(new Error("MCP request was aborted by the client.")));
    req.on("close", () => {
      if (!req.complete) reject(new Error("MCP request connection closed before the body was received."));
    });
  });
}

/** Kill the tunnel and everything it spawned; a bare kill() leaves orphans holding the domain on Windows. */
function killTunnelTree(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 3_000,
        windowsHide: true,
      });
      return;
    } catch {
      // taskkill can refuse on an already-dead pid; fall through to kill().
    }
  }
  try { child.kill(); } catch {}
}

/** A ngrok startup failure (spawn error), distinct from a health-check timeout. */
class NgrokSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NgrokSpawnError";
  }
}

/**
 * Wait for the tunnel's public health endpoint while racing ngrok's own spawn
 * 'error': when the executable is missing or not runnable the failure is known
 * in milliseconds, but the health check against ngrok's edge would otherwise
 * burn the whole 20 s budget first and then report a misleading "health check
 * failed" instead of the real cause.
 */
async function waitForTunnelReady(healthUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const controller = new AbortController();
  let rejectSpawn: ((error: Error) => void) | undefined;
  const spawnError = new Promise<never>((_, reject) => { rejectSpawn = reject; });
  const onSpawnError = (error: Error): void => {
    rejectSpawn?.(new NgrokSpawnError(error.message));
  };
  // Mark both racers as handled so the loser can never surface as an
  // unhandled rejection after the winner settles.
  void spawnError.catch(() => undefined);
  child.once("error", onSpawnError);
  const health = waitForPublicHealth(healthUrl, controller.signal);
  void health.catch(() => undefined);
  try {
    await Promise.race([health, spawnError]);
  } finally {
    controller.abort();
    child.off("error", onSpawnError);
  }
}

// The advertised catalog (toolProfile + host-capability filters) lives in
// tool-catalog.ts so tools/list and the status surface's tool_count agree.

/**
 * Project instruction files (AGENTS.md / CLAUDE.md — DevSpace two-layer model,
 * root layer only): injected into server instructions so every session sees
 * the project's conventions. Bounded; absent files are simply skipped.
 */
function projectInstructionSuffix(): string {
  const parts: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const raw = fsSync.readFileSync(path.join(root(), name), "utf8");
      if (!raw.trim()) continue;
      parts.push(`### ${name}\n${raw.slice(0, 8_000)}${raw.length > 8_000 ? "\n…[truncated]" : ""}`);
    } catch {
      // Missing or unreadable file: nothing to inject.
    }
  }
  return parts.length ? `\n\n# Project instructions\n${parts.join("\n\n")}` : "";
}

function createMcp(session: SessionState): Server {
  const serverVersion = host().version();
  const mcp = new Server(
    { name: "open-bridge", version: serverVersion },
    {
      capabilities: { tools: {}, logging: {} },
      instructions:
        "You are connected to a local project workspace through the standalone Open Bridge. Relative paths, default command cwd, and project services always use that workspace. Other directories can be accessed only with explicit absolute paths; never let them change the workspace anchor. When starting work on an unfamiliar project, call workspace_brief once for orientation instead of exploring blindly. Use file tools for project management, run_command/start_process for commands, and wait_process/interact_with_process/restart_process/set_process_policy for supervised long-running services. Use check_port/check_http for readiness and save_service/list_services/start_service/stop_service/restart_service/delete_service/start_all_services/stop_all_services/service_status for reusable project orchestration. Use set_todos for multi-step work and report_progress for transient updates. Use batch to combine multiple tool calls in a single roundtrip. After finishing a batch of related edits, call review_changes so the user can see the full cumulative change set."
        + projectInstructionSuffix(),
    },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listToolDefinitions() }));
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const name = req.params.name;
    const startedAt = Date.now();
    try {
      session.lastUsed = Date.now();
      const result = await invoke(name, (req.params.arguments ?? {}) as Record<string, unknown>, session);
      state.usage.successes += 1;
      persistUsageStats();
      // apply_patch results carry per-file changes: surface them in the
      // activity message and as structured data for the panel's diff badge.
      const changeList = (result as { changes?: Array<{ path?: unknown; additions?: unknown; deletions?: unknown }> } | null)?.changes;
      const activityChanges = Array.isArray(changeList)
        ? changeList
            .filter(c => c && typeof c === "object")
            .map(c => ({
              path: String((c as { path?: unknown }).path ?? ""),
              additions: Number((c as { additions?: unknown }).additions) || 0,
              deletions: Number((c as { deletions?: unknown }).deletions) || 0,
            }))
            .filter(c => c.path)
        : undefined;
      let message = `Completed in ${Date.now() - startedAt} ms.`;
      if (activityChanges?.length) {
        const summary = activityChanges.map(c => `${c.path} +${c.additions}/−${c.deletions}`).join(", ");
        message = `Completed in ${Date.now() - startedAt} ms · ${summary}`;
      }
      record(name, "completed", message, undefined, activityChanges ? { changes: activityChanges } : undefined);
      // Tools declaring an outputSchema also return structuredContent so clients
      // can consume typed data directly; the text block stays for compatibility.
      const definition = (TOOL_DEFINITIONS as ReadonlyArray<{ name: string; outputSchema?: unknown }>)
        .find(tool => tool.name === name);
      if (definition?.outputSchema) return { ...text(result), structuredContent: asStructuredContent(result) };
      return text(result);
    } catch (e) {
      state.usage.failures += 1;
      persistUsageStats();
      record(name, "error", `Failed in ${Date.now() - startedAt} ms.`);
      return {
        isError: true,
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      };
    }
  });
  return mcp;
}

async function waitForPublicHealth(url: string, abort?: AbortSignal): Promise<void> {
  const timeoutMs = host().config.get<number>("publicHealthTimeoutMs", 20_000);
  const until = Date.now() + timeoutMs;
  let last = "No response";
  let deterministicFailures = 0;
  while (Date.now() < until) {
    if (abort?.aborted) throw new Error("Startup aborted before the public health check completed.");
    // Combine the per-attempt cap with the caller's cancellation where the
    // runtime supports it (AbortSignal.any needs Node >= 20.3); on older hosts
    // the loop-top abort check above is the fallback.
    const attemptSignal = abort && typeof AbortSignal.any === "function" ? AbortSignal.any([AbortSignal.timeout(4_000), abort]) : AbortSignal.timeout(4_000);
    try {
      const response = await fetch(url, {
        headers: { "ngrok-skip-browser-warning": "true" },
        signal: attemptSignal,
      });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
      deterministicFailures = 0;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      // DNS/refused/TLS failures cannot heal by waiting; abort early instead of
      // burning the whole budget (the full timeout stays for flaky networks).
      if (isDeterministicNetworkFailure(e)) {
        deterministicFailures += 1;
        if (deterministicFailures >= PUBLIC_HEALTH_DETERMINISTIC_FAILURE_LIMIT) {
          throw new Error(
            `Public health check aborted early: the network failure is deterministic (${last}). ` +
            "If this machine reaches the internet through a proxy, ngrok must be able to connect directly (free plan rejects proxies, see openBridge.ngrokUseHttpProxy).",
          );
        }
      } else {
        deterministicFailures = 0;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error(`Public health check failed after ${timeoutMs} ms: ${last}`);
}

function pruneSessions(): void {
  // Idle reclamation: a client that walked away keeps its transport (and todo
  // state) alive forever otherwise. Busy sessions are never reclaimed.
  const idleCutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
  let prunedAny = false;
  for (const [id, session] of state.sessions) {
    if (session.activeRequests === 0 && session.lastUsed < idleCutoff) {
      state.sessions.delete(id);
      void session.transport.close();
      prunedAny = true;
    }
  }
  // Capacity: evict the least-recently-used idle sessions beyond MAX_SESSIONS.
  while (state.sessions.size > MAX_SESSIONS) {
    const evictable = [...state.sessions.entries()]
      .filter(([, session]) => session.activeRequests === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!evictable) break; // every session is mid-request; leave them alone
    state.sessions.delete(evictable[0]);
    void evictable[1].transport.close();
    prunedAny = true;
  }
  if (prunedAny) host().ui.update();
}

/** Ensure one slot is free before creating a session; false when all are busy. */
function makeRoomForSession(): boolean {
  if (state.sessions.size < MAX_SESSIONS) return true;
  const evictable = [...state.sessions.entries()]
    .filter(([, session]) => session.activeRequests === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
  if (!evictable) return false;
  state.sessions.delete(evictable[0]);
  void evictable[1].transport.close();
  return true;
}

function startSessionPruneLoop(): void {
  if (state.sessionPruneTimer) return;
  state.sessionPruneTimer = setInterval(() => {
    try { pruneSessions(); } catch { /* best-effort sweep */ }
    // Retire finished commands on the same 60 s sweep: pruneCommands used to
    // run only when a NEW run_command/get_process_snapshot came in, so a
    // long-idle Bridge kept every finished command's buffers (3 x 32 MiB)
    // and its %TEMP% capture file alive indefinitely.
    try { pruneCommands(); } catch { /* best-effort sweep */ }
  }, SESSION_PRUNE_INTERVAL_MS);
}

function stopSessionPruneLoop(): void {
  if (state.sessionPruneTimer) clearInterval(state.sessionPruneTimer);
  state.sessionPruneTimer = undefined;
}

/**
 * Reconnect the tunnel WITHOUT tearing down the local server: all MCP sessions,
 * todo state and managed processes survive a tunnel crash. A generation guard
 * invalidates timers left behind by a stop/restart that happened in between.
 */
function scheduleReconnect(domain: string, generation: number): void {
  if (state.stopping || generation !== state.tunnelGeneration) return;
  if (!state.server) return; // local side is gone; a reconnect has nothing to attach to
  if (state.tunnelRole === "blocked") return; // another window owns the domain; watcher handles it
  if (!host().config.get<boolean>("autoReconnect", true)) {
    record("ngrok", "progress", "Tunnel exited; autoReconnect is off — the Bridge stays local-only.");
    // With no reconnect the published https URL is dead; clear it so copy and
    // status fall back to the live loopback URL instead of a vanished tunnel.
    state.tunnelRole = "none";
    state.tunnelUrl = "";
    host().ui.refresh();
    return;
  }
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 60_000;
  state.reconnectAttempt += 1;
  record("ngrok", "progress", `Tunnel exited; local Bridge stays up for live sessions. Reconnecting in ${Math.round(delay / 1000)} s.`);
  state.reconnectTimer = setTimeout(() => {
    // Clear the handle when the timer fires: a stale (already-fired) handle
    // made "is a reconnect pending?" unanswerable for startInternal's retry
    // path below.
    state.reconnectTimer = undefined;
    void enqueueLifecycle(async () => {
      if (generation !== state.tunnelGeneration || !state.server) return;
      await startTunnelInternal(generation);
    }).catch(e => {
      const message = e instanceof Error ? e.message : String(e);
      record("ngrok", "error", message);
      // A missing domain or a failed spawn is deterministic — retrying cannot
      // heal it. A spawn failure has already reverted to local-only, so do not
      // arm an endless reconnect loop that can never succeed.
      if (message.includes("ngrokDomain") || e instanceof NgrokSpawnError) return;
      scheduleReconnect(domain, generation);
    });
  }, delay);
}

// Windows share one public tunnel: each instance advertises its token and loopback port,
// and whichever owns ngrok forwards requests addressed to a peer token.
function peersFile(): string {
  const storage = host().storageDir();
  return storage ? path.join(storage, "bridge-peers.json") : "";
}

async function publishSelf(): Promise<void> {
  const file = peersFile();
  if (!file || !state.routeToken || !state.port) return;
  try {
    await publishPeer(file, {
      token: state.routeToken,
      port: state.port,
      pid: process.pid,
      root: state.activeWorkspaceRoot,
      at: Date.now(),
    });
    state.peersRegistered = true;
  } catch (error) {
    record("bridge", "error", `Peer registry write failed: ${String(error)}`);
  }
}

async function withdrawSelf(): Promise<void> {
  const file = peersFile();
  if (!file || !state.routeToken || !state.peersRegistered) return;
  state.peersRegistered = false;
  try {
    await withdrawPeer(file, state.routeToken);
  } catch {}
}

async function adoptSharedTunnel(domain: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await healthCheckUrl(`https://${domain}/healthz/${state.routeToken}`, 1_000)) {
      await watchPublicDomain(domain);
      return true;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
  return false;
}

function stopPublicWatch(): void {
  if (state.publicWatchTimer) clearInterval(state.publicWatchTimer);
  state.publicWatchTimer = undefined;
}

function stopRepublishLoop(): void {
  if (state.rePublishTimer) clearInterval(state.rePublishTimer);
  state.rePublishTimer = undefined;
}

/**
 * Re-assert our peer registry entry periodically. The shared file is a plain
 * read-merge-write JSON blob: two windows publishing concurrently can lose a
 * row (last writer wins), which would leave the loser unreachable through the
 * shared tunnel until it republishes. A 30 s re-publish heals that quickly.
 */
function startRepublishLoop(): void {
  stopRepublishLoop();
  state.rePublishTimer = setInterval(() => { void publishSelf(); }, 30_000);
}

function startPublicWatch(domain: string): void {
  stopPublicWatch();
  state.publicWatchTimer = setInterval(() => {
    void watchPublicDomain(domain).catch(error => record("ngrok", "error", String(error)));
  }, 10_000);
}

async function watchPublicDomain(domain: string): Promise<void> {
  if (await healthCheckUrl(`https://${domain}/healthz/${state.routeToken}`, 4_000)) {
    state.missingPublicRounds = 0;
    if (state.tunnelRole === "follower") return;
    state.tunnelRole = "follower";
    // Routed through a peer tunnel again: a future tunnel exit should start
    // reconnecting at the fast end of the backoff curve, not at the 60 s cap
    // left over from the failed attempts that led here.
    state.reconnectAttempt = 0;
    state.tunnelUrl = `https://${domain}/mcp/${state.routeToken}`;
    record("bridge", "completed", `Published through a peer tunnel: ${redactedPublicUrl(state.tunnelUrl)}`);
    host().ui.refresh();
    return;
  }
  if ((await probePublicBridge(domain, state.routeToken)) !== "free") return;
  state.missingPublicRounds += 1;
  if (state.missingPublicRounds < 2) return;
  state.missingPublicRounds = 0;
  stopPublicWatch();
  record("ngrok", "progress", "Public domain is free again; this window will claim it.");
  await enqueueLifecycle(async () => {
    await stopInternal(false);
    await startInternal();
  });
}

/** Close the loopback listener and clear its pointers (used by failure paths and stop). */
async function stopLocalServer(): Promise<void> {
  const activeServer = state.server;
  state.server = undefined;
  if (!activeServer) return;
  try {
    // Drop idle keep-alive connections immediately so stop()/reload does not
    // wait on Node's keepAliveTimeout; in-flight requests still drain.
    activeServer.closeIdleConnections();
  } catch {
    // best-effort: very old runtimes without closeIdleConnections still close below
  }
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
      try { activeServer.closeAllConnections?.(); } catch {}
      // In the worst case (close still not signalled) resolve shortly after.
      timer = setTimeout(finish, 250);
    }, 1_500);
    timer.unref?.();
    try {
      activeServer.close(() => finish());
    } catch {
      finish();
    }
  });
}

export async function startInternal(): Promise<void> {
  if (state.server) {
    // The local server is up: Start is normally a no-op. But after the tunnel
    // gave up (a deterministic spawn failure stops the reconnect chain for
    // good), a Start click should RETRY the tunnel instead of answering
    // "already running" while the public URL stays dead and unreachable —
    // previously the only recovery was Stop + Start.
    const wantsTunnel = host().config.get<string>("tunnelProvider", "ngrok") === "ngrok";
    if (wantsTunnel && state.tunnelRole === "none" && !state.tunnel && !state.reconnectTimer) {
      state.tunnelGeneration += 1; // invalidate anything stale from the failed chain
      await startTunnelInternal(state.tunnelGeneration);
      host().ui.refresh();
      return;
    }
    host().notify("info", "Open Bridge is already running.");
    return;
  }
  await loadRouteToken();
  try {
    await startHttpInternal();
  } catch (error) {
    // Nothing is listening: a half-started server would make every retry
    // answer "already running", so tear the local side fully down.
    const message = error instanceof Error ? error.message : String(error);
    await stopInternal(false);
    record("bridge", "error", `Start failed: ${message}`);
    throw error;
  }
  // A tunnel failure must NOT take the healthy local server down with it —
  // that is exactly what the reconnect path already does (keep the server and
  // live MCP sessions, drop only the tunnel). startTunnelInternal clears
  // tunnelUrl on every failure path, the panel falls back to the loopback
  // URL, and the Start-retry branch above re-arms the tunnel once the cause is
  // fixed (bad ngrok path, network down at boot, domain still held by a stale
  // ngrok, ...). Only a failure of the local server itself is fatal.
  let tunnelError: string | undefined;
  try {
    await startTunnelInternal(state.tunnelGeneration);
  } catch (error) {
    tunnelError = error instanceof Error ? error.message : String(error);
    record("bridge", "error", `Tunnel failed; local Bridge stays up: ${tunnelError}`);
  }
  record("bridge", "completed", `Started: ${redactedPublicUrl(clientMcpUrl())}`);
  host().ui.refresh();
  if (tunnelError) {
    host().notify("warn", 
      `Open Bridge 已在本地启动，但隧道发布失败：${tunnelError} 本地 URL 仍可用；修复后点 Start 即可重试隧道。`,
    );
    return;
  }
  host().notify("info", "Open Bridge 已启动。请从控制面板复制 MCP URL。");
  host().notify("warn", "Treat this URL as a secret: it grants workspace access.");
}

/** Bind loopback, wire request handling (CORS, caps, sessions) and self-verify. */
async function startHttpInternal(): Promise<void> {
  const configuredPort = host().config.get<number>("port", 0);
  // An ephemeral bind must not move on a rebind: the console was loaded from
  // this origin, `runtime.json` advertises this port to the CLI, and the tunnel
  // forwards to it. Port 0 means "any free port", which is fine for the first
  // bind and wrong for the second, so the port we already chose wins.
  const listenPort = configuredPort === 0 && state.boundPort ? state.boundPort : configuredPort;
  state.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      const file = peersFile();
      const peer = file ? await findPeerForToken(file, wanted.token) : undefined;
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
      if (extraRouteHandler && await extraRouteHandler(req, res, url)) return;
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
      record("bridge", "error", `Unauthenticated request rejected (${gate.reason}).`);
      const headers: Record<string, string> = {
        ...securityHeaders,
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="open-bridge", error="invalid_token"',
      };
      if (gate.retryAfterMs) headers["retry-after"] = String(Math.ceil(gate.retryAfterMs / 1000));
      if (!res.headersSent) res.writeHead(gate.status, headers);
      res.end(JSON.stringify({
        error: gate.status === 429 ? "Too many failed attempts. Retry later." : "Unauthorized.",
      }));
      return;
    }
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
      if (!session) {
        if (!makeRoomForSession()) {
          if (!res.headersSent) res.writeHead(503, { ...securityHeaders, "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Bridge session capacity reached. Close an existing MCP session and retry." }));
          return;
        }
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
        const newSession: SessionState = { transport, lastUsed: Date.now(), todos: persistedTodos, activeRequests: 0 };
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
  });
  await new Promise<void>((resolve, reject) => {
    state.server!.once("error", reject);
    state.server!.listen(listenPort, "127.0.0.1", () => resolve());
  });
  state.port = (state.server.address() as { port: number }).port;
  state.boundPort = state.port;
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

/**
 * Drop the optimistic https URL and surface the live loopback URL instead.
 * Failure paths that keep the local server alive must never leave the panel
 * advertising a dead public endpoint.
 */
function revertToLocalUrl(): void {
  state.tunnelUrl = "";
  host().ui.refresh();
}

/**
 * Owns everything tunnel-shaped. Runs on every start AND on in-place
 * reconnects; the generation guard makes stale invocations no-ops.
 */
async function startTunnelInternal(generation: number): Promise<void> {
  if (generation !== state.tunnelGeneration || !state.server) return;
  const provider = host().config.get<string>("tunnelProvider", "ngrok");
  state.tunnelUrl = "";
  if (provider !== "ngrok") {
    state.tunnelRole = "none";
    return;
  }
  const configuredDomain = host().config.get<string>("ngrokDomain", "");
  if (!configuredDomain?.trim()) {
    throw new Error("Set openBridge.ngrokDomain first.");
  }
  const domain = validateNgrokDomain(configuredDomain);
  if ((await probePublicBridge(domain, state.routeToken)) !== "free") {
    state.tunnelRole = "blocked";
    startPublicWatch(domain);
    record(
      "ngrok",
      "completed",
      "Public domain belongs to another window; this Bridge stays local until that tunnel routes it.",
    );
    await adoptSharedTunnel(domain);
    return;
  }
  state.tunnelRole = "owner";
  const tunnelChild = spawnTunnel(domain, generation);
  state.tunnelUrl = `https://${domain}/mcp/${state.routeToken}`;
  try {
    await waitForTunnelReady(`https://${domain}/healthz/${state.routeToken}`, tunnelChild);
    state.reconnectAttempt = 0;
  } catch (error) {
    if (error instanceof NgrokSpawnError) {
      // ngrok never bound the domain (missing executable, EACCES, ...). This is
      // deterministic: surface the real cause right away instead of after the
      // public-health budget, and stay local-only. The error type is preserved
      // (NOT wrapped into a plain Error) so scheduleReconnect's instanceof
      // guard can recognize it and stop arming reconnects that can never
      // succeed — the old wrap turned that guard into dead code and produced
      // an endless 60 s spawn-retry loop.
      state.tunnelRole = "none";
      killTunnelTree(state.tunnel);
      state.tunnel = undefined;
      revertToLocalUrl();
      throw new NgrokSpawnError(
        `${error.message} · 检查 openBridge.ngrokExecutable（未安装或路径不对请修正后重试；ERR_NGROK_9009 需关闭 openBridge.ngrokUseHttpProxy）。`,
      );
    }
    if ((await probePublicBridge(domain, state.routeToken)) !== "free") {
      state.tunnelRole = "blocked";
      startPublicWatch(domain);
      revertToLocalUrl();
      record("ngrok", "progress", "Domain was claimed mid-start; staying local and watching for a route.");
    } else {
      state.tunnelRole = "none";
      killTunnelTree(state.tunnel);
      state.tunnel = undefined;
      // Revert the optimistic https URL (the panel must not advertise an
      // endpoint no tunnel answers) and DO NOT bump tunnelGeneration: the old
      // bump invalidated every future reconnect armed with the current
      // generation, so one transient failure (e.g. DNS still down right after
      // waking from sleep) permanently stopped all self-healing. The exit
      // handler is already neutralized by clearing state.tunnel above.
      revertToLocalUrl();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} · 若域名被上一会话遗留的 ngrok 占用，请在终端执行 taskkill /IM ngrok.exe /F 后重新 Start。`,
      );
    }
  }
}

/**
 * ngrok Free rejects agents that connect through an HTTP(S) proxy
 * (ERR_NGROK_9009). Inheriting the environment is the long-standing behaviour
 * and keeps working setups untouched; opt-out strips proxy variables so ngrok
 * connects directly.
 */
function ngrokProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const useProxy = host().config.get<boolean>("ngrokUseHttpProxy", true);
  if (!useProxy) {
    for (const key of Object.keys(env)) {
      if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key];
    }
  }
  return env;
}

function spawnTunnel(domain: string, generation: number): ChildProcessWithoutNullStreams {
  // An empty stored value (the page allows clearing it back to "auto") must
  // fall back to the PATH binary instead of spawning "".
  const exe = String(host().config.get<string>("ngrokExecutable", "ngrok") ?? "").trim() || "ngrok";
  const child: ChildProcessWithoutNullStreams = state.tunnel = spawn(
    exe,
    ["http", String(state.port), "--url", `https://${domain}`, "--log", "stdout"],
    { windowsHide: true, env: ngrokProcessEnvironment() },
  );
  child.stdout.on("data", d => {
    try {
      host().log(`[ngrok] ${d.toString().trim()}`);
    } catch {}
  });
  child.stderr.on("data", d => {
    try {
      host().log(`[ngrok] ${d.toString().trim()}`);
    } catch {}
  });
  child.once("error", e => {
    if (state.tunnel !== child) return;
    state.tunnel = undefined;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      record("ngrok", "error", `ngrok executable not found (${exe}). Fix openBridge.ngrokExecutable.`);
    } else {
      record("ngrok", "error", `ngrok failed: ${e.message}`);
    }
    host().notify("error", `ngrok failed: ${e.message}`);
    // Every spawn failure (missing executable, EACCES, EINVAL, ...) is
    // deterministic: retrying cannot heal it. Revert the optimistic public
    // URL/role so the panel does not advertise a dead https endpoint, and do
    // NOT arm a reconnect here — scheduleReconnect's catch recognizes the
    // NgrokSpawnError thrown by waitForTunnelReady and stops the chain. The
    // old fallback call to scheduleReconnect bypassed that guard and produced
    // an endless spawn-retry loop.
    state.tunnelRole = "none";
    state.tunnelUrl = "";
    host().ui.refresh();
  });
  child.once("exit", () => {
    if (state.tunnel !== child) return;
    state.tunnel = undefined;
    scheduleReconnect(domain, generation);
  });
  return child;
}

export async function stopInternal(notify = true): Promise<void> {
  state.stopping = true;
  state.tunnelGeneration += 1; // invalidate any pending in-place reconnect timers
  stopPublicWatch();
  stopRepublishLoop();
  stopSessionPruneLoop();
  state.tunnelRole = "none";
  state.missingPublicRounds = 0;
  // Reset the backoff too: it used to survive a stop, so the next start began
  // reconnecting at the 60 s ceiling left over from the previous session
  // instead of at the fast end of the curve.
  state.reconnectAttempt = 0;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = undefined;
  const activeTunnel = state.tunnel;
  state.tunnel = undefined;
  // The tunnel must die before any await: VS Code can hard-kill the extension
  // host mid-deactivate and an un-terminated ngrok keeps holding the domain.
  killTunnelTree(activeTunnel);
  // A crashed command with autoRestart may still hold a pending restart timer;
  // clear every one of them (not only live commands) so a timer cannot fire
  // after `stopping` resets and resurrect a process on a stopped Bridge or
  // after a workspace switch.
  cancelAllPendingRestarts();
  // Await managed process teardown so restart/rotate is transactional.
  const processStops = [...state.commands.values()]
    .filter(commandState => !commandState.done)
    .map(commandState => terminateProcess(commandState, "stopped"));
  await Promise.allSettled(processStops);
  // Await the registry withdrawal: it read-merge-writes bridge-peers.json, and
  // a fire-and-forget withdraw landing after a subsequent start()'s publish
  // could delete that window's freshly published entry (until the 30 s
  // re-publish loop heals it). The tunnel tree is already dead at this point.
  await withdrawSelf();
  const transportCloses = [...state.sessions.values()].map(session => Promise.resolve(session.transport.close()));
  await Promise.allSettled(transportCloses);
  state.sessions.clear();
  state.latestSession = undefined;
  await stopLocalServer();
  state.tunnelUrl = "";
  state.port = 0;
  state.stopping = false;
  try {
    host().ui.refresh();
  } catch {}
  record("bridge", "completed", "Stopped.");
  if (notify) host().notify("info", "Open Bridge stopped.");
}

export async function start(): Promise<void> {
  return enqueueLifecycle(() => startInternal());
}

/** True when a previous teardown already released everything a stop() would. */
function isStopped(): boolean {
  return !state.server
    && !state.tunnel
    && !state.reconnectTimer
    && state.sessions.size === 0
    && ![...state.commands.values()].some(command => !command.done);
}

export async function stop(notify = true): Promise<void> {
  // VS Code runs BOTH the subscription dispose and deactivate() on shutdown,
  // which used to queue the full teardown twice (double "Stopped.", double
  // process-kill pass). Skip the redundant second pass.
  return enqueueLifecycle(async () => {
    if (isStopped()) return;
    await stopInternal(notify);
  });
}

/**
 * Rebind the local listener so a newly rotated route token reaches every route,
 * including whatever the tunnel is forwarding to.
 *
 * Deliberately separate from the rotation itself: rotating the token is a plain
 * in-process assignment, while this closes the listening socket. Callers must
 * flush their HTTP response in between, because that response is travelling
 * over the socket this tears down — awaiting the whole thing before replying is
 * what reached the console as ECONNRESET on a rotation that had succeeded.
 */
export function restartListener(): Promise<void> {
  return enqueueLifecycle(async () => {
    await stopInternal(false);
    await startInternal();
  });
}

/** Tear down the Bridge and reset workspace-scoped state when the open folder changes. */
export async function switchWorkspace(nextRoot: string, loadServicesFor: () => void): Promise<void> {
  // Flush the old workspace's counters before the anchor moves (the persist key
  // and the snapshot are derived from the still-active workspace).
  persistUsageStats();
  await stopInternal(false);
  state.services.clear();
  state.latestSession = undefined;
  state.activeWorkspaceRoot = nextRoot;
  loadServicesFor();
  state.usage = loadUsageStats();
}

// --- Route token management (stored in VS Code Secrets, per workspace) ---

export async function loadRouteToken(): Promise<void> {
  const key = `${ROUTE_TOKEN_KEY}.${workspaceStateSuffix()}`;
  state.routeToken = (await host().secrets.get(key)) ?? "";
  if (!state.routeToken) {
    state.routeToken = randomBytes(16).toString("hex");
    await host().secrets.store(key, state.routeToken);
  }
}

export async function rotateRouteToken(): Promise<void> {
  state.routeToken = randomBytes(16).toString("hex");
  await host().secrets.store(
    `${ROUTE_TOKEN_KEY}.${workspaceStateSuffix()}`,
    state.routeToken,
  );
}

export function webAiPrompt(): string {
  const url = clientMcpUrl();
  if (!url) throw new Error("Start Bridge before copying the web AI prompt.");
  // The prompt carries the credential, so it must mention the second one when
  // the bearer gate is on; otherwise the client gets a 401 with no explanation.
  const authNote = authEnabled()
    ? "\n\n注意：本 Bridge 已启用 Bearer 鉴权。除上面的 URL 外，请求还需带上请求头 "
      + "`Authorization: Bearer <token>`（令牌在 Open Bridge Web 控制台签发，"
      + "只在签发时显示一次）。若你的客户端只能填 URL、不能设置请求头，可改用 `?token=<token>` 形式。"
    : "";
  return `【${url}】${authNote}\n\n快速连接这个 MCP（URL），明确使用规则，熟悉可用工具，做好处理接下来一系列工作的准备。`;
}

export async function runHealthCheck(): Promise<void> {
  if (!state.server) {
    host().notify("warn", "Bridge is not running.");
    return;
  }
  const local = await fetch(`http://127.0.0.1:${state.port}/healthz/${state.routeToken}`)
    .then(async response => ({ ok: response.ok, status: response.status, body: await response.text() }))
    .catch(error => ({ ok: false, status: 0, body: error instanceof Error ? error.message : String(error) }));
  const publicCheck = state.tunnelUrl
    ? await fetch(state.tunnelUrl.replace(`/mcp/${state.routeToken}`, `/healthz/${state.routeToken}`), {
        headers: { "ngrok-skip-browser-warning": "true" },
      })
        .then(async response => ({ ok: response.ok, status: response.status, body: await response.text() }))
        .catch(error => ({ ok: false, status: 0, body: error instanceof Error ? error.message : String(error) }))
    : undefined;
  // Verify the bearer gate is actually closed. A gate that silently fails open
  // is worse than no gate: the operator would believe they are protected. An
  // anonymous initialize must come back 401 while auth is enabled.
  const gateStatus = authEnabled()
    ? await fetch(`http://127.0.0.1:${state.port}/mcp/${state.routeToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health", version: "1" } },
        }),
      }).then(response => response.status).catch(() => 0)
    : undefined;
  const gateOk = gateStatus === undefined || gateStatus === 401;
  record(
    "health",
    local.ok && (!publicCheck || publicCheck.ok) && gateOk ? "completed" : "error",
    `local=${local.status} public=${publicCheck?.status ?? "n/a"}${gateStatus === undefined ? "" : ` anonymous-mcp=${gateStatus}`}`,
  );
  await host().notify("info", 
    `Bridge Health · 本地 ${local.ok ? "正常" : "失败"}`
    + `${publicCheck ? ` · 公网 ${publicCheck.ok ? "正常" : "失败"}` : ""}`
    + `${gateStatus === undefined ? "" : ` · 鉴权${gateOk ? "已生效" : `异常（匿名请求返回 ${gateStatus}，预期 401）`}`}`,
  );
}
