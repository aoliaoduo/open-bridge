/**
 * Client for the local Bridge console API.
 */
// The settings shapes are imported, not restated: the server owns the
// contract (src/bridge/settings-model.ts) and the console consumes it, so the
// two cannot drift apart. Deleting the local copies also surfaced a real
// drift - the console's token row was missing `permanent` and nothing noticed.
import type {
  SecretPayload,
  SettingsActionResult,
  SettingsState,
  SettingsTokenRow,
} from "../../src/bridge/settings-model.js";
import type { ServiceView } from "../../src/bridge/service-tools.js";

export type { SecretPayload, ServiceView, SettingsActionResult, SettingsState, SettingsTokenRow };

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
  allowed_directories: string[];
  active_sessions: number;
  active_commands: number;
  tool_profile: string;
  tool_count: number;
  auth_enabled: boolean;
  locks: { held: number; waiting: number };
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
  /** When this session handshook — the row's 「首次连接」. */
  connected_at: string;
  /** Requests served on this session since it connected. */
  calls: number;
  last_used: string;
  /** Milliseconds since this session's last request — the reason to show the table. */
  idle_ms: number;
  active_requests: number;
  todos: number;
}

export interface LockRow { key: string; mode?: string; label?: string; held_ms?: number }
export interface LockWaiter { keys?: string[]; mode?: string; label?: string; waited_ms?: number }

/** Same shape the 状态 card summarises, in full (src/bridge/resource-locks.ts). */
export interface LockSnapshot { held: LockRow[]; waiting: LockWaiter[] }

export interface ToolView { name: string; description: string; core: boolean }
export interface ToolCatalog { profile: string; count: number; tools: ToolView[] }

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
  if (data === undefined) throw new Error(`GET ${path} → 响应不是有效 JSON (HTTP ${res.status})`);
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
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `POST ${path} → HTTP ${res.status}`);
  return data;
}

export const api = {
  status: () => getJson<{ status: BridgeStatus }>("/api/status").then(r => r.status),
  activity: () => getJson<{ activity: ActivityEntry[] }>("/api/activity").then(r => r.activity),
  usage: () => getJson<{ usage: UsageStats }>("/api/usage").then(r => r.usage),
  settings: () => getJson<{ state: SettingsState }>("/api/settings").then(r => r.state),
  bridgeStart: () => postJson<{ status: BridgeStatus }>("/api/bridge/start").then(r => r.status),
  bridgeStop: () => postJson<{ status: BridgeStatus }>("/api/bridge/stop").then(r => r.status),
  bridgeRotate: () => postJson<{ status: BridgeStatus }>("/api/bridge/rotate").then(r => r.status),
  settingsAction: (action: Record<string, unknown>) =>
    postJson<SettingsActionResult>("/api/settings/action", action),
  services: () => getJson<{ services: ServiceView[] }>("/api/services").then(r => r.services),
  sessions: () => getJson<{ sessions: SessionView[]; locks: LockSnapshot }>("/api/sessions"),
  closeSession: (id: string) =>
    postJson<{ closed: string; sessions: SessionView[] }>("/api/sessions/close", { id }),
  tools: () => getJson<ToolCatalog>("/api/tools"),
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
