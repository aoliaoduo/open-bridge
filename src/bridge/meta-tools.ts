import { host } from "../host/host.js";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { listToolDefinitions } from "./tool-catalog.js";
import { validateNgrokDomain } from "../http/request-policy.js";
import { authStatus } from "../http/auth.js";
import { lockSnapshot } from "./resource-locks.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { auditLogPath, record, state, type LogLevel } from "./state.js";
import type { JsonArgs } from "./json-args.js";
import { notifyLogging } from "./state.js";
import type { SessionState } from "./state.js";
import { root, allowedRoots } from "./paths.js";
import { persistProgress, loadTodoStore } from "./todo-store.js";
import { searchActivityLog } from "../mcp/activity-log.js";
import { shellSpec } from "./processes.js";
import { execFileSync } from "node:child_process";

type Args = JsonArgs;

export function getBridgeStatus(): Record<string, unknown> {
  const shell = shellSpec();
  const locks = lockSnapshot();
  return {
    state: state.server ? "running" : "stopped",
    local_url: state.server ? `http://127.0.0.1:${state.port}/mcp/${state.routeToken}` : undefined,
    public_url: state.publicUrl || undefined,
    shell: shell.file,
    allowed_directories: allowedRoots(),
    active_sessions: state.sessions.size,
    active_commands: [...state.commands.values()].filter(command => !command.done).length,
    tool_profile: host().config.get<string>("toolProfile", "full"),
    // Must report what tools/list actually advertises: the toolProfile filter
    // AND the host-capability filter (a standalone instance has no language
    // server, so editor-only tools are absent from the catalog).
    tool_count: listToolDefinitions().length,
    auth_enabled: host().config.get<boolean>("auth.enabled", false) === true,
    locks: { held: locks.held.length, waiting: locks.waiting.length },
  };
}

/**
 * Auth state for the operator/agent. Token ids, labels and lifetimes only —
 * the secret is never stored, so it can never be read back here (or anywhere).
 */
export async function getAuthStatus(): Promise<Record<string, unknown>> {
  const status = await authStatus();
  return {
    enabled: status.enabled,
    default_ttl_seconds: status.default_ttl_seconds,
    /** Mint/revoke are deliberately local-only: an MCP client cannot issue itself a credential. */
    token_management: "local only — the Open Bridge web console (/console)",
    locked_out_remote_keys: status.locked_out_keys,
    tokens: status.tokens,
  };
}

/** Live concurrency table: what is held, by whom, and what is waiting. */
export function getLockStatus(): Record<string, unknown> {
  const snapshot = lockSnapshot();
  return {
    enabled: host().config.get<boolean>("concurrency.enabled", true) === true,
    hold_timeout_ms: host().config.get<number>("concurrency.holdTimeoutMs", CONFIG_DEFAULTS["concurrency.holdTimeoutMs"] as number),
    wait_timeout_ms: host().config.get<number>("concurrency.waitTimeoutMs", CONFIG_DEFAULTS["concurrency.waitTimeoutMs"] as number),
    held: snapshot.held,
    waiting: snapshot.waiting,
  };
}

export function getConfig(): Record<string, unknown> {
  const cfg = host().config;
  const out: Record<string, unknown> = {};
  // Single source of truth for defaults: the settings manifest no longer
  // declares these keys, so unset values would otherwise surface as null.
  for (const [key, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    out[key] = cfg.get(key, fallback);
  }
  return out;
}

export async function setConfigValue(args: Args): Promise<unknown> {
  const key = String(args.key ?? "").replace(/^openBridge\./, "");
  const allowed = new Set([
    "tunnelProvider", "ngrokDomain", "ngrokExecutable", "shellPath", "shellArgs",
    "unrestrictedFileAccess", "allowedDirectories", "port", "publicHealthTimeoutMs", "autoReconnect",
    "ngrokUseHttpProxy", "autoStart", "toolProfile",
    "auth.enabled", "auth.tokenTtlSeconds",
    "concurrency.enabled", "concurrency.holdTimeoutMs", "concurrency.waitTimeoutMs",
  ]);
  if (!allowed.has(key)) throw new Error(`Unsupported Open Bridge setting: ${key}`);
  let value = args.value;
  // A missing value would "update" the key to undefined and silently reset it
  // to its default, so refuse instead of wiping a setting the user cares about.
  if (value === undefined) throw new Error("value is required. (expected 'value': setting value)");
  if (key === "tunnelProvider") {
    if (value !== "none" && value !== "ngrok") throw new Error("tunnelProvider must be 'none' or 'ngrok'.");
  } else if (key === "toolProfile") {
    if (value !== "full" && value !== "core") throw new Error("toolProfile must be 'full' or 'core'.");
  } else if (key === "ngrokDomain") {
    value = validateNgrokDomain(value);
  } else if (key === "ngrokExecutable" || key === "shellPath") {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string. (expected '${key}': string)`);
    value = value.trim();
  } else if (key === "shellArgs") {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
      throw new Error("shellArgs must be an array of strings.");
    }
  } else if (["unrestrictedFileAccess", "autoReconnect", "ngrokUseHttpProxy", "autoStart", "concurrency.enabled"].includes(key)) {
    if (typeof value !== "boolean") throw new Error(`${key} must be a boolean. (expected '${key}': boolean)`);
  } else if (key === "auth.enabled") {
    if (typeof value !== "boolean") throw new Error("auth.enabled must be a boolean.");
    // Enabling with no usable token would make the endpoint refuse everything
    // (the gate is fail-closed), so refuse the change rather than leave the
    // operator with a Bridge that answers 401 to everyone.
    if (value === true) {
      const status = await authStatus();
      const usable = status.tokens.filter(token => !token.revoked && !token.expired);
      if (!usable.length) {
        throw new Error(
          "Refusing to enable auth: no active token exists. The operator must mint one first "
          + "in the Open Bridge web console (tokens are only shown once, so MCP cannot create them).",
        );
      }
    }
  } else if (["auth.tokenTtlSeconds", "concurrency.holdTimeoutMs", "concurrency.waitTimeoutMs"].includes(key)) {
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new Error(`${key} must be a non-negative integer. (expected '${key}': number)`);
    }
  } else if (key === "allowedDirectories") {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !path.isAbsolute(item))) {
      throw new Error("allowedDirectories must contain absolute path strings. (expected 'allowedDirectories': string[])");
    }
    value = value.map(item => path.resolve(item));
  } else if (key === "port") {
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("port must be an integer between 0 and 65535.");
  } else if (key === "publicHealthTimeoutMs") {
    if (!Number.isInteger(value) || value < 3000 || value > 120000) {
      throw new Error("publicHealthTimeoutMs must be an integer between 3000 and 120000.");
    }
  }
  await host().config.update(key, value);
  return { key: `openBridge.${key}`, value: host().config.get(key, CONFIG_DEFAULTS[key]) };
}

export function getRecentActivity(args: Args): unknown {
  // Number("abc") is NaN, and slice(0, NaN) silently returns nothing at all.
  const requested = args.max_results === undefined ? state.activity.length : Number(args.max_results);
  if (!Number.isFinite(requested) || requested < 0) {
    throw new Error("max_results must be a non-negative number. (expected 'max_results': number)");
  }
  return state.activity.slice(0, Math.floor(requested));
}

export function getUsageStats(): Record<string, unknown> {
  return {
    started_at: new Date(state.usage.startedAt).toISOString(),
    uptime_ms: Date.now() - state.usage.startedAt,
    calls: state.usage.calls,
    successes: state.usage.successes,
    failures: state.usage.failures,
    by_tool: { ...state.usage.byTool },
    tracked_commands: state.commands.size,
    active_commands: [...state.commands.values()].filter(command => !command.done).length,
  };
}

/**
 * One-call project orientation (DevSpace open_workspace bootstrap idea,
 * adapted to the VS Code-anchored model): everything an agent needs to stop
 * exploring blindly at the start of a session.
 */
export function workspaceBrief(): Record<string, unknown> {
  const rootPath = root();
  const brief: Record<string, unknown> = { workspace: rootPath };

  // Top-level layout (hidden entries skipped, capped).
  try {
    const entries = fsSync.readdirSync(rootPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith("."))
      .slice(0, 30)
      .map(e => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
    brief.top_level_entries = entries;
  } catch {
    brief.top_level_entries = [];
  }

  // Project manifests (what kind of project is this).
  const manifests: Record<string, unknown> = {};
  for (const name of ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml"]) {
    try {
      const raw = fsSync.readFileSync(path.join(rootPath, name), "utf8");
      if (name === "package.json") {
        const parsed = JSON.parse(raw) as { name?: unknown; scripts?: Record<string, unknown> };
        manifests[name] = { name: parsed.name ?? null, scripts: Object.keys(parsed.scripts ?? {}) };
      } else {
        manifests[name] = { present: true };
      }
    } catch {
      // absent
    }
  }
  if (Object.keys(manifests).length) brief.manifests = manifests;

  // Instruction files the session already received via instructions.
  const instructionFiles = ["AGENTS.md", "CLAUDE.md"].filter(name => {
    try { return fsSync.statSync(path.join(rootPath, name)).isFile(); } catch { return false; }
  });
  brief.instruction_files = instructionFiles;

  // Git snapshot (branch + dirty file count, best-effort).
  try {
    const gitOpts = { cwd: rootPath, windowsHide: true } as const;
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], gitOpts).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], gitOpts).toString().split("\n").filter(l => l.trim()).length;
    brief.git = { branch, dirty_files: dirty };
  } catch {
    brief.git = { branch: null, dirty_files: null };
  }

  // Bridge-side state worth knowing at session start.
  brief.bridge = {
    tool_count: listToolDefinitions().length,
    tool_profile: host().config.get<string>("toolProfile", "full"),
    active_commands: [...state.commands.values()].filter(c => !c.done).length,
    recent_activity: state.activity.slice(0, 5).map(a => `${a.tool} · ${a.message}`.slice(0, 120)),
  };
  return brief;
}

/**
 * Editor-integration tools (get_diagnostics / lsp) only exist inside a host
 * with language-server access, such as the VS Code extension shell. The
 * standalone Node host reports capabilities.lsp = false, tools/list filters
 * these definitions out, and a direct call gets the clear error below
 * instead of a confusing unknown-tool failure.
 */
function editorOnlyError(tool: string): Error {
  return new Error(
    tool + ' requires an editor host with language-server access (the VS Code extension provides it). '
    + 'The standalone Open Bridge does not ship a language server. '
    + 'Use search_files / read_files as portable alternatives.',
  );
}

export function getDiagnostics(): unknown {
  throw editorOnlyError('get_diagnostics');
}

export async function lsp(): Promise<unknown> {
  throw editorOnlyError('lsp');
}

export function reportProgress(args: Args, session?: SessionState): Record<string, unknown> {
  const message = String(args.message ?? "");
  const level = String(args.level ?? "info");
  // Attach to the explicit todo_id, or to the single in_progress todo when
  // omitted — "report progress on what you are doing" then needs no id lookup.
  const todos = (session?.todos ?? state.latestSession?.todos ?? []) as Array<Record<string, unknown>>;
  const inProgress = todos.filter(t => t && typeof t === "object" && t.status === "in_progress");
  const todoId = typeof args.todo_id === "string" && args.todo_id.trim()
    ? args.todo_id.trim()
    : inProgress.length === 1 ? String(inProgress[0]?.id ?? "") : undefined;
  record("report_progress", "progress", todoId ? `${message} (todo: ${todoId})` : message);
  // Push to the calling client as a standard MCP logging notification (best-effort;
  // request/response-only clients simply ignore it).
  const normalizedLevel = (["debug","info","notice","warning","error"].includes(level) ? level : "info") as LogLevel;
  notifyLogging(session, normalizedLevel, message);
  persistProgress({ message, phase: args.phase, percent: args.percent, level: normalizedLevel });
  return { received: true, message: args.message, phase: args.phase, percent: args.percent, pushed: true, ...(todoId ? { todo_id: todoId } : {}) };
}

export function getTodos(_args?: Args, session?: SessionState): Record<string, unknown> {
  const store = loadTodoStore();
  const sessionTodos = session?.todos ?? state.latestSession?.todos ?? [];
  return {
    session_todos: Array.isArray(sessionTodos) ? sessionTodos : [],
    persisted_todos: Array.isArray(store.todos) ? store.todos : [],
    last_progress: store.lastProgress ?? null,
    persisted_at: store.updatedAt ?? null,
  };
}

export async function searchActivityLogTool(args: Args): Promise<Record<string, unknown>> {
  const result = await searchActivityLog(auditLogPath(), {
    tool: typeof args.tool === "string" ? args.tool : undefined,
    status: typeof args.status === "string" ? args.status : undefined,
    query: typeof args.query === "string" ? args.query : undefined,
    since: args.since !== undefined ? args.since : undefined,
    limit: typeof args.limit === "number" ? args.limit : 50,
    offset: typeof args.offset === "number" ? args.offset : 0,
  });
  return {
    entries: result.entries,
    total_scanned: result.total_scanned,
    truncated: result.truncated,
  };
}

export async function clearActivityLogTool(): Promise<Record<string, unknown>> {
  // Mirror of the VS Code command openBridge.clearLog (clearLog in commands.ts):
  // same three steps, keep the two in sync. Not routed through commands.ts to
  // avoid its vscode clipboard/window surface in the MCP path.
  const cleared = state.activity.splice(0, state.activity.length).length;
  const logPath = auditLogPath();
  let liveTruncated = false;
  let rotatedRemoved = false;
  if (logPath) {
    liveTruncated = await fs.writeFile(logPath, "").then(() => true, () => false);
    const rotatedExisted = await fs.stat(`${logPath}.1`).then(() => true, () => false);
    rotatedRemoved = rotatedExisted
      ? await fs.rm(`${logPath}.1`, { force: true }).then(() => true, () => false)
      : false;
  }
  return { cleared_memory_entries: cleared, live_truncated: liveTruncated, rotated_removed: rotatedRemoved };
}
