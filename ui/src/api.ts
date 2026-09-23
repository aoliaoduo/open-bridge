/**
 * Client for the local Bridge console API.
 */
// The settings shapes are imported, not restated: the server owns the
// contract (src/bridge/config/settings-model.ts) and the console consumes it, so the
// two cannot drift apart. Deleting the local copies also surfaced a real
// drift - the console's token row was missing `permanent` and nothing noticed.
import { t } from "./i18n";
import type {
  ExecutableChoice,
  SecretPayload,
  SettingsActionResult,
  SettingsState,
  SettingsTokenRow,
  SettingsTunnelView,
} from "../../src/bridge/config/settings-model.js";
import type { ServiceView } from "../../src/bridge/tools/service-tools.js";

export type {
  ExecutableChoice, SecretPayload, ServiceView, SettingsActionResult, SettingsState, SettingsTokenRow, SettingsTunnelView,
};

/**
 * The shell's settings-action runner (App.tsx): one POST that applies the
 * fresh state and the toast/secret/copy side effects. Pages receive this
 * instead of calling the api directly so every action lands through the same
 * side-effect path — and so callers can read `result.ok` without a cast.
 */
export type Act = (action: Record<string, unknown>) => Promise<SettingsActionResult | null>;

/**
 * API client for the Open Bridge console.
 *
 * GET endpoints are loopback-only server-side and need no credential. Every
 * POST additionally sends the console token header — the server injects it
 * into this page as a <meta> tag when serving /console/, so it never travels
 * in URLs or localStorage.
 */

export const consoleToken = (): string => document.querySelector<HTMLMetaElement>('meta[name="open-bridge-console-token"]')?.content ?? "";

export interface BridgeStatus {
  state: string;
  /** Build version (package.json), the same string the CLI prints. */
  version?: string;
  /** Loopback MCP URL; absent when the Bridge is stopped. */
  local_url?: string;
  /** The published tunnel URL — absent while the Bridge is local-only. */
  public_url?: string;
  /** owner = this instance runs ngrok; follower = another instance's tunnel forwards to us. */
  tunnel_role?: string;
  /** local = loopback only; public-open = anyone with the URL; public-authed = bearer gate on. */
  exposure?: string;
  /** The URL to hand a client: the tunnel when published, otherwise loopback. */
  mcp_url?: string;
  shell: string;
  workspace_root?: string;
  allowed_directories: string[];
  active_sessions: number;
  active_commands: number;
  tool_profile: string;
  tool_count: number;
  auth_enabled: boolean;
  locks: { held: number; waiting: number };
  /**
   * True when `dist/` was rebuilt after this instance started, so the new code
   * is not live yet. Absent when there is no build to compare (`npm run dev`).
   */
  build_stale?: boolean;
}

export interface ActivityEntry {
  at: string;
  ts?: number;
  tool: string;
  status: "running" | "completed" | "error" | "progress" | "warning";
  message: string;
  args_summary?: string;
  changes?: Array<{ path: string; additions: number; deletions: number }>;
}

export interface UsageStats {
  started_at: string;
  uptime_ms: number;
  calls: number;
  successes: number;
  failures: number;
  by_tool: Record<string, number>;
  tracked_commands: number;
  active_commands: number;
}

export interface SessionView {
  id: string;
  /** clientInfo from the handshake, or 未标识客户端 when the client sent none. */
  client: string;
  /** Older Console servers omit these flags; those rows are legacy sessions. */
  era?: "legacy" | "modern";
  stateless?: boolean;
  closable?: boolean;
  /** A modern activity summary has no handshake or persistent session. */
  connected_at: string | null;
  first_seen?: string;
  /** Requests served on this session; null when no per-session counter exists. */
  calls: number | null;
  last_used: string;
  /** Milliseconds since this session's last request — the reason to show the table. */
  idle_ms: number;
  active_requests: number;
  /** null for stateless activity, which does not own a session todo list. */
  todos: number | null;
}

export interface LockRow { key: string; mode?: string; label?: string; held_ms?: number }
export interface LockWaiter { keys?: string[]; mode?: string; label?: string; waited_ms?: number }

/** Same shape the 状态 card summarises, in full (src/bridge/runtime/resource-locks.ts). */
export interface LockSnapshot { held: LockRow[]; waiting: LockWaiter[] }

/** One entry of the AI's plan, exactly as `set_todos` persisted it. */
export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | string;
  /** 桥在条目转为完成时盖的时间戳；任务页据此显示「多久前完成」。 */
  completedAt?: string;
}

/** The last `report_progress` line, when the agent sent one. */
export interface TodoProgress {
  message: string;
  phase?: string;
  category?: string;
  percent?: number;
  level?: string;
  at?: string;
}

export interface TodoBoard {
  todos: TodoItem[];
  counts: { total: number; pending: number; in_progress: number; completed: number };
  /**
   * True when no live MCP session is driving this list — it is the last plan
   * left behind by a disconnected agent, not work in flight.
   */
  stale: boolean;
  updated_at: string;
  last_progress: TodoProgress | null;
  /**
   * True when the progress line came from a session that is no longer here.
   * Tracked separately from `stale` because the list and the progress line are
   * written by different tools and age independently: a brand-new list can sit
   * above a report left behind by the agent before this one.
   */
  progress_stale?: boolean;
  /** Milliseconds since the driving session's last call; null when stale. */
  idle_ms: number | null;
}

export interface ToolView { name: string; description: string; core: boolean }
export interface ToolCatalog { profile: string; count: number; tools: ToolView[] }

export interface SkillView { name: string; description: string; path: string; dir: string; outside_workspace: boolean }
export interface SkillCatalog { count: number; skills: SkillView[] }

export interface HealthCheck {
  name: string;
  /** ok = fine, warn = 提醒 (a risk, not a defect), fail = 异常. */
  level?: "ok" | "warn" | "fail";
  /** Kept for callers that only need a boolean; false for warn and fail. */
  ok: boolean;
  detail: string;
}
export interface HealthReport { checks: HealthCheck[]; exposure: string }

/** Registered clients + live credential counts; mirrors oauthConsoleView(). */
export interface OAuthClientView {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  client_id_issued_at: number;
}
export interface OAuthConsoleView {
  enabled: boolean;
  issuer: string;
  clients: OAuthClientView[];
  counts: { clients: number; activeAccessTokens: number; activeRefreshTokens: number };
  ownerSource: "env" | "route_token";
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  // Mirror postJson: a non-JSON body (an empty reply from a mid-restart
  // server, a proxy page) must not surface as a raw SyntaxError with the HTTP
  // status lost.
  const data = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
  if (!res.ok) throw new Error(data?.error ?? `GET ${path} → HTTP ${res.status}`);
  if (data === undefined) {
    throw new Error(t(
      `GET ${path} → 响应不是有效 JSON (HTTP ${res.status})`,
      `GET ${path} → response was not valid JSON (HTTP ${res.status})`,
    ));
  }
  return data;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-open-bridge-console": consoleToken(),
    },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => undefined)) as (T & { error?: string }) | undefined;
  if (!res.ok) throw new Error(data?.error ?? `POST ${path} → HTTP ${res.status}`);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    // A broken reply does not prove that the write failed. Keep the existing
    // screen state, report uncertainty, and never replay a mutation here.
    throw new Error(t(
      `POST ${path} → 响应不是有效 JSON 对象 (HTTP ${res.status})；操作结果未知，请刷新核对，勿直接重复提交。`,
      `POST ${path} → response was not a valid JSON object (HTTP ${res.status}); outcome unknown. Refresh to verify before submitting again.`,
    ));
  }
  return data;
}

export const api = {
  status: () => getJson<{ status: BridgeStatus }>("/api/status").then(r => r.status),
  activity: () => getJson<{ activity: ActivityEntry[] }>("/api/activity").then(r => r.activity),
  usage: () => getJson<{ usage: UsageStats }>("/api/usage").then(r => r.usage),
  settings: () => getJson<{ state: SettingsState }>("/api/settings").then(r => r.state),
  /** Read-only tunnel reconnaissance + the plan 「自动配置」 would run. */
  tunnel: () => getJson<{ tunnel: SettingsTunnelView }>("/api/tunnel").then(r => r.tunnel),
  settingsAction: (action: Record<string, unknown>) =>
    postJson<SettingsActionResult>("/api/settings/action", action),
  services: () => getJson<{ services: ServiceView[] }>("/api/services").then(r => r.services),
  sessions: () => getJson<{ sessions: SessionView[]; locks: LockSnapshot }>("/api/sessions"),
  closeSession: (id: string) =>
    postJson<{ closed: string; sessions: SessionView[] }>("/api/sessions/close", { id }),
  todos: () => getJson<TodoBoard>("/api/todos"),
  tools: () => getJson<ToolCatalog>("/api/tools"),
  skills: () => getJson<SkillCatalog>("/api/skills"),
  health: () => getJson<{ health: HealthReport }>("/api/health").then(r => r.health),
  oauth: () => getJson<{ oauth: OAuthConsoleView }>("/api/oauth").then(r => r.oauth),
  serviceAction: (action: "start" | "stop" | "restart", name: string) =>
    postJson<{ result: unknown; services: ServiceView[] }>("/api/services/action", { action, name }),
};

/** Copy via the async clipboard API with a textarea fallback (non-secure contexts). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const el = document.createElement("textarea");
    el.value = text;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    el.remove();
  }
}

/**
 * Full-page reload. A named seam on purpose: tests stub this instead of patching
 * `window.location`, which is fragile — jsdom and the vitest pools disagree about
 * whether it can be redefined.
 */
export function reloadConsole(): void {
  window.location.reload();
}
