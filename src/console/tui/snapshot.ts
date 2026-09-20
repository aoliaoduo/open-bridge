/**
 * Assemble the TUI's view model from the live bridge state.
 *
 * The state is read through a structural interface (TuiStateView), not the
 * concrete state type: every field the TUI needs is listed explicitly, the
 * real `state` singleton satisfies it, and unit tests can pass plain literals
 * without spawning child processes or installing a host.
 */

import { MAX_CAPTURED_OUTPUT, MAX_SESSIONS } from "../../bridge/state.js";
import type { TuiEventStatus, TuiSnapshot } from "./render.js";

export interface TuiStateView {
  port: number;
  routeToken: string;
  tunnelUrl: string;
  tunnelRole: string;
  stopping: boolean;
  sessions: Map<unknown, { activeRequests: number; calls: number; lastUsed: number }>;
  commands: Map<unknown, {
    id: string;
    command: string;
    done: boolean;
    startedAt: number;
    output: { state(): { totalBytes: number; capacityBytes: number } };
  }>;
  services: Map<unknown, { commandId?: string }>;
  activity: Array<{ at: string; ts?: number; tool: string; status: string; message: string; args_summary?: string }>;
  usage: { startedAt: number; calls: number; successes: number; failures: number };
}

export interface SnapshotOptions {
  version: string;
  rootName: string;
  logPath: string;
  /** Injection point for tests; the driver passes nothing (real clock). */
  now?: number;
}

const MAX_EVENTS = 40;

function toEventStatus(status: string): TuiEventStatus {
  return status === "running" || status === "completed" || status === "error" || status === "progress" || status === "warning"
    ? status
    : "progress";
}

export function buildSnapshot(view: TuiStateView, options: SnapshotOptions): TuiSnapshot {
  const now = options.now ?? Date.now();

  let sessions = 0;
  let sessionsActive = 0;
  for (const session of view.sessions.values()) {
    sessions += 1;
    if (session.activeRequests > 0) sessionsActive += 1;
  }

  const runningCommands: TuiSnapshot["runningCommands"] = [];
  for (const command of view.commands.values()) {
    if (command.done) continue;
    let capturedBytes = 0;
    let capacityBytes = MAX_CAPTURED_OUTPUT;
    try {
      const s = command.output.state();
      capturedBytes = s.totalBytes;
      capacityBytes = s.capacityBytes > 0 ? s.capacityBytes : MAX_CAPTURED_OUTPUT;
    } catch { /* an unreadable buffer still earns a card, without the fill ratio */ }
    runningCommands.push({
      id: command.id,
      command: command.command,
      elapsedMs: Math.max(0, now - command.startedAt),
      capturedBytes,
      capacityBytes,
    });
  }
  // Longest-running first: the row the operator most needs to notice.
  runningCommands.sort((a, b) => a.elapsedMs - b.elapsedMs);

  let servicesTotal = 0;
  let servicesRunning = 0;
  const serviceRows: TuiSnapshot["serviceRows"] = [];
  for (const [name, service] of view.services) {
    servicesTotal += 1;
    const id = service.commandId;
    const command = id === undefined ? undefined : view.commands.get(id);
    const running = command !== undefined && !command.done;
    if (running) servicesRunning += 1;
    serviceRows.push({ name: String(name), running });
  }

  // Duration matching: the activity log records the invoke ("running") and the
  // outcome as two rows, NEWEST FIRST. Pair them by tool + args summary — the
  // same key the dispatcher stamps on both — walking oldest → newest so the
  // invoke is always seen before its outcome, and only report a duration when
  // the pair was actually observed in the retained window (never invent one).
  // When the outcome lands, the invoke row RETIRES: one line per call, carrying
  // the duration — the same single-row lifecycle ainovel-cli's event stream
  // shows. A still-open invoke stays as a live row (the renderer animates it).
  const entries = view.activity.slice(0, MAX_EVENTS);
  const collected: Array<TuiSnapshot["events"][number] | null> = [];
  const open = new Map<string, { idx: number; startedAt: number }>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    const key = `${entry.tool}\u0000${(entry.args_summary ?? entry.message).slice(0, 120)}`;
    const ts = entry.ts ?? Date.parse(entry.at);
    if (entry.status === "running") {
      if (Number.isFinite(ts)) open.set(key, { idx: collected.length, startedAt: ts });
      collected.push({ at: entry.at, tool: entry.tool, status: "running", message: entry.message });
      continue;
    }
    const pending = open.get(key);
    open.delete(key);
    if (pending !== undefined) collected[pending.idx] = null;
    collected.push({
      at: entry.at,
      tool: entry.tool,
      status: toEventStatus(entry.status),
      message: entry.message,
      ...(pending !== undefined && Number.isFinite(ts) && ts >= pending.startedAt
        ? { durationMs: ts - pending.startedAt }
        : {}),
    });
  }
  const events = collected
    .filter((event): event is TuiSnapshot["events"][number] => event !== null)
    .reverse();

  const mcpUrl = view.tunnelUrl || `http://127.0.0.1:${view.port}/mcp/${view.routeToken}`;
  // The route token grants the workspace; the dashboard shows the address, not
  // the key inside it.
  const safeUrl = view.routeToken ? mcpUrl.split(view.routeToken).join("<redacted>") : mcpUrl;

  return {
    version: options.version,
    rootName: options.rootName,
    bridgeState: view.stopping ? "stopping" : "running",
    port: view.port,
    tunnel: view.tunnelUrl
      ? "public"
      : view.tunnelRole === "follower"
        ? "follower"
        : view.tunnelRole === "blocked"
          ? "blocked"
          : "local",
    mcpUrl: safeUrl,
    uptimeMs: Math.max(0, now - view.usage.startedAt),
    calls: view.usage.calls,
    successes: view.usage.successes,
    failures: view.usage.failures,
    sessions,
    sessionsActive,
    maxSessions: MAX_SESSIONS,
    runningCommands,
    servicesTotal,
    servicesRunning,
    serviceRows,
    events,
    logPath: options.logPath,
  };
}
