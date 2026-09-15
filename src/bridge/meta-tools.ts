import { host } from "../host/host.js";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { listToolDefinitions } from "./tool-catalog.js";
import { validateNgrokDomain } from "../http/request-policy.js";
import { authStatus } from "../http/auth.js";
import { lockSnapshot } from "./resource-locks.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { SETTING_VALUE_REQUIRED, maskBarkKey, validateConfigValue } from "./config-values.js";
import { auditLogPath, clientMcpUrl, localMcpUrl, record, state } from "./state.js";
import type { JsonArgs } from "./json-args.js";
import { notifyLogging } from "./state.js";
import type { SessionState } from "./state.js";
import { root, allowedRoots, currentWorkspaceRoot } from "./paths.js";
import { persistProgress, loadTodoStore } from "./todo-store.js";
import { normalizeCategory, normalizeLevel, normalizePhase } from "./progress-vocabulary.js";
import { searchActivityLog } from "../mcp/activity-log.js";
import { shellSpec } from "./processes.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverWorkspaceSkills } from "./skills.js";
import { buildStaleness } from "./build-staleness.js";

type Args = JsonArgs;

const execFileAsync = promisify(execFile);

export function getBridgeStatus(): Record<string, unknown> {
  const shell = shellSpec();
  const locks = lockSnapshot();
  return {
    state: state.server ? "running" : "stopped",
    /**
     * Which directory this instance serves. Instances are one-per-directory and
     * share a data dir, so "which workspace am I talking to" is a real question
     * for anyone juggling two of them — the console shows it, the CLI shows it,
     * and a client can ask.
     */
    workspace_root: currentWorkspaceRoot(),
    local_url: localMcpUrl() || undefined,
    /** Only ever a real published tunnel; absent while the Bridge is local-only. */
    public_url: state.tunnelUrl || undefined,
    /**
     * How that public URL is served: "owner" (this instance runs ngrok),
     * "follower" (another instance on this machine holds the domain and
     * forwards to us — the URL dies with it), "blocked"/"none" (no tunnel).
     * The console says so, because "公网地址可用" alone hides that dependency.
     */
    tunnel_role: state.tunnelRole,
    /** The URL to hand a client: the tunnel when published, otherwise loopback. */
    mcp_url: clientMcpUrl() || undefined,
    shell: shell.file,
    allowed_directories: allowedRoots(),
    /**
     * Legacy sessions only — they are the ones holding a slot and a transport.
     * Modern-era callers have no session at all, so the count alone used to read
     * as "nobody is connected" while one was mid-conversation. The clock beside it
     * is what makes the difference visible in a single object: `active_sessions: 0`
     * with a recent `modern_last_used` says "stateless traffic", not "idle".
     */
    active_sessions: state.sessions.size,
    modern_last_used: state.modernLastUsed > 0 ? new Date(state.modernLastUsed).toISOString() : null,
    active_commands: [...state.commands.values()].filter(command => !command.done).length,
    tool_profile: host().config.get<string>("toolProfile", "full"),
    // Must report what tools/list actually advertises: the toolProfile filter
    // AND the host-capability filter (a standalone instance has no language
    // server, so editor-only tools are absent from the catalog).
    tool_count: listToolDefinitions().length,
    /** The same string `open-bridge --version` prints: one version everywhere. */
    version: host().version(),
    /**
     * True when `dist/` on disk was rebuilt after this process loaded its
     * modules: the running instance is still executing the old code, so new
     * tools and fixes are not live yet. Absent under `npm run dev`, where
     * there is no build to compare with — absent, not false, because "no
     * signal" and "up to date" are different statements.
     */
    build_stale: buildStaleness()?.stale,
    auth_enabled: host().config.get<boolean>("auth.enabled", false) === true,
    /**
     * What guards this instance right now. "public-open" means anyone holding
     * the URL can read and write files, run commands and drive services on this
     * machine — no restriction is applied here, but the console and the CLI say
     * it out loud rather than leaving the operator to infer it from a URL.
     */
    exposure: state.tunnelUrl
      ? (host().config.get<boolean>("auth.enabled", false) === true ? "public-authed" : "public-open")
      : "local",
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
  // The Bark device key is a SEND-ONLY credential: echoing it into an MCP
  // response would hand the remote client a path it could curl directly,
  // bypassing the audit, the mode gate and the rate budget. Like the token
  // secrets, it is displayed as a shape, never whole.
  if (typeof out["notify.barkKey"] === "string" && out["notify.barkKey"]) {
    out["notify.barkKey"] = maskBarkKey(out["notify.barkKey"] as string);
  }
  return out;
}

/**
 * Echo back ONE canonical shape after a write. The Bark key is the one
 * credential this path can touch: a set/rotate echo is otherwise the friendliest
 * confirmation and a leaked key is a silent push channel the holder can use
 * outside the server's own gates (maskBarkKey lives in config-values where the
 * console shares exactly one rule).
 */
function echoConfigValue(key: string): unknown {
  if (key === "notify.barkKey") {
    const value = host().config.get(key, CONFIG_DEFAULTS[key]);
    return typeof value === "string" && value ? maskBarkKey(value) : "";
  }
  return host().config.get(key, CONFIG_DEFAULTS[key]);
}

export async function setConfigValue(args: Args): Promise<unknown> {
  const key = String(args.key ?? "").replace(/^openBridge\./, "");
  const value = args.value;
  // A missing value would "update" the key to undefined and silently reset it
  // to its default, so refuse instead of wiping a setting the user cares about.
  if (value === undefined) throw new Error(SETTING_VALUE_REQUIRED);
  if (key === "ngrokDomain") {
    // Node-only branch: shares validateNgrokDomain with the console's
    // saveDomain flow (same function, so the two cannot drift).
    const domain = validateNgrokDomain(value);
    await host().config.update(key, domain);
    return { key: `openBridge.${key}`, value: echoConfigValue(key) };
  }
  // Every other key shares one validator with the console's generic setConfig
  // path (config-values.ts): same rules, same messages, no drift.
  const checked = validateConfigValue(key, value);
  if (!checked.ok) throw new Error(checked.error);
  let next = checked.value;
  if (key === "allowedDirectories") {
    next = (next as string[]).map(item => path.resolve(item));
  }
  if (key === "auth.enabled" && next === true) {
    // Enabling with no usable token would make the endpoint refuse everything
    // (the gate is fail-closed), so refuse the change rather than leave the
    // operator with a Bridge that answers 401 to everyone.
    const status = await authStatus();
    const usable = status.tokens.filter(token => !token.revoked && !token.expired);
    if (!usable.length) {
      throw new Error(
        "Refusing to enable auth: no active token exists. The operator must mint one first "
        + "in the Open Bridge web console (tokens are only shown once, so MCP cannot create them).",
      );
    }
  }
  await host().config.update(key, next);
  return { key: `openBridge.${key}`, value: echoConfigValue(key) };
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
 * adapted to the workspace-anchored model): everything an agent needs to stop
 * exploring blindly at the start of a session.
 */
export async function workspaceBrief(): Promise<Record<string, unknown>> {
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

  // Git snapshot (branch + dirty file count, best-effort). execFile, never
  // execFileSync: this runs on the request path, and a synchronous child call
  // freezes EVERY session for as long as git takes (a wedged index.lock, a
  // huge repo) — the `timeout` option below only bounds the child's lifetime,
  // it does not unblock the loop. Async costs nothing here: the two calls
  // race and the rest of the brief is already assembled.
  try {
    const gitOpts = { cwd: rootPath, windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 * 1024 } as const;
    const [branchOut, statusOut] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], gitOpts),
      execFileAsync("git", ["status", "--porcelain"], gitOpts),
    ]);
    brief.git = {
      branch: branchOut.stdout.trim(),
      dirty_files: statusOut.stdout.split("\n").filter(l => l.trim()).length,
    };
  } catch {
    brief.git = { branch: null, dirty_files: null };
  }

  // Bridge-side state worth knowing at session start.
  brief.bridge = {
    version: host().version(),
    tool_count: listToolDefinitions().length,
    tool_profile: host().config.get<string>("toolProfile", "full"),
    active_commands: [...state.commands.values()].filter(c => !c.done).length,
    recent_activity: state.activity.slice(0, 5).map(a => `${a.tool} · ${a.message}`.slice(0, 120)),
  };

  // Skills the model can follow (see skills.ts). Names only — the index lives in
  // the instructions, and the bodies stay on disk until something reads them.
  const skills = discoverWorkspaceSkills();
  if (skills.skills.length) {
    brief.skills = { count: skills.skills.length, names: skills.skills.slice(0, 10).map(skill => skill.name) };
  }
  return brief;
}

export function reportProgress(args: Args, session?: SessionState): Record<string, unknown> {
  // `message` is required by the schema, and `?? ""` turned a dropped field into
  // a successful no-op: an empty audit entry plus an empty logging notification,
  // with nothing telling the caller the report never happened. Only ABSENCE is
  // refused — an explicit "" still goes through, because phase/category/percent
  // can carry a report on their own.
  if (args.message === undefined || args.message === null) {
    throw new Error('Missing "message": report_progress needs the text to report. (expected \'message\': string)');
  }
  const message = String(args.message);
  // The structured fields are a closed vocabulary; anything outside it is
  // dropped rather than stored (see progress-vocabulary.ts). The free-text
  // `message` is unaffected — it is the human-readable part.
  const level = normalizeLevel(args.level);
  const phase = normalizePhase(args.phase);
  const category = normalizeCategory(args.category);
  // Attach to the explicit todo_id, or to the single in_progress todo when
  // omitted — "report progress on what you are doing" then needs no id lookup.
  const todos = (session?.todos ?? state.latestSession?.todos ?? []) as Array<Record<string, unknown>>;
  const inProgress = todos.filter(t => t && typeof t === "object" && t.status === "in_progress");
  const todoId = typeof args.todo_id === "string" && args.todo_id.trim()
    ? args.todo_id.trim()
    : inProgress.length === 1 ? String(inProgress[0]?.id ?? "") : undefined;
  const detail = [phase, category].filter(Boolean).join("/");
  record("report_progress", "progress", todoId ? `${detail ? `${detail} — ` : ""}${message} (todo: ${todoId})` : (detail ? `${detail} — ${message}` : message));
  // Push to the calling client as a standard MCP logging notification (best-effort;
  // request/response-only clients simply ignore it).
  notifyLogging(session, level, message);
  persistProgress({
    message,
    // Only ever a member of the closed vocabulary, or absent.
    ...(phase ? { phase } : {}),
    ...(category ? { category } : {}),
    percent: args.percent,
    level,
  });
  return {
    received: true,
    message: args.message,
    // Echoed back so a caller can tell whether its value was accepted: an
    // unrecognised phase comes back absent rather than silently coerced.
    ...(phase ? { phase } : {}),
    ...(category ? { category } : {}),
    percent: args.percent,
    pushed: true,
    ...(todoId ? { todo_id: todoId } : {}),
  };
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
  // Three steps — memory entries, the live log file, the rotated generation —
  // done inline, so the MCP path never touches a UI surface.
  // Each step is best-effort; the result reports what actually landed.
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
