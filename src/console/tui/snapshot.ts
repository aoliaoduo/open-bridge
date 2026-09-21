/**
 * Assemble the TUI's view model from the live bridge state.
 *
 * The state is read through a structural interface (TuiStateView), not the
 * concrete state type: every field the TUI needs is listed explicitly, the
 * real `state` singleton satisfies it, and unit tests can pass plain literals
 * without spawning child processes or installing a host.
 */

import { MAX_CAPTURED_OUTPUT } from "../../bridge/state.js";
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
    endedAt?: number;
    output: { state(): { totalBytes: number; capacityBytes: number } };
  }>;
  services: Map<unknown, { commandId?: string }>;
  activity: Array<{ at: string; ts?: number; tool: string; status: string; message: string; args_summary?: string }>;
  usage: { startedAt: number; calls: number; successes: number; failures: number };
  /** Since-launch counters (state.runtimeUsage): the numbers the TUI shows. */
  runtimeUsage: { calls: number; successes: number; failures: number };
  /** Current task list (set_todos writes; boot loads it from the store). */
  todos: Array<{ id: string; title: string; status: string }>;
}

export interface SnapshotOptions {
  version: string;
  rootName: string;
  logPath: string;
  /** Injection point for tests; the driver passes nothing (real clock). */
  now?: number;
  /** THIS process's launch instant (the driver captures it at console start):
   *  「运行」 is process uptime, never the persisted stats window — a freshly
   *  restarted Bridge used to claim 50 hours. */
  launchedAt?: number;
  /**
   * Workspace changes since the last commit (files/insertions/deletions).
   * The driver refreshes this asynchronously every few seconds; undefined
   * (or an all-zero summary) means clean tree or not a git repository.
   */
  workspaceChanges?: { files: number; insertions: number; deletions: number };
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

  // Duration matching, against the rows the producers REALLY write:
  //
  //   dispatcher (invoke):    record(name, "running", summary, argsSummary)
  //   mcp endpoint (outcome): record(name, "completed"|"error", message) — no args summary
  //   processes (lifecycle):  record("process", "running", "Started <id>: ...") — no outcome row at all
  //
  // So exact-key pairing can never succeed (the first live screenshot showed
  // every invoke row spinning and counting forever), and process rows have no
  // outcome to wait for. Two rules instead:
  //
  //   1. An outcome row closes the OLDEST still-open invoke of the same tool
  //      (FIFO). Concurrent same-tool calls can attribute durations crosswise;
  //      for a viewing surface that beats an invoke that never retires.
  //   2. A "process · Started <id>" row is a lifecycle fact, not a call: its
  //      truth comes from the command table. A live process legitimately
  //      counts; a finished one shows its real lifetime (endedAt − startedAt);
  //      a pruned one degrades to a neutral marker with no invented time.
  const entries = view.activity.slice(0, MAX_EVENTS);
  const collected: Array<TuiSnapshot["events"][number] | null> = [];
  const openByTool = new Map<string, { idx: number; startedAt: number }[]>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    const ts = entry.ts ?? Date.parse(entry.at);

    if (entry.tool === "process" && entry.status === "running") {
      const id = /^Started ([0-9a-f]{8,}):/.exec(entry.message)?.[1];
      const command = id === undefined ? undefined : view.commands.get(id);
      if (command === undefined) {
        // Pruned from the table: the fact stays, the animation does not.
        collected.push({ at: entry.at, tool: entry.tool, status: "progress", message: entry.message });
      } else if (command.done) {
        collected.push({
          at: entry.at,
          tool: entry.tool,
          status: "completed",
          message: entry.message,
          ...(command.endedAt !== undefined && Number.isFinite(command.endedAt) && command.endedAt >= command.startedAt
            ? { durationMs: command.endedAt - command.startedAt }
            : {}),
        });
      } else {
        collected.push({ at: entry.at, tool: entry.tool, status: "running", message: entry.message });
      }
      continue;
    }

    if (entry.status === "running") {
      const queue = openByTool.get(entry.tool) ?? [];
      if (Number.isFinite(ts)) queue.push({ idx: collected.length, startedAt: ts });
      openByTool.set(entry.tool, queue);
      collected.push({ at: entry.at, tool: entry.tool, status: "running", message: entry.message });
      continue;
    }
    const pending = openByTool.get(entry.tool)?.shift();
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
  // The activity log is newest-first (state.activity.unshift) and the loop
  // above walks it backwards, so `collected` comes out chronological; flip it
  // back to newest-first — the order the panel renders (newest on top, the
  // reading direction the operator chose). The scroll machinery treats
  // index 0, the head, as the live position.
  const events = collected
    .filter((event): event is TuiSnapshot["events"][number] => event !== null)
    .reverse();

  const mcpUrl = view.tunnelUrl || `http://127.0.0.1:${view.port}/mcp/${view.routeToken}`;
  // Operator's call: the full address, token included. The startup banner and
  // `open-bridge url` both print it in full — a redacted copy was the odd one
  // out, and unusable for the paste-it-into-a-client job the footer exists for.

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
    mcpUrl,
    uptimeMs: Math.max(0, now - (options.launchedAt ?? now)),
    calls: view.runtimeUsage.calls,
    successes: view.runtimeUsage.successes,
    failures: view.runtimeUsage.failures,
    sessions,
    sessionsActive,
    todos: view.todos.slice(0, 16).map(todo => ({ title: todo.title, status: todo.status })),
    todosTotal: view.todos.length,
    ...(options.workspaceChanges !== undefined ? { changes: options.workspaceChanges } : {}),
    runningCommands,
    servicesTotal,
    servicesRunning,
    serviceRows,
    events,
    logPath: options.logPath,
  };
}
