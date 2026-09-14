/**
 * The settings contract: action shapes, page state, validation, labels.
 *
 * Deliberately dependency-free — no host, no bridge state, and imports only
 * from dependency-free sibling modules (`config-values.js`) — so it stays
 * the single definition shared by the HTTP layer (which validates and serves
 * it) and the React console (which imports these types instead of restating
 * them). Two copies of a contract drift; one cannot.
 *
 * Design contract (carried over from the original panel rework):
 *  - three type sizes only (11px labels / 12px body / 11px meta), no more
 *  - rows, not boxes-in-boxes; section separators are the only chrome
 *  - everything is a click: no QuickPick, no InputBox, no command palette.
 *    Two-step inline confirm ("确认?" arms a button for 3s) replaces modal
 *    warnings for destructive token actions.
 *  - the freshly minted secret is held by the HOST (never re-rendered away),
 *    displayed once in a full-page mask with copy + "I saved it" buttons.
 */

import { validateConfigValue } from "./config-values.js";
// Type-only, so the dependency-free rule above still holds: this is erased at
// compile time and the React console can import this file without dragging
// node:fs in behind it.
import type { ExecutableChoice } from "../shell/which.js";

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

/** Config keys the page edits beyond the managed flows (tokens/domain/concurrency). */
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
  port: number;
  publicHealthTimeoutMs: number;
  autoReconnect: boolean;
  ngrokUseHttpProxy: boolean;
  toolProfile: string;
  logMaxBytes: number;
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
  onTaskDone: boolean;
  onFinish: boolean;
  /** A usable key is stored (parsed form non-empty). */
  configured: boolean;
  /** Masked device key for display; "" when unconfigured. */
  keyMask: string;
  /** Canonical Bark server origin actually used for sends. */
  serverUrl: string;
  /** Silence minutes before the idle watchdog bells; 0 = off. */
  idleMinutes: number;
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

/** Everything the settings page shows, pushed by the host as one `state` message. */
export interface SettingsState {
  running: boolean;
  /** Build version from package.json — the console header shows it. */
  version: string;
  statusText: string;
  /** The MCP URL to show and copy — tunnel when published, otherwise loopback. */
  mcpUrl: string;
  configuredDomain: string;
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
  | { command: "clearStats" | "healthCheck" }
  | { command: "saveDomain"; domain: string }
  /** Device key as pasted (bare or full URL — the host parses and validates). */
  | { command: "saveNotifyKey"; key: string }
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

/**
 * Keys the page's generic config writes may touch. Deliberately does NOT
 * include auth/concurrency/domain/TTL: those have dedicated, guarded flows
 * and must never be reachable through the generic path. This is only the key
 * allowlist (plus the bounds the console mirrors); the per-key rules live in
 * config-values.ts, shared with `set_config_value`.
 */
const CONFIG_SPEC = {
  unrestrictedFileAccess: { kind: "boolean" },
  autoReconnect: { kind: "boolean" },
  ngrokUseHttpProxy: { kind: "boolean" },
  // OAuth is a plain on/off switch plus a redirect-host allowlist, so it fits the
  // generic path. The host list is validated as hosts by meta-tools; here it only
  // has to be an array of non-empty strings.
  "oauth.enabled": { kind: "boolean" },
  "oauth.allowedRedirectHosts": { kind: "stringArray", maxItems: 50, maxLen: 253 },
  tunnelProvider: { kind: "enum", values: ["none", "ngrok"] },
  toolProfile: { kind: "enum", values: ["full", "core"] },
  ngrokExecutable: { kind: "string", max: 500 },
  shellPath: { kind: "string", max: 500 },
  allowedDirectories: { kind: "stringArray", maxItems: 50, maxLen: 500 },
  shellArgs: { kind: "stringArray", maxItems: 50, maxLen: 500 },
  port: { kind: "int", min: 0, max: 65535 },
  publicHealthTimeoutMs: { kind: "int", min: 3000, max: 120000 },
  logMaxBytes: { kind: "int", min: 0, max: 1024 * 1024 * 1024 },
  // The switches of the notification card. The DEVICE KEY is deliberately not
  // here: it writes through saveNotifyKey (parse-and-store is a dedicated flow,
  // like saveDomain) and it never appears in the read-only view.
  "notify.enabled": { kind: "boolean" },
  "notify.onTaskDone": { kind: "boolean" },
  "notify.onFinish": { kind: "boolean" },
  "notify.serverUrl": { kind: "string", max: 500 },
  "notify.idleMinutes": { kind: "int", min: 0, max: 1440 },
} as const;

export type SettingsConfigKey = keyof typeof CONFIG_SPEC;


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
    "clearStats", "healthCheck", "saveNotifyKey", "testNotify",
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
    case "saveDomain": {
      // Trim only — a domain with embedded spaces must reach the host's
      // validator as-is so the user sees the refusal instead of a silently
      // rewritten value that can never come up as a tunnel.
      const domain = str(message.domain, 253);
      return domain ? { command, domain } : null;
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
      if (!(CONFIG_SPEC as Record<string, unknown>)[key]) return null;
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
