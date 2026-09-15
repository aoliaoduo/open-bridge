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
import { killTunnelTree, loadNgrokAuthtoken, setInstanceRestart, startTunnelInternal, stopPublicWatch } from "./tunnel.js";
import { publishSelf, stopRepublishLoop, withdrawSelf } from "./peer-registry.js";
import { startHttpInternal, stopLocalServer } from "./http-listener.js";
import { stopSessionPruneLoop } from "./session-table.js";
import { clearNotifyLedger } from "./notify.js";

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
  // Read before the tunnel can spawn: spawnTunnel is synchronous and the
  // secret store is not.
  await loadNgrokAuthtoken();
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
  clearNotifyLedger();
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
  // Same reset the session table gets: a stopped Bridge must not carry a
  // stale modern-era activity clock into the next start, where it would read
  // as an ancient "last call" and skew the idle/finish watchdogs' latch.
  state.modernLastUsed = 0;
  state.modernSince = 0;
  // Same reasoning one step further: the "older build than dist/" note is a
  // per-process fact, and a stop/start in this process may happen after a rebuild.
  state.notedStaleBuild = false;
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
  // `?? ""` rather than `!`: split() always yields at least one element, and an
  // empty prefix simply fails the https check below, which is the right answer.
  const prefix = state.tunnelUrl.split("/mcp/")[0] ?? "";
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

/**
 * The tunnel module asks back exactly once: a borrowed public domain that frees
 * up means restarting the whole instance onto it, which is this module's
 * business, not the tunnel's. Injected here so the import runs one way only
 * (lifecycle -> tunnel) with no cycle to reason about.
 *
 * Queued like every other transition: this is a stop+start on the SAME instance
 * state, and the domain watch fires it on its own schedule. Running it outside
 * the queue let it interleave with an operator's Start or Stop from the console —
 * e.g. the queued startInternal lands while this stopInternal is between killing
 * processes and closing the listener, takes the "already running" retry branch,
 * and is then torn down by the stopInternal that resumes behind it; or a queued
 * stop is skipped by `isStopped()` while this path brings the Bridge back up
 * after the operator asked for it to stay down. Two stopInternal runs would also
 * race on the peer registry's read-merge-write.
 */
setInstanceRestart(async () => {
  await enqueueLifecycle(async () => {
    await stopInternal(false);
    await startInternal();
  });
});
