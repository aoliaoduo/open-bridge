/**
 * The MCP session table: idle reclamation, capacity, and the periodic sweep.
 *
 * A session is the only long-lived per-client state (transport, todo snapshot,
 * call counter), so "a client walked away" and "too many clients" are both
 * handled here. A session with an active request is never reclaimed.
 */
import { host } from "../host/host.js";
import { MAX_SESSIONS, state } from "./state.js";
import { pruneCommands } from "./processes.js";
import { idleNoticeTick } from "./notify.js";

/** Idle MCP sessions are reclaimed after this long without activity. */
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** How often the idle-session reclamation sweep runs. */
const SESSION_PRUNE_INTERVAL_MS = 60_000;

/** Evict and close the least-recently-used idle session. False when every session is mid-request. */
function evictOldestIdleSession(): boolean {
  const evictable = [...state.sessions.entries()]
    .filter(([, session]) => session.activeRequests === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
  if (!evictable) return false;
  state.sessions.delete(evictable[0]);
  void evictable[1].transport.close();
  return true;
}

export function pruneSessions(): void {
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
    if (!evictOldestIdleSession()) break; // every session is mid-request; leave them alone
    prunedAny = true;
  }
  if (prunedAny) host().ui.update();
}

export function makeRoomForSession(): boolean {
  if (state.sessions.size < MAX_SESSIONS) return true;
  return evictOldestIdleSession();
}

export function startSessionPruneLoop(): void {
  if (state.sessionPruneTimer) return;
  state.sessionPruneTimer = setInterval(() => {
    try { pruneSessions(); } catch { /* best-effort sweep */ }
    // Retire finished commands on the same 60 s sweep: pruneCommands used to
    // run only when a NEW run_command/get_process_snapshot came in, so a
    // long-idle Bridge kept every finished command's buffers (3 x 32 MiB)
    // and its %TEMP% capture file alive indefinitely.
    try { pruneCommands(); } catch { /* best-effort sweep */ }
    // The notification idle-watchdog rides this sweep instead of owning a
    // second timer: one 60 s heartbeat for "time passed on an idle Bridge",
    // started and stopped as one unit. Its own decisions are guarded inside.
    try { idleNoticeTick(); } catch { /* best-effort sweep */ }
  }, SESSION_PRUNE_INTERVAL_MS);
}

export function stopSessionPruneLoop(): void {
  if (state.sessionPruneTimer) clearInterval(state.sessionPruneTimer);
  state.sessionPruneTimer = undefined;
}
