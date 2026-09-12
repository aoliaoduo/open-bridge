import { host } from "../host/host.js";
import type { Server as HttpServer } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ProcessOutputBuffer } from "../process/output-buffer.js";
import { WorkspaceContext } from "../workspace/context.js";

// --- Payload limits (defaults, not capability caps) ---
export const MAX_INLINE_OUTPUT = 128 * 1024;
export const DEFAULT_MAX_READ_BYTES = 512 * 1024;
export const DEFAULT_MAX_DIRECTORY_ENTRIES = 500;
export const DEFAULT_MAX_SEARCH_RESULTS = 200;
export const COMMAND_RETENTION_MS = 60 * 60 * 1000;
export const MAX_SESSIONS = 64;
export const MAX_CAPTURED_OUTPUT = 32 * 1024 * 1024;
export const READY_PATTERN_WINDOW_BYTES = 64 * 1024;
export const READY_PATTERN_TEST_TIMEOUT_MS = 500;
const MAX_AUDIT_LOG_BYTES = 1024 * 1024;
export const SERVICE_HEALTH_TIMEOUT_MS = 120_000;
export const SERVICE_PORT_PROBE_TIMEOUT_MS = 30_000;
/** service_status per-service health-check budget (default); the max is SERVICE_HEALTH_TIMEOUT_MS. */
export const SERVICE_STATUS_DEFAULT_TIMEOUT_MS = 5_000;
export const SERVICES_STATE_PREFIX = "openBridge.services.";
export const ROUTE_TOKEN_KEY = "openBridge.routeToken";
export const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 60_000];

export type CommandState = {
  id: string;
  child: ChildProcessWithoutNullStreams;
  output: ProcessOutputBuffer;
  /** Per-stream capture for optional stdout/stderr split reads; merged `output` stays authoritative for offsets. */
  stdoutOutput: ProcessOutputBuffer;
  stderrOutput: ProcessOutputBuffer;
  /** True when output is mirrored into a user-visible terminal (tee capture + tail -f). */
  visibleTerminal?: boolean;
  /** Persisted service log file the child tees its merged output into (service spawns only). */
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
  /** Set when the underlying spawn failed (ENOENT/EACCES/bad cwd); surfaces the real reason to callers. */
  spawnError?: string;
  requestedStop?: "cancelled" | "terminated" | "stopped" | "timed_out";
  /** Pending auto-restart timer; terminateProcess clears it so a stop always wins over a scheduled restart. */
  restartTimer?: ReturnType<typeof setTimeout>;
  /**
   * Caller-declared resource locks (resource_keys) held for this process's whole
   * lifetime, not just the call that spawned it. Released on exit; a scheduled
   * auto-restart carries the handle over so the resource stays claimed.
   */
  releaseResourceLocks?: () => void;
};

export type Activity = {
  at: string;
  /** Epoch ms for relative-time rendering (the locale `at` string is display-only). */
  ts?: number;
  tool: string;
  status: "running" | "completed" | "error" | "progress" | "warning";
  message: string;
  /** Redacted argument summary captured at invoke time (T-1); absent on old log lines. */
  args_summary?: string;
  /** Per-file patch changes (apply_patch); drives the panel's diff badge. */
  changes?: Array<{ path: string; additions: number; deletions: number }>;
};

export type SessionState = {
  transport: StreamableHTTPServerTransport;
  /** The MCP server bound to this session; used to push logging/progress notifications. */
  mcp?: { notification: (notification: { method: string; params?: unknown }) => Promise<void> | void };
  lastUsed: number;
  /** When this session handshook (`initialize`) — the console's 「首次连接」. */
  connectedAt: number;
  /** Requests served on this session since it connected — the console's 「调用数」. */
  calls: number;
  /** clientInfo from the MCP handshake ("cursor/0.42"), for the console's session table. */
  client?: string;
  todos: unknown[];
  /** In-flight MCP requests on this session; idle-only eviction waits for zero. */
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
  /** Optional explicit log file (workspacePath-resolved); defaults to the globalStorage service-logs path. */
  logFile?: string;
  autoRestart: boolean;
  maxRestarts: number;
  restartDelayMs: number;
  commandId?: string;
};

export type TunnelRole = "none" | "owner" | "follower" | "blocked";

/**
 * All mutable Bridge runtime state lives in one singleton so the feature modules
 * stay stateless functions over shared state. The state layer imports no other
 * bridge module, which keeps the dependency graph acyclic.
 */
export const state = {
  server: undefined as HttpServer | undefined,
  tunnel: undefined as ChildProcessWithoutNullStreams | undefined,
  routeToken: "",
  /** The port the listener is on right now; 0 while stopped. */
  port: 0,
  /**
   * The port the listener last bound, remembered across rebinds.
   *
   * The default config asks for port 0 — an ephemeral port. Without this, the
   * one rebind that remains (reclaiming the shared public domain once a peer
   * releases it) would come up on a brand-new port, moving the instance out from
   * under everything already pointing at it: the console page, the port
   * `runtime.json` advertises to the CLI, and whatever the tunnel forwards to.
   */
  boundPort: 0,
  commands: new Map<string, CommandState>(),
  sessions: new Map<string, SessionState>(),
  latestSession: undefined as SessionState | undefined,
  /**
   * The published tunnel URL — an https:// address, set only while a tunnel is
   * actually live, and cleared the moment it is not.
   *
   * This used to be `publicUrl`, which also held a loopback fallback whenever no
   * tunnel existed. One field carrying two meanings forced every reader to guess
   * which it had: the CLI printed a private address under "public MCP URL", and
   * the health check probed loopback as if it were a tunnel. Storing only the
   * tunnel lets `clientMcpUrl()` derive the URL worth handing out.
   */
  tunnelUrl: "",
  activeWorkspaceRoot: "",
  reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  stopping: false,
  peersRegistered: false,
  publicWatchTimer: undefined as ReturnType<typeof setInterval> | undefined,
  /** Periodically re-asserts our entry in the shared peer registry (heals concurrent-write losses). */
  rePublishTimer: undefined as ReturnType<typeof setInterval> | undefined,
  /** Periodically reclaims idle MCP sessions independent of incoming requests. */
  sessionPruneTimer: undefined as ReturnType<typeof setInterval> | undefined,
  /**
   * Bumped on every stop so reconnect timers from an older lifecycle cannot
   * resurrect a tunnel against a fresh start (ShunCode-style generation guard).
   */
  tunnelGeneration: 0,
  missingPublicRounds: 0,
  reconnectAttempt: 0,
  tunnelRole: "none" as TunnelRole,
  lifecycleTail: Promise.resolve() as Promise<void>,
  activity: [] as Activity[],
  usage: { startedAt: Date.now(), calls: 0, successes: 0, failures: 0, byTool: {} } as UsageStats,
  services: new Map<string, ServiceDefinition>(),
};

/** The active project root is the stable anchor for every relative path. */
export const workspaceContext = new WorkspaceContext();

/** Loopback MCP URL — valid exactly while the server is listening. */
export function localMcpUrl(): string {
  return state.server && state.port
    ? `http://127.0.0.1:${state.port}/mcp/${state.routeToken}`
    : "";
}

/**
 * The URL to hand an MCP client: the published tunnel when there is one,
 * otherwise loopback. Callers that need to know *which* they got should read
 * `state.tunnelUrl` directly rather than inspecting this string.
 */
export function clientMcpUrl(): string {
  return state.tunnelUrl || localMcpUrl();
}

export function redactedPublicUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/mcp/<redacted>`;
  } catch {
    return "<redacted>";
  }
}

export function redactSensitiveText(value: string): string {
  let result = value;
  // Tunnel first: the loopback URL is one of its own substrings only by
  // coincidence, but redacting the longer form first keeps both readable.
  for (const url of [state.tunnelUrl, localMcpUrl()]) {
    if (url) result = result.split(url).join(redactedPublicUrl(url));
  }
  if (state.routeToken) result = result.split(state.routeToken).join("<redacted>");
  result = result.replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)\S+/gi, "$1<redacted>");
  result = result.replace(/([?&](?:token|key|api[_-]?key|secret|password)=)[^&\s]+/gi, "$1<redacted>");
  result = result.replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY))=([^\s"']+)/g, "$1=<redacted>");
  return result;
}

export function auditLogPath(): string | undefined {
  return path.join(host().storageDir(), "audit.log");
}

async function appendAuditEntry(entry: Omit<Activity, "at"> & { at: string }): Promise<void> {
  const logPath = auditLogPath();
  if (!logPath) return;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  try {
    const stat = await fs.stat(logPath);
    if (stat.size >= MAX_AUDIT_LOG_BYTES) {
      // Rotate instead of truncating: keep one previous generation as audit.log.1.
      // A failed rename (a concurrent instance's append holds the file open on
      // Windows) now SKIPS rotation and appends anyway — the next entry retries
      // it. The old truncate fallback destroyed the un-rotated history, which
      // for an audit trail is worse than a temporarily oversized file.
      await fs.rename(logPath, `${logPath}.1`).catch(() => undefined);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`);
}

/** Record one tool/activity event into the in-memory log, output channel, view, and audit file. */
export function record(
  tool: string,
  status: Activity["status"],
  message: string,
  argsSummary?: string,
  details?: { changes?: Activity["changes"] },
): void {
  const entry = {
    at: new Date().toISOString(),
    tool,
    status,
    message: redactSensitiveText(message).slice(0, 500),
    ...(argsSummary !== undefined ? { args_summary: argsSummary } : {}),
    ...(details?.changes?.length ? { changes: details.changes } : {}),
  };
  state.activity.unshift({ ...entry, at: new Date(entry.at).toLocaleTimeString(), ts: Date.now() });
  state.activity.splice(40);
  // Activity recording must never fail a tool call: the log sink and the UI
  // are observers of the work, not part of it.
  try { host().log(`[${tool}] ${status}: ${entry.message}`); } catch { /* sink unavailable */ }
  try { host().ui.update(); } catch { /* no console attached */ }
  void appendAuditEntry(entry).catch(() => undefined);
}

/**
 * Wrap a tool result as MCP structuredContent. Objects pass through; arrays and
 * scalars get an envelope so the value is always a JSON object as the protocol
 * requires. Only used for tools that declare an outputSchema.
 */
export function asStructuredContent(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) return { items: value };
  return { value };
}

/** Serialize a tool result as the single MCP text content block. */
export function text(value: unknown): { content: [{ type: "text"; text: string }] } {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? [], null, 2);
  return { content: [{ type: "text", text: serialized ?? "[]" }] };
}

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

/**
 * Best-effort push of an MCP `notifications/message` (logging) to one session.
 * Standard-compliant clients that hold an open SSE stream surface these as live
 * log/progress lines instead of needing to poll. Never throws: a closed transport
 * or a request/response-only client simply drops the notification.
 */
export function notifyLogging(session: SessionState | undefined, level: LogLevel, message: string): void {
  const server = session?.mcp;
  if (!server) return;
  try {
    const params = { level, data: redactSensitiveText(message).slice(0, 2000), logger: "open-bridge" };
    // notification() takes the full JSON-RPC notification shape ({ method, params }).
    void Promise.resolve(
      server.notification({ method: "notifications/message", params }),
    ).catch(() => undefined);
  } catch {
    /* notifications are advisory only */
  }
}

/** Push a logging notification to the most recently active session (for fire-and-forget producers). */
export function notifyLatestLogging(level: LogLevel, message: string): void {
  notifyLogging(state.latestSession, level, message);
}
