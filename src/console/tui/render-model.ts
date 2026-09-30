/** Shared immutable view model for the serve-console TUI renderers. */
import type { WorkspaceChangeState } from "./changes.js";
import type { ActivitySubjectKind } from "../../bridge/activity-presentation.js";
import type { ActivityStatus as TuiEventStatus } from "../../mcp/activity-status.js";

export type { ActivityStatus as TuiEventStatus } from "../../mcp/activity-status.js";

export type TuiSnapshot = {
  version: string;
  rootName: string;
  workspaceRoot?: string;
  bridgeState: "running" | "stopping" | "stopped";
  port: number;
  tunnel: "public" | "local" | "follower" | "blocked";
  tunnelProvider?: string;
  /** Operator-facing exposure state; carries no token or endpoint. */
  exposure: "local" | "public-open" | "public-authed";
  uptimeMs: number;
  calls: number;
  successes: number;
  failures: number;
  sessions: number;
  sessionsActive: number;
  /** Stateless modern MCP activity lives beside legacy transport sessions. */
  modernSeen: boolean;
  modernInFlight: number;
  /** Complete current task list; the viewport, not the snapshot, limits rows. */
  todos: Array<{ title: string; status: string; completedAt?: string }>;
  /** 任务文档最近一次写入/加载的时刻；标题栏新鲜度与卡住预警用。 */
  todosUpdatedAt?: string;
  /** Latest persisted report_progress. It is historical evidence, not a live-session claim. */
  progress?: {
    message: string;
    phase?: "queued" | "preparing" | "running" | "verifying" | "done";
    category?: "read" | "edit" | "command" | "test" | "build" | "other";
    percent?: number;
    level: "debug" | "info" | "notice" | "warning" | "error";
    at: string;
  };
  /** Total task count shared by both layouts. */
  todosTotal: number;
  /** Workspace changes since the last commit, including probe lifecycle state. */
  changes: WorkspaceChangeState;
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
  runningCommands: Array<{
    id: string;
    command: string;
    elapsedMs: number;
    capturedBytes: number;
    capacityBytes: number;
  }>;
  servicesTotal: number;
  servicesRunning: number;
  /** Per-service rows for the workbench sidebar (name + live state). */
  serviceRows: Array<{ name: string; running: boolean }>;
  events: Array<{
    id?: string; at: string; tool: string; status: TuiEventStatus; message: string;
    action?: string; subject?: string; qualifier?: string; failure?: string;
    subjectKind?: ActivitySubjectKind; qualifierKind?: ActivitySubjectKind;
    durationMs?: number; subtle?: boolean; detail?: string;
  }>;
  logPath: string;
};
