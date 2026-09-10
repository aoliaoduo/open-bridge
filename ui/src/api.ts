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
  /** Loopback MCP URL; absent when the Bridge is stopped. */
  local_url?: string;
  /** The published tunnel URL — absent while the Bridge is local-only. */
  public_url?: string;
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

export interface SettingsTokenRow {
  id: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  use_count: number;
  revoked: boolean;
  expired: boolean;
}

export interface SettingsState {
  running: boolean;
  statusText: string;
  mcpUrl: string;
  configuredDomain: string;
  authEnabled: boolean;
  defaultTtlSeconds: number;
  usableCount: number;
  deadCount: number;
  tokens: SettingsTokenRow[];
  concurrency: { enabled: boolean; holdTimeoutMs: number; waitTimeoutMs: number };
  config: {
    autoStart: boolean;
    unrestrictedFileAccess: boolean;
    allowedDirectories: string[];
    tunnelProvider: string;
    ngrokExecutable: string;
    shellPath: string;
    shellArgs: string[];
    port: number;
    publicHealthTimeoutMs: number;
    autoReconnect: boolean;
    ngrokUseHttpProxy: boolean;
    toolProfile: string;
  };
}

export interface SecretPayload {
  kind: "minted" | "rotated";
  id: string;
  label: string;
  secret: string;
  ttl: string;
}

export interface SettingsActionResult {
  ok: boolean;
  state: SettingsState;
  info?: string;
  error?: string;
  secret?: SecretPayload;
  copyText?: string;
  /** The route token rotated: this document's injected token is stale. */
  reloadRequired?: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
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
