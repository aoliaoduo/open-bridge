/**
 * Assemble the TUI's view model from the live bridge state.
 *
 * The state is read through a structural interface (TuiStateView), not the
 * concrete state type: every field the TUI needs is listed explicitly, the
 * real `state` singleton satisfies it, and unit tests can pass plain literals
 * without spawning child processes or installing a host.
 */

import { isActivityStatus } from "../../mcp/activity-status.js";
import { MAX_CAPTURED_OUTPUT } from "../../bridge/state.js";
import { tuiActivityDetail, tuiActivityMessage } from "./activity-copy.js";
import type { TuiEventStatus, TuiSnapshot } from "./render.js";

export interface TuiStateView {
  port: number;
  routeToken: string;
  tunnelUrl: string;
  tunnelRole: string;
  tunnelProvider?: string;
  stopping: boolean;
  activeWorkspaceRoot?: string;
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
  activity: Array<{
    id?: string;
    invocation_id?: string;
    at: string;
    ts?: number;
    tool: string;
    status: string;
    message: string;
    args_summary?: string;
  }>;
  usage: { startedAt: number; calls: number; successes: number; failures: number };
  /** Since-launch counters (state.runtimeUsage): the numbers the TUI shows. */
  runtimeUsage: { calls: number; successes: number; failures: number };
  /** Current task list (set_todos writes; boot loads it from the store). */
  todos: Array<{ id: string; title: string; status: string; completedAt?: string }>;
}

export interface SnapshotOptions {
  /** 任务文档最近一次写入/加载的时刻（todoFreshness）；标题栏新鲜度与卡住预警用。 */
  todosUpdatedAt?: string;
  version: string;
  rootName: string;
  rootPath?: string;
  logPath: string;
  /** Injection point for tests; the driver passes nothing (real clock). */
  now?: number;
  /** THIS process's launch instant (the driver captures it at console start):
   *  「运行」 is process uptime, never the persisted stats window — a freshly
   *  restarted Bridge used to claim 50 hours. */
  launchedAt?: number;
  /**
   * Workspace changes since the last commit (files/insertions/deletions).
   * The driver refreshes this asynchronously every few seconds.
   * undefined = not a git repository (非 git); all-zero = clean (干净);
   * unavailable = a failed read of a real repo (读取失败).
   */
  workspaceChanges?: {
    files: number;
    insertions: number;
    deletions: number;
    unavailable?: boolean;
    entries?: Array<{ path: string; insertions: number; deletions: number; untracked?: boolean; binary?: boolean }>;
  };
  /** 累计 review diff，或变更页当前文件的工作树 diff。 */
  diff?: {
    loading: boolean;
    ok: boolean;
    text: string;
    truncated: boolean;
    since: string;
    checkpoint: string;
    reason: string;
    kind?: "cumulative" | "file";
    path?: string;
  };
}

const MAX_EVENTS = 200;

function toEventStatus(status: string): TuiEventStatus {
  return isActivityStatus(status)
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
  runningCommands.sort((a, b) => b.elapsedMs - a.elapsedMs);

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
  // New rows carry one invocation_id across their start and outcome, so parallel
  // calls of the same tool close exactly the row they started. Older rows have
  // no correlation field, so they retain the best-effort FIFO fallback. Process
  // rows have no outcome to wait for. Two rules instead:
  //
  //   1. Match invocation_id exactly; only legacy rows use same-tool FIFO.
  //   2. A "process · Started <id>" row is a lifecycle fact, not a call: its
  //      truth comes from the command table. A live process legitimately
  //      counts; a finished one shows its real lifetime (endedAt − startedAt);
  //      a pruned one degrades to a neutral marker with no invented time.
  const entries = view.activity.slice(0, MAX_EVENTS);
  const collected: Array<TuiSnapshot["events"][number] | null> = [];
  type Pending = { idx: number; startedAt: number; args_summary?: string; invocationId?: string };
  const openByTool = new Map<string, Pending[]>();
  const openByInvocation = new Map<string, Pending>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    // 「全部显示」：mcp/process 不再被过滤，渲染层以 subtle 弱化着色 ——
    // 操作者要的是「没有哪次调用没记录」的确定感。
    const rowSubtle = entry.tool === "mcp" || entry.tool === "process";
    const rowDetail = tuiActivityDetail(entry);
    const ts = entry.ts ?? Date.parse(entry.at);
    const message = tuiActivityMessage(entry);

    if (entry.tool === "process" && entry.status === "running") {
      const id = /^Started ([0-9a-f]{8,}):/.exec(entry.message)?.[1];
      const command = id === undefined ? undefined : view.commands.get(id);
      if (command === undefined) {
        // Pruned from the table: the fact stays, the animation does not.
        collected.push({
        ...(entry.id ? { id: entry.id } : {}), at: entry.at, tool: entry.tool, status: "progress", message,
        ...(rowSubtle ? { subtle: true } : {}), ...(rowDetail !== "" ? { detail: rowDetail } : {}),
      });
      } else if (command.done) {
        collected.push({
          ...(entry.id ? { id: entry.id } : {}),
          at: entry.at,
          tool: entry.tool,
          status: "completed",
          message,
          ...(rowSubtle ? { subtle: true } : {}), ...(rowDetail !== "" ? { detail: rowDetail } : {}),
          ...(command.endedAt !== undefined && Number.isFinite(command.endedAt) && command.endedAt >= command.startedAt
            ? { durationMs: command.endedAt - command.startedAt }
            : {}),
        });
      } else {
        collected.push({
          ...(entry.id ? { id: entry.id } : {}), at: entry.at, tool: entry.tool, status: "running", message,
          ...(rowSubtle ? { subtle: true } : {}), ...(rowDetail !== "" ? { detail: rowDetail } : {}),
        });
      }
      continue;
    }

    if (entry.status === "running") {
      const queue = openByTool.get(entry.tool) ?? [];
      if (Number.isFinite(ts)) {
        const pending: Pending = {
          idx: collected.length, startedAt: ts, args_summary: entry.args_summary,
          ...(entry.invocation_id ? { invocationId: entry.invocation_id } : {}),
        };
        queue.push(pending);
        if (entry.invocation_id) openByInvocation.set(entry.invocation_id, pending);
      }
      openByTool.set(entry.tool, queue);
      const eventId = entry.invocation_id ?? entry.id;
      collected.push({ ...(eventId ? { id: eventId } : {}), at: entry.at, tool: entry.tool, status: "running", message });
      continue;
    }
    const queue = openByTool.get(entry.tool);
    let pending = entry.invocation_id ? openByInvocation.get(entry.invocation_id) : undefined;
    if (pending !== undefined) {
      const index = queue?.indexOf(pending) ?? -1;
      if (index >= 0) queue?.splice(index, 1);
      openByInvocation.delete(entry.invocation_id!);
    } else if (!entry.invocation_id) {
      // An uncorrelated lifecycle/audit row must not steal a modern correlated
      // invocation merely because it shares the tool name. FIFO applies only
      // among legacy starts that also lack an invocation id.
      const legacyIndex = queue?.findIndex(candidate => !candidate.invocationId) ?? -1;
      if (legacyIndex >= 0) pending = queue?.splice(legacyIndex, 1)[0];
    }
    if (pending !== undefined) collected[pending.idx] = null;
    const merged = { ...entry, args_summary: entry.args_summary ?? pending?.args_summary };
    const mergedDetail = tuiActivityDetail(merged);
    const eventId = entry.invocation_id ?? pending?.invocationId ?? entry.id;
    collected.push({
      ...(eventId ? { id: eventId } : {}),
      at: entry.at,
      tool: entry.tool,
      status: toEventStatus(entry.status),
      message: tuiActivityMessage(merged),
      ...(rowSubtle ? { subtle: true } : {}),
      ...(mergedDetail !== "" ? { detail: mergedDetail } : {}),
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

  const inferredProvider = view.tunnelProvider
    || (view.tunnelUrl.includes(".ts.net") ? "tailscale"
        : (view.tunnelUrl.includes("ngrok") ? "ngrok" : undefined));

  return {
    version: options.version,
    rootName: options.rootName,
    workspaceRoot: view.activeWorkspaceRoot || options.rootPath || "",
    bridgeState: view.stopping ? "stopping" : "running",
    port: view.port,
    tunnel: view.tunnelUrl
      ? "public"
      : view.tunnelRole === "follower"
        ? "follower"
        : view.tunnelRole === "blocked"
          ? "blocked"
          : "local",
    tunnelProvider: inferredProvider,
    mcpUrl,
    uptimeMs: Math.max(0, now - (options.launchedAt ?? now)),
    calls: view.runtimeUsage.calls,
    successes: view.runtimeUsage.successes,
    failures: view.runtimeUsage.failures,
    sessions,
    sessionsActive,
    todos: view.todos.map(todo => ({ title: todo.title, status: todo.status, ...(todo.completedAt !== undefined ? { completedAt: todo.completedAt } : {}) })),
    todosTotal: view.todos.length,
    ...(options.workspaceChanges !== undefined ? { changes: options.workspaceChanges } : {}),
    ...(options.diff !== undefined ? { diff: options.diff } : {}),
    ...(options.todosUpdatedAt !== undefined ? { todosUpdatedAt: options.todosUpdatedAt } : {}),
    runningCommands,
    servicesTotal,
    servicesRunning,
    serviceRows,
    events,
    logPath: options.logPath,
  };
}
