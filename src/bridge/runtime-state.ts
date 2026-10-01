import type { Server as HttpServer } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ProcessOutputBuffer } from "../process/output-buffer.js";
import { WorkspaceContext } from "../workspace/context.js";
import type { Activity } from "./activity-model.js";

// Runtime limits/defaults. These live with the state they constrain rather than
// in the state facade, so callers can depend on the smallest stable module.
export const MAX_INLINE_OUTPUT = 128 * 1024;
export const DEFAULT_MAX_READ_BYTES = 512 * 1024;
export const DEFAULT_MAX_DIRECTORY_ENTRIES = 500;
export const DEFAULT_MAX_SEARCH_RESULTS = 200;
export const COMMAND_RETENTION_MS = 60 * 60 * 1000;
export const MAX_SESSIONS = 64;
export const MAX_CAPTURED_OUTPUT = 32 * 1024 * 1024;
export const READY_PATTERN_WINDOW_BYTES = 64 * 1024;
export const READY_PATTERN_TEST_TIMEOUT_MS = 500;
export const SERVICE_HEALTH_TIMEOUT_MS = 120_000;
export const SERVICE_PORT_PROBE_TIMEOUT_MS = 30_000;
/** service_status per-service health-check budget; max is SERVICE_HEALTH_TIMEOUT_MS. */
export const SERVICE_STATUS_DEFAULT_TIMEOUT_MS = 5_000;
export const SERVICES_STATE_PREFIX = "openBridge.services.";
export const ROUTE_TOKEN_KEY = "openBridge.routeToken";
export const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 60_000];

export type CommandState = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  output: ProcessOutputBuffer;
  stdoutOutput: ProcessOutputBuffer;
  stderrOutput: ProcessOutputBuffer;
  teeLogPath?: string;
  done: boolean;
  exitCode: number | null;
  command: string;
  cwd: string;
  env: Record<string, string>;
  startedAt: number;
  endedAt?: number;
  restartCount: number;
  autoRestart: boolean;
  maxRestarts: number;
  restartDelayMs: number;
  lastEvent: string;
  activityOwner: "tool" | "process";
  spawnError?: string;
  requestedStop?: "cancelled" | "terminated" | "stopped" | "timed_out";
  restartTimer?: ReturnType<typeof setTimeout>;
  releaseResourceLocks?: () => void;
};

export type SessionState = {
  transport: StreamableHTTPServerTransport;
  mcp?: { notification: (notification: { method: string; params?: unknown }) => Promise<void> | void };
  lastUsed: number;
  connectedAt: number;
  calls: number;
  client?: string;
  todos: unknown[];
  activeRequests: number;
};

export type UsageStats = {
  startedAt: number;
  calls: number;
  successes: number;
  failures: number;
  byTool: Record<string, number>;
};

export type ServiceDefinition = {
  command: string;
  cwd: string;
  env: Record<string, string>;
  group: string;
  port?: number;
  healthUrl?: string;
  logFile?: string;
  autoRestart: boolean;
  maxRestarts: number;
  restartDelayMs: number;
  commandId?: string;
};

export type TunnelRole = "none" | "owner" | "follower" | "blocked";

export const state = {
  server: undefined as HttpServer | undefined,
  tunnel: undefined as ChildProcessWithoutNullStreams | undefined,
  routeToken: "",
  port: 0,
  boundPort: 0,
  commands: new Map<string, CommandState>(),
  sessions: new Map<string, SessionState>(),
  latestSession: undefined as SessionState | undefined,
  modernLastUsed: 0,
  modernSince: 0,
  modernInFlight: 0,
  compatibility: {
    legacyProtocolToolCalls: 0,
    legacyToolAliasCalls: 0,
  },
  notedStaleBuild: false,
  tunnelUrl: "",
  tunnelProvider: "",
  activeWorkspaceRoot: "",
  reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  stopping: false,
  peersRegistered: false,
  publicWatchTimer: undefined as ReturnType<typeof setInterval> | undefined,
  rePublishTimer: undefined as ReturnType<typeof setInterval> | undefined,
  sessionPruneTimer: undefined as ReturnType<typeof setInterval> | undefined,
  tunnelGeneration: 0,
  missingPublicRounds: 0,
  reconnectAttempt: 0,
  tunnelRole: "none" as TunnelRole,
  lifecycleTail: Promise.resolve() as Promise<void>,
  activity: [] as Activity[],
  usage: { startedAt: Date.now(), calls: 0, successes: 0, failures: 0, byTool: {} } as UsageStats,
  runtimeUsage: { calls: 0, successes: 0, failures: 0 },
  todos: [] as Array<{ id: string; title: string; status: string; completedAt?: string }>,
  services: new Map<string, ServiceDefinition>(),
};

/** The active project root is the stable anchor for every relative path. */
export const workspaceContext = new WorkspaceContext();
