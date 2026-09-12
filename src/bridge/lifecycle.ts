/**
 * Instance lifecycle: when the Bridge runs, who serves the public domain, and
 * what a client or the operator can ask of it.
 *
 *   start / stop — the transition queue, the listener, the tunnel
 *   ownership    — this instance, a peer, or nobody serving the domain
 *   surfaces     — route token, the "connect this MCP" prompt, the health report
 *
 * The pieces it drives live next door and depend one way only: http-listener,
 * tunnel, session-table, mcp-endpoint, peer-registry, route-hooks.
 */
import { host } from "../host/host.js";
import { randomBytes } from "node:crypto";
import { authEnabled } from "../http/auth.js";
import { ROUTE_TOKEN_KEY, clientMcpUrl, record, state, redactedPublicUrl } from "./state.js";
import { buildWebAiPrompt } from "./onboarding.js";
import { workspaceStateSuffix } from "./paths.js";
import { cancelAllPendingRestarts, terminateProcess } from "./processes.js";
import { enqueueLifecycle } from "./lifecycle-queue.js";
import { killTunnelTree, setInstanceRestart, startTunnelInternal, stopPublicWatch } from "./tunnel.js";
import { publishSelf, stopRepublishLoop, withdrawSelf } from "./peer-registry.js";
import { startHttpInternal, stopLocalServer } from "./http-listener.js";
import { stopSessionPruneLoop } from "./session-table.js";

async function startInternal(): Promise<void> {
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
async function stopInternal(notify = true): Promise<void> {
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
  // The tunnel must die before any await: the hosting process can be killed
  // without warning (Ctrl-C, an IDE shutting down, a crash) and an
  // un-terminated ngrok keeps holding the domain.
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
  } catch { /* a stopped Bridge cannot update a UI */ }
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
  // The host can run BOTH its dispose callback and deactivate() on shutdown,
  // which used to queue the full teardown twice (double "Stopped.", double
  // process-kill pass). Skip the redundant second pass.
  return enqueueLifecycle(async () => {
    if (isStopped()) return;
    await stopInternal(notify);
  });
}

// --- Route token management (persisted in the host secret store, per project) ---
async function loadRouteToken(): Promise<void> {
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

/**
 * Re-point the published surfaces at a freshly rotated token.
 *
 * Rotation is an in-process assignment and every route compares
 * `state.routeToken` per request, so the listener never has to move: closing it
 * — the old behaviour — bought nothing but a window in which the port accepted
 * no connections, and with a tunnel up it also tore the tunnel down and
 * re-published it (on ngrok Free's one-session-per-domain budget that is a real
 * outage risk). What does carry the token is the public URL this instance
 * advertises and the peer registry other instances read, so those are refreshed
 * here, without touching traffic.
 */
export async function republishAfterRotate(): Promise<void> {
  const prefix = state.tunnelUrl.split("/mcp/")[0];
  if (prefix.startsWith("https://")) state.tunnelUrl = `${prefix}/mcp/${state.routeToken}`;
  await publishSelf();
}

/**
 * The onboarding prompt for the current instance, with its locality stated.
 *
 * `state.tunnelUrl` is the signal: it is set only while a tunnel is actually
 * published (see the public_url semantics fixed earlier), so when it is empty
 * the prompt must admit that the URL it carries is loopback-only.
 */
export function webAiPrompt(): string {
  const url = clientMcpUrl();
  if (!url) throw new Error("Start Bridge before copying the web AI prompt.");
  return buildWebAiPrompt({ url, isPublic: Boolean(state.tunnelUrl), authEnabled: authEnabled() });
}
export interface HealthReport {
  ok: boolean;
  /** One line, for the console toast and the activity log. */
  summary: string;
  /** One line per probe, in the order they ran. */
  details: string[];
}

/**
 * End-to-end health check: prove the instance is what it claims to be.
 *
 * This existed since the VS Code port but had no caller in the standalone app,
 * so nothing inside the product could ever verify that the tunnel it advertises
 * answers, or that the bearer gate really refuses anonymous requests. A gate
 * that silently fails open is worse than no gate: the operator would believe
 * they are protected. It now returns a structured report (so the console can
 * show it) and still records + notifies, keeping the activity-log trail.
 */
export async function runHealthCheck(): Promise<HealthReport> {
  const probe = async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: string }> =>
    fetch(url, init)
      .then(async response => ({ ok: response.ok, status: response.status, body: await response.text() }))
      .catch(error => ({ ok: false, status: 0, body: error instanceof Error ? error.message : String(error) }));
  if (!state.server) {
    const summary = "Bridge 未运行，无法体检。";
    record("health", "error", summary);
    host().notify("warn", summary);
    return { ok: false, summary, details: ["实例未运行"] };
  }
  const local = await probe(`http://127.0.0.1:${state.port}/healthz/${state.routeToken}`);
  const details = [`本地端点 ${local.ok ? "正常" : "失败"}（${local.status || local.body}）`];
  const publicCheck = state.tunnelUrl
    ? await probe(state.tunnelUrl.replace(`/mcp/${state.routeToken}`, `/healthz/${state.routeToken}`), {
        headers: { "ngrok-skip-browser-warning": "true" },
        // Bounded: a tunnel edge that accepts but never answers must not hang
        // the health check (and with it the console's 体检 action) forever.
        signal: AbortSignal.timeout(8_000),
      })
    : undefined;
  details.push(publicCheck
    ? `公网隧道 ${publicCheck.ok ? "正常" : "失败"}（${publicCheck.status || publicCheck.body}）`
    : "公网隧道 未开启（仅本机可用）");
  // Verify the bearer gate is actually closed. A gate that silently fails open
  // is worse than no gate: the operator would believe they are protected. An
  // anonymous initialize must come back 401 while auth is enabled.
  const gateStatus = authEnabled()
    ? (await probe(`http://127.0.0.1:${state.port}/mcp/${state.routeToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health", version: "1" } },
        }),
      })).status
    : undefined;
  const gateOk = gateStatus === undefined || gateStatus === 401;
  details.push(gateStatus === undefined
    ? "Bearer 鉴权 未启用"
    : (gateOk ? "Bearer 鉴权 已生效（匿名请求 401）" : `Bearer 鉴权 异常（匿名请求返回 ${gateStatus}，预期 401）`));
  const ok = local.ok && publicCheck?.ok !== false && gateOk;
  const summary = `健康检查：本地 ${local.ok ? "正常" : "失败"}`
    + (publicCheck ? ` · 公网 ${publicCheck.ok ? "正常" : "失败"}` : " · 公网未开启")
    + (gateStatus === undefined ? " · 鉴权未启用" : ` · 鉴权${gateOk ? "已生效" : "异常"}`);
  record(
    "health",
    ok ? "completed" : "error",
    `local=${local.status} public=${publicCheck?.status ?? "n/a"}${gateStatus === undefined ? "" : ` anonymous-mcp=${gateStatus}`}`,
  );
  await host().notify("info", summary);
  return { ok, summary, details };
}

/**
 * The tunnel module asks back exactly once: a borrowed public domain that frees
 * up means restarting the whole instance onto it, which is this module's
 * business, not the tunnel's. Injected here so the import runs one way only
 * (lifecycle -> tunnel) with no cycle to reason about.
 */
setInstanceRestart(async () => {
  await stopInternal(false);
  await startInternal();
});
