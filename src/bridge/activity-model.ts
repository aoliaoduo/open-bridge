import type { ActivityStatus } from "../mcp/activity-status.js";

export type Activity = {
  /** Unique identity for this physical log row. */
  id?: string;
  /** Shared by the running and terminal rows of one tool invocation. */
  invocation_id?: string;
  at: string;
  /** Epoch ms for relative-time rendering (the locale `at` string is display-only). */
  ts?: number;
  tool: string;
  status: ActivityStatus;
  message: string;
  /** Redacted argument summary captured at invoke time; absent on old log lines. */
  args_summary?: string;
  /** Per-file patch changes (apply_patch); drives the panel's diff badge. */
  changes?: Array<{ path: string; additions: number; deletions: number }>;
};
