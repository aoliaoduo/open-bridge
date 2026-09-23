import type { ActivityStatus } from "../mcp/activity-status.js";
import { host } from "../host/host.js";
import type { Server as HttpServer } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
/**
 * audit.log rotates to audit.log.1 at this size. Exported because it is a
 * different ceiling from config.logMaxBytes, which governs logs/bridge.log:
 * anything reporting how full the audit log is must compare against this one.
 */
export const MAX_AUDIT_LOG_BYTES = 1024 * 1024;
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
   * When a 2026-07-28-era (modern, stateless) request last arrived, 0 if never.
   *
   * Modern-era requests mint no session, so without this clock they would be
   * invisible to every watchdog that reads `state.sessions` (idle and finish
   * notices in notify.ts): a modern-only client kept the Bridge busy forever
   * while both watchdogs saw "nobody connected", and neither bell could ring.
   * A separate field rather than a synthetic session object — the session
   * table drives transport lifecycle and the console, and must not grow
   * entries that own no transport.
   */
  modernLastUsed: 0,
  /**
   * When modern-era traffic FIRST arrived in this process, 0 if never.
   *
   * `modernLastUsed` answers "is anyone there right now"; this answers "since
   * when", which is the half of the handshake a stateless era does not have. The
   * session view needs both to describe a modern caller at all: without a start
   * time the only honest thing it could print for "connected since" was nothing.
   */
  modernSince: 0,
  /**
   * Modern-era requests currently being served, 0 when none.
   *
   * The session table counts this for legacy sessions (`activeRequests`) and the
   * watchdogs read it — "a request in flight is the Bridge being slow, not the
   * human being away". The stateless era had no equivalent, so a modern call
   * that outlasted the ten-minute finish settle window looked exactly like silence:
   * the phone bell announced "the AI stopped" while the AI was waiting on its
   * own `npm run verify`. Counted per request, decremented on the way out.
   */
  modernInFlight: 0,
  /**
   * Whether the "you are running an older build" note has already gone out.
   *
   * Per process, not per session: the fact is about the process, and the modern
   * era has no session to hang it on. A caller that saw it once has the whole
   * signal; repeating it on every result would be noise, and noise gets filtered
   * out exactly like the docs did.
   */
  notedStaleBuild: false,
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
  tunnelProvider: "",
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
  /**
   * The same three counts, this process only. The persisted usage window
   * above survives restarts for the console's diagnostics; the TUI counts
   * from launch so a fresh start does not inherit months-old numbers.
   * Never persisted, never loaded — construction IS the reset.
   */
  runtimeUsage: { calls: 0, successes: 0, failures: 0 },
  /**
   * The current task list (set_todos writes it alongside the persisted store;
   * boot loads it back). The TUI sidebar reads this in-memory copy — the
   * render path never touches storage.
   */
  todos: [] as Array<{ id: string; title: string; status: string; completedAt?: string }>,
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
  const dir = host().storageDir();
  // An empty storage dir means "no disk sink" (unit-test fixtures): without
  // this, path.join("", "audit.log") lands in the process cwd and every test
  // run litters the caller's directory with an audit.log.
  if (!dir) return undefined;
  return path.join(dir, "audit.log");
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

/** Opaque correlation/row identity; UUIDs stay unique across fast parallel calls. */
export function createActivityId(): string {
  return randomUUID();
}

/** Record one tool/activity event into the in-memory log, output channel, view, and audit file. */
export function record(
  tool: string,
  status: Activity["status"],
  message: string,
  argsSummary?: string,
  details?: { changes?: Activity["changes"]; invocationId?: string },
): void {
  const entry = {
    id: createActivityId(),
    ...(details?.invocationId ? { invocation_id: details.invocationId } : {}),
    at: new Date().toISOString(),
    tool,
    status,
    message: redactSensitiveText(message).slice(0, 500),
    ...(argsSummary !== undefined ? { args_summary: argsSummary } : {}),
    ...(details?.changes?.length ? { changes: details.changes } : {}),
  };
  // `at` stays the ISO-8601 UTC instant in every machine-readable surface
  // (activity_log recent, /api/activity, audit.log). Search answers ISO from
  // the audit file; recent used to answer a server-locale wall-clock string
  // for the very same event. Display formatting belongs to the console UI.
  state.activity.unshift({ ...entry, ts: Date.now() });
  state.activity.splice(200);
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
