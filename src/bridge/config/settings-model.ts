/**
 * Shared console action/state types and input validation. Rendering belongs
 * to ui/; value rules are shared with MCP through config-values.ts.
 */

import { validateConfigValue } from "./config-values.js";
import type { AutoConfigPlan, TunnelFacts } from "../tunnel/tunnel-plan.js";
// Type-only: the console can use these shared types without importing the
// executable resolver and its node:fs dependency at runtime.
import type { ExecutableChoice } from "../../shell/which.js";

/** Whitelisted lifetimes for a newly created token (seconds; 0 = permanent). */
export const TTL_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 0, label: "永久（不过期）" },
  { seconds: 30 * 86_400, label: "30 天" },
  { seconds: 7 * 86_400, label: "7 天" },
  { seconds: 86_400, label: "24 小时" },
  { seconds: 3_600, label: "1 小时" },
];

/** Human label for any TTL value; non-listed values fall back to a generic form. */
export function ttlLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "永久";
  const known = TTL_CHOICES.find(choice => choice.seconds === seconds);
  if (known) return known.label.replace(/（.*/, "");
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

/** Public projection of a token record (mirrors publicTokenView in auth-core). */
export interface SettingsTokenRow {
  id: string;
  label: string;
  created_at: string;
  expires_at: string | null;
  permanent: boolean;
  expired: boolean;
  revoked: boolean;
  last_used_at: string | null;
  use_count: number;
}

/** A one-time secret returned by minting or rotating a token. */
export interface SecretPayload {
  kind: "minted" | "rotated";
  id: string;
  label: string;
  /** Shown exactly once in this response; never stored server-side. */
  secret: string;
  ttl: string;
}

/**
 * What one settings action answers with. The console renders `state`
 * unconditionally, so it is always present, even on failure.
 */
export interface SettingsActionResult {
  ok: boolean;
  /** Fresh page state after the action (the console always re-renders). */
  state: SettingsState;
  info?: string;
  error?: string;
  secret?: SecretPayload;
  /** Text the console should copy to the clipboard itself. */
  copyText?: string;
  /** Health-check detail lines, shown under the button that ran it. */
  healthLines?: string[];
  /** Health-check verdict; the console colours the report with it. */
  healthOk?: boolean;
  /**
   * Perform the stop only after this response has been flushed: stopping closes
   * the very socket the response travels over.
   */
  deferStop?: boolean;
  /** The page's injected console token is stale; the console reloads. */
  reloadRequired?: boolean;
}

export interface SettingsConfigView {
  unrestrictedFileAccess: boolean;
  allowedDirectories: string[];
  tunnelProvider: string;
  ngrokExecutable: string;
  shellPath: string;
  shellArgs: string[];
  tailscaleDomain: string;
  tailscaleExecutable: string;
  port: number;
  publicHealthTimeoutMs: number;
  autoReconnect: boolean;
  ngrokUseHttpProxy: boolean;
  toolProfile: string;
  logMaxBytes: number;
  "sound.enabled": boolean;
  "sound.fileWaiting": string;
  "sound.fileFinished": string;
  /** OAuth 2.1 authorization server, off by default like the bearer gate. */
  "oauth.enabled": boolean;
  /** Extra redirect hosts a registered client may use; [] means the built-in list. */
  "oauth.allowedRedirectHosts": string[];
}

/**
 * What the console shows for phone notifications. The device key itself never
 * appears here — only whether one is configured and a mask to recognise it by.
 * Same posture as the bearer tokens: write-only through this surface.
 */
export interface SettingsNotifyView {
  enabled: boolean;
  /** A usable key is stored (parsed form non-empty). */
  configured: boolean;
  /** Masked device key for display; "" when unconfigured. */
  keyMask: string;
  /** Canonical Bark server origin actually used for sends. */
  serverUrl: string;
}

/**
 * What this machine was found to have, so the console can offer a choice
 * instead of an empty text box.
 *
 * Detection runs server-side because only the server can stat the filesystem;
 * the page just renders the list. Both lists may be empty (nothing found, or
 * the defaults view before a host exists), and the page must still work —
 * falling back to free text is the whole reason the text input stays.
 */
export type { ExecutableChoice };

export interface SettingsDetectedView {
  /** Shells that exist here, best first; the first one is what "auto" picks. */
  shells: ExecutableChoice[];
  /** ngrok binaries found on PATH and in the usual install locations. */
  ngrok: ExecutableChoice[];
}

/**
 * What `GET /api/tunnel` answers with: what this machine has for each provider,
 * and what 「自动配置」 would write given that.
 *
 * Its own endpoint rather than a field of the settings state, because producing
 * it means spawning two CLIs and (when a token exists) asking ngrok's API. The
 * settings page must not wait on a probe to render; the tunnel card fills in
 * when the answer lands, and the operator can re-run it with 「重新检测」.
 */
export interface SettingsTunnelView {
  facts: TunnelFacts;
  plan: AutoConfigPlan;
}

/** Everything the settings page shows, pushed by the host as one `state` message. */
export interface SettingsState {
  running: boolean;
  /** Build version from package.json — the console header shows it. */
  version: string;
  statusText: string;
  /** The MCP URL to show and copy — tunnel when published, otherwise loopback. */
  mcpUrl: string;
  configuredDomain: string;
  /** Masked hint for the stored ngrok authtoken; "" when none is saved. */
  ngrokAuthtokenMask: string;
  authEnabled: boolean;
  defaultTtlSeconds: number;
  usableCount: number;
  deadCount: number;
  tokens: SettingsTokenRow[];
  concurrency: { enabled: boolean; holdTimeoutMs: number; waitTimeoutMs: number };
  config: SettingsConfigView;
  notify: SettingsNotifyView;
  detected: SettingsDetectedView;
}

export type SettingsAction =
  | { command: "copyPrompt" | "start" | "stop" | "rotateEndpoint" | "purgeTokens" | "revokeAll" }
  /**
   * 「一键自动配置」 and "look again": the first writes what detection found into
   * the fields that are still EMPTY (never over an operator's own value), the
   * second forces a re-probe when the operator has just installed something.
   */
  | { command: "autoConfigureTunnel" }
  | { command: "refreshTunnelDetect" }
  | { command: "clearStats" }
  | { command: "saveDomain"; domain: string }
  /** Device key as pasted (bare or full URL — the host parses and validates). */
  | { command: "saveNotifyKey"; key: string }
  | { command: "saveNgrokAuthtoken"; token: string }
  | { command: "testSound"; which: "waiting" | "finished" }
  | { command: "stopSound" }
  | { command: "testNotify" }
  | { command: "setAuthEnabled"; enabled: boolean }
  | { command: "setDefaultTtl"; seconds: number }
  | { command: "createToken"; label: string; ttlSeconds: number }
  | { command: "armPublicLock"; label?: string; ttlSeconds?: number }
  | { command: "rotateToken" | "revokeToken" | "deleteToken"; id: string }
  | { command: "setConcurrency"; enabled: boolean; holdTimeoutMs: number; waitTimeoutMs: number }
  | { command: "setConfig"; key: SettingsConfigKey; value: unknown }
  | { command: "copyText"; text: string };

const COMMANDS_WITH_ID: ReadonlySet<string> = new Set(["rotateToken", "revokeToken", "deleteToken"]);
const TTL_SET: ReadonlySet<number> = new Set(TTL_CHOICES.map(choice => choice.seconds));

/** Generic console writes allow only these keys; value rules live in config-values.ts. */
const CONFIG_KEYS = [
  "unrestrictedFileAccess",
  "autoReconnect",
  "ngrokUseHttpProxy",
  "oauth.enabled",
  "oauth.allowedRedirectHosts",
  "tunnelProvider",
  "toolProfile",
  "ngrokExecutable",
  "tailscaleDomain",
  "tailscaleExecutable",
  "shellPath",
  "allowedDirectories",
  "shellArgs",
  "port",
  "publicHealthTimeoutMs",
  "logMaxBytes",
  "notify.enabled",
  "notify.serverUrl",
  "sound.enabled",
  "sound.fileWaiting",
  "sound.fileFinished",
] as const;

export type SettingsConfigKey = (typeof CONFIG_KEYS)[number];
const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS);

/**
 * Validate an inbound console action against a strict allowlist. Anything
 * malformed becomes `null` and is dropped — the browser is untrusted input.
 *
 * The name and the allowlist are both older than this host: in the VS Code
 * extension these arrived as webview `postMessage` payloads, and several
 * entries existed only because a webview cannot reach the system clipboard
 * without asking its host to do it. A browser can, so `copyUrl`, `copySecret`
 * and `dismissSecret` had no sender left, and `ready` had no meaning once the
 * page stopped being handed to it by an editor.
 */
export function normalizeSettingsMessage(raw: unknown): SettingsAction | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as Record<string, unknown>;
  const command = typeof message.command === "string" ? message.command : "";
  const allowed: ReadonlySet<string> = new Set([
    "copyPrompt", "start", "stop", "rotateEndpoint", "saveDomain",
    "setAuthEnabled", "setDefaultTtl", "createToken", "armPublicLock", "rotateToken",
    "revokeToken", "deleteToken", "purgeTokens", "revokeAll",
    "setConcurrency", "setConfig", "copyText",
    "clearStats", "saveNotifyKey", "testNotify",
    "saveNgrokAuthtoken", "testSound", "stopSound",
    "autoConfigureTunnel", "refreshTunnelDetect",
  ]);
  if (!allowed.has(command)) return null;

  const str = (value: unknown, max: number): string =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

  switch (command) {
    case "saveNotifyKey": {
      // The raw paste is kept only to TRIM (a pasted URL with stray whitespace
      // must still parse); an embedded space then reaches the host validator as
      // a refusal, exactly like a malformed domain does. "" means "clear", not
      // "absent", so a non-string key must fall through to null, not to "".
      if (typeof message.key !== "string") return null;
      return { command, key: message.key.trim().slice(0, 500) };
    }
    case "testSound": {
      // Which sound, not a path: a path from the page would let anything the
      // console can reach be played, and the point of the button is to prove
      // the SAVED setting works.
      const which = message.which === "finished" ? "finished" : "waiting";
      return { command, which };
    }
    case "saveNgrokAuthtoken": {
      // Same shape as saveNotifyKey: trim only, and "" means "clear" rather
      // than "absent", so a non-string must fall through to null.
      if (typeof message.token !== "string") return null;
      return { command, token: message.token.trim().slice(0, 500) };
    }
    case "saveDomain": {
      // An explicit empty string clears the domain (local-only on the next
      // ngrok start). Missing or non-string input must never clear it.
      // Trim, but do not truncate: the shared validator must see invalid
      // characters and overlong hostnames instead of a laundered value.
      if (typeof message.domain !== "string") return null;
      return { command, domain: message.domain.trim() };
    }
    case "setAuthEnabled":
      return { command, enabled: message.enabled === true };
    case "setDefaultTtl": {
      const seconds = Number(message.seconds);
      if (!Number.isFinite(seconds) || !TTL_SET.has(seconds)) return null;
      return { command, seconds };
    }
    case "createToken": {
      const label = str(message.label, 100);
      const ttlSeconds = Number(message.ttlSeconds);
      if (!Number.isFinite(ttlSeconds) || !TTL_SET.has(ttlSeconds)) return null;
      return { command, label, ttlSeconds };
    }
    case "armPublicLock": {
      // One step instead of two: mint a token (when there is none) and flip the
      // bearer switch. Label and TTL are both optional — the host falls back to
      // its configured default — so the console can arm the lock from the page
      // that shows the risk, without visiting 令牌 first.
      const label = str(message.label, 100);
      if (message.ttlSeconds === undefined || message.ttlSeconds === null) return { command, label };
      const ttlSeconds = Number(message.ttlSeconds);
      if (!Number.isFinite(ttlSeconds) || !TTL_SET.has(ttlSeconds)) return null;
      return { command, label, ttlSeconds };
    }
    case "rotateToken":
    case "revokeToken":
    case "deleteToken": {
      const id = typeof message.id === "string" ? message.id.trim() : "";
      if (!id || id.length > 64 || !COMMANDS_WITH_ID.has(command)) return null;
      return { command, id } as SettingsAction;
    }
    case "copyText": {
      const text = str(message.text, 512);
      return text ? { command, text } : null;
    }
    case "setConcurrency": {
      const ms = (value: unknown): number | null => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 && n <= 3_600_000 ? Math.floor(n) : null;
      };
      const holdTimeoutMs = ms(message.holdTimeoutMs);
      const waitTimeoutMs = ms(message.waitTimeoutMs);
      if (holdTimeoutMs === null || waitTimeoutMs === null) return null;
      return { command, enabled: message.enabled === true, holdTimeoutMs, waitTimeoutMs };
    }
    case "setConfig": {
      const key = typeof message.key === "string" ? message.key : "";
      if (!CONFIG_KEY_SET.has(key)) return null;
      // Same validator as `set_config_value`: one function, no drift. A
      // rejection here surfaces as the generic "无法识别的操作" — the same
      // shape every invalid console input already gets.
      const checked = validateConfigValue(key, message.value);
      return checked.ok ? { command, key: key as SettingsConfigKey, value: checked.value } : null;
    }
    default:
      return { command } as SettingsAction;
  }
}

/**
 * Gate for the auth toggle. Fail-closed means enabling with zero usable
 * tokens bricks the endpoint for every client, so the host refuses and the
 * page explains.
 */
export function authToggleVerdict(next: boolean, usableCount: number): { allow: boolean; reason?: string } {
  if (!next) return { allow: true };
  if (usableCount > 0) return { allow: true };
  return {
    allow: false,
    reason: "还没有有效令牌。鉴权是「失败关闭」的：直接开启会拒绝所有客户端。先在下方新建一个令牌，再打开这个开关。",
  };
}

// The render layer (webview HTML/CSS/client script) is gone in the standalone
// app: the React console (ui/) re-implements it against the SAME state/action
// contract defined above — SettingsState as GET /api/settings, SettingsAction
// as POST /api/settings/action payloads, with normalizeSettingsMessage kept as
// the server-side validation gate.
