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
import { activityHint } from "../../bridge/activity-presentation.js";
import type { TodoProgressEntry } from "../../bridge/todo-store.js";
import {
  PROCESS_STARTED,
  tuiActivityDetail,
  tuiActivityMessage,
  tuiActivityPresentation,
  tuiMcpTransportInfo,
  type ActivityPresentation,
} from "./activity-copy.js";
import type { WorkspaceChangeState } from "./changes.js";
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
  /** Modern MCP is stateless, so it must be modeled beside — not inside — the legacy session table. */
  modernLastUsed: number;
  modernSince: number;
  modernInFlight: number;
  commands: Map<unknown, {
    id: string;
    command: string;
    done: boolean;
    activityOwner?: "tool" | "process";
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
  /** In-memory cached last progress; null/absent means there is no report to show. */
  todoProgress?: TodoProgressEntry | null;
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
  /** Cached workspace-change probe. The driver passes loading before the first Git result. */
  workspaceChanges?: WorkspaceChangeState;
  /** Current bearer-gate state, supplied by the composition root without credentials. */
  authEnabled?: boolean;
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

function presentationFields(presentation: ActivityPresentation, tool: string): Partial<TuiSnapshot["events"][number]> {
  const action = tool === "mcp" ? "MCP"
    : tool === "process" ? "进程"
    : tool === "bridge" ? "Bridge"
    : tool;
  return {
    action,
    subject: presentation.subject,
    ...(presentation.qualifier ? { qualifier: presentation.qualifier } : {}),
    ...(presentation.failure ? { failure: presentation.failure } : {}),
    subjectKind: presentation.subjectKind,
    ...(presentation.qualifierKind ? { qualifierKind: presentation.qualifierKind } : {}),
    ...(presentation.durationMs !== undefined ? { durationMs: presentation.durationMs } : {}),
  };
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
  //   processes (lifecycle):  record("process", "running", "Started <id>: ...") + terminal exit row
  //
  // New rows carry one invocation_id across their start and outcome, so parallel
  // calls of the same tool close exactly the row they started. Older rows have
  // no correlation field, so they retain the best-effort FIFO fallback. Process
  // rows are their own lifecycle stream. Three rules instead:
  //
  //   1. Match invocation_id exactly; only legacy rows use same-tool FIFO.
  //   2. A "process · Started <id>" row is a lifecycle fact, not a call: its
  //      truth comes from the command table. A live process legitimately
  //      counts; a finished one shows its real lifetime (endedAt − startedAt);
  //      a pruned one degrades to a neutral marker with no invented time.
  //   3. activityOwner="tool" means a foreground command's semantic tool row
  //      owns presentation; timeout/abnormal exit hands ownership to process.
  const entries = view.activity.slice(0, MAX_EVENTS);
  const collected: Array<TuiSnapshot["events"][number] | null> = [];
  type Pending = { idx: number; startedAt: number; args_summary?: string; invocationId?: string };
  type TerminalCandidate = { idx: number; atMs: number };
  const openByTool = new Map<string, Pending[]>();
  const openByInvocation = new Map<string, Pending>();
  const unmatchedTerminalByTool = new Map<string, TerminalCandidate[]>();

  function absorbSuccessfulTransport(toolName: string, atMs: number, detail: string): boolean {
    const queue = unmatchedTerminalByTool.get(toolName) ?? [];
    while (queue.length > 0) {
      const candidate = queue[0]!;
      const event = collected[candidate.idx];
      const delta = atMs - candidate.atMs;
      if (event === null || event === undefined || delta > 2_000) {
        queue.shift();
        continue;
      }
      if (delta < 0) break;
      queue.shift();
      event.detail = [event.detail, detail].filter(Boolean).join("\n\n");
      unmatchedTerminalByTool.set(toolName, queue);
      return true;
    }
    unmatchedTerminalByTool.set(toolName, queue);
    return false;
  }

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    // Protocol/process lifecycle rows are visually secondary. A matched,
    // successful tools/call transport row is folded into the semantic row;
    // orphaned/failed MCP rows and process lifecycle facts stay visible.
    const rowSubtle = entry.tool === "mcp" || entry.tool === "process";
    const operatorHint = activityHint(entry.invocation_id);
    const presentedEntry = operatorHint ? { ...entry, operator_hint: operatorHint } : entry;
    const rowPresentation = tuiActivityPresentation(presentedEntry);
    const rowPresentationFields = presentationFields(rowPresentation, entry.tool);
    const rowDetail = tuiActivityDetail(presentedEntry);
    const ts = entry.ts ?? Date.parse(entry.at);
    const message = tuiActivityMessage(presentedEntry);

    if (entry.tool === "process") {
      const startedId = PROCESS_STARTED.exec(entry.message)?.[1];
      const firstToken = entry.message.trim().split(/\s+/, 1)[0];
      const processId = startedId ?? firstToken;
      const command = processId ? view.commands.get(processId) : undefined;
      if (command?.activityOwner === "tool") {
        // Foreground run_command already has the semantic row the operator
        // cares about. Its process start/exit records remain in audit history,
        // but do not consume a second TUI row. A timed-out call flips ownership
        // back to "process" before returning, so supervised continuation stays visible.
        continue;
      }
    }

    const transport = tuiMcpTransportInfo(presentedEntry);
    if (
      transport?.method === "tools/call"
      && transport.toolName
      && !transport.failure
      && entry.status === "completed"
      && Number.isFinite(ts)
      && absorbSuccessfulTransport(
        transport.toolName,
        ts,
        rowDetail ? `MCP ${rowDetail}` : `MCP ${message}`,
      )
    ) {
      continue;
    }

    if (entry.tool === "process" && entry.status === "running") {
      // Group 1 is the command id — see PROCESS_STARTED in activity-copy.ts
      // for why the single-writer pattern also fits this lookup.
      const id = PROCESS_STARTED.exec(entry.message)?.[1];
      const command = id === undefined ? undefined : view.commands.get(id);
      if (command === undefined) {
        // Pruned from the table: the fact stays, the animation does not.
        collected.push({
        ...(entry.id ? { id: entry.id } : {}), at: entry.at, tool: entry.tool, status: "progress", message,
        ...rowPresentationFields,
        ...(rowSubtle ? { subtle: true } : {}), ...(rowDetail !== "" ? { detail: rowDetail } : {}),
      });
      } else if (command.done) {
        collected.push({
          ...(entry.id ? { id: entry.id } : {}),
          at: entry.at,
          tool: entry.tool,
          status: "completed",
          message,
          ...rowPresentationFields,
          ...(rowSubtle ? { subtle: true } : {}), ...(rowDetail !== "" ? { detail: rowDetail } : {}),
          ...(command.endedAt !== undefined && Number.isFinite(command.endedAt) && command.endedAt >= command.startedAt
            ? { durationMs: command.endedAt - command.startedAt }
            : {}),
        });
      } else {
        collected.push({
          ...(entry.id ? { id: entry.id } : {}), at: entry.at, tool: entry.tool, status: "running", message,
          ...rowPresentationFields,
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
      collected.push({ ...(eventId ? { id: eventId } : {}), at: entry.at, tool: entry.tool, status: "running", message, ...rowPresentationFields });
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
    const invocationId = entry.invocation_id ?? pending?.invocationId;
    const mergedHint = activityHint(invocationId);
    const merged = {
      ...entry,
      args_summary: entry.args_summary ?? pending?.args_summary,
      ...(mergedHint ? { operator_hint: mergedHint } : {}),
    };
    const mergedPresentation = tuiActivityPresentation(merged);
    const mergedDetail = tuiActivityDetail(merged);
    const eventId = invocationId ?? entry.id;
    const terminalIndex = collected.length;
    collected.push({
      ...(eventId ? { id: eventId } : {}),
      at: entry.at,
      tool: entry.tool,
      status: toEventStatus(entry.status),
      message: tuiActivityMessage(merged),
      ...presentationFields(mergedPresentation, entry.tool),
      ...(rowSubtle ? { subtle: true } : {}),
      ...(mergedDetail !== "" ? { detail: mergedDetail } : {}),
      ...(pending !== undefined && Number.isFinite(ts) && ts >= pending.startedAt
        ? { durationMs: ts - pending.startedAt }
        : {}),
    });
    if (entry.tool !== "mcp" && entry.tool !== "process" && Number.isFinite(ts)) {
      const candidates = unmatchedTerminalByTool.get(entry.tool) ?? [];
      candidates.push({ idx: terminalIndex, atMs: ts });
      unmatchedTerminalByTool.set(entry.tool, candidates);
    }
  }
  // The activity log is newest-first (state.activity.unshift) and the loop
  // above walks it backwards, so `collected` comes out chronological; flip it
  // back to newest-first — the order the panel renders (newest on top, the
  // reading direction the operator chose). The scroll machinery treats
  // index 0, the head, as the live position.
  const events = collected
    .filter((event): event is TuiSnapshot["events"][number] => event !== null)
    .reverse();

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
    exposure: view.tunnelUrl
      ? (options.authEnabled === true ? "public-authed" : "public-open")
      : "local",
    uptimeMs: Math.max(0, now - (options.launchedAt ?? now)),
    calls: view.runtimeUsage.calls,
    successes: view.runtimeUsage.successes,
    failures: view.runtimeUsage.failures,
    sessions,
    sessionsActive,
    modernSeen: view.modernSince > 0 || view.modernLastUsed > 0 || view.modernInFlight > 0,
    modernInFlight: Math.max(0, Math.floor(view.modernInFlight)),
    todos: view.todos.map(todo => ({ title: todo.title, status: todo.status, ...(todo.completedAt !== undefined ? { completedAt: todo.completedAt } : {}) })),
    ...(options.todoProgress ? {
      progress: {
        message: options.todoProgress.message,
        ...(options.todoProgress.phase ? { phase: options.todoProgress.phase } : {}),
        ...(options.todoProgress.category ? { category: options.todoProgress.category } : {}),
        ...(typeof options.todoProgress.percent === "number" ? { percent: options.todoProgress.percent } : {}),
        level: options.todoProgress.level,
        at: options.todoProgress.at,
      },
    } : {}),
    todosTotal: view.todos.length,
    changes: options.workspaceChanges ?? { status: "not-git" },
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
