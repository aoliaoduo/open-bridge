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
import type { AutoConfigPlan, TunnelFacts } from "./tunnel-plan.js";
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
  tunnelProvider: { kind: "enum", values: ["none", "ngrok", "tailscale"] },
  toolProfile: { kind: "enum", values: ["full", "core"] },
  ngrokExecutable: { kind: "string", max: 500 },
  tailscaleDomain: { kind: "string", max: 253 },
  tailscaleExecutable: { kind: "string", max: 500 },
  shellPath: { kind: "string", max: 500 },
  allowedDirectories: { kind: "stringArray", maxItems: 50, maxLen: 500 },
  shellArgs: { kind: "stringArray", maxItems: 50, maxLen: 500 },
  port: { kind: "int", min: 0, max: 65535 },
  publicHealthTimeoutMs: { kind: "int", min: 3000, max: 120000 },
  logMaxBytes: { kind: "int", min: 0, max: 1024 * 1024 * 1024 },
  // Notification delivery is intentionally fixed; only the channel switch and server can be edited here.
  // The device key writes through saveNotifyKey and never appears in this read-only view.
  "notify.enabled": { kind: "boolean" },
  "notify.serverUrl": { kind: "string", max: 500 },
  "sound.enabled": { kind: "boolean" },
  "sound.fileWaiting": { kind: "string", max: 500 },
  "sound.fileFinished": { kind: "string", max: 500 },
} as const;

export type SettingsConfigKey = keyof typeof CONFIG_SPEC;

/**
 * Which CONTROL a key gets in the console, where its kind does not already say.
 *
 * The rule the settings page is being simplified under: choose, do not type.
 * A key whose value the machine can find is a pick-list, a key whose value only
 * the network knows is a choice out of what it returned, and a key that is
 * discovered on every start is read-only. Everything else keeps the control its
 * kind implies (boolean → a switch, enum → a select, int → a number…).
 *
 * Declared here, next to the key allowlist rather than in the component that
 * renders it, so a key cannot arrive on the page with an input shape nobody
 * declared — the same reason CONFIG_SPEC is not restated in the console.
 */
const CONFIG_CONTROL_SHAPES = {
  /** A path the machine can find: a list of what was found, plus "auto". */
  ngrokExecutable: "detected-executable",
  tailscaleExecutable: "detected-executable",
  // The ts.net name is filled in from the CLI when the tunnel starts: the card
  // shows it read-only, and the manual override lives in 高级设置.
  tailscaleDomain: "discovered",
} as const;

export type ConfigControlShape = (typeof CONFIG_CONTROL_SHAPES)[keyof typeof CONFIG_CONTROL_SHAPES];

/** The declared control for a key, or undefined when its kind already says. */
export function configControlShape(key: SettingsConfigKey): ConfigControlShape | undefined {
  return (CONFIG_CONTROL_SHAPES as Partial<Record<SettingsConfigKey, ConfigControlShape>>)[key];
}

/** The keys the tunnel card owns, in the order an operator meets them. */
export const TUNNEL_CONFIG_KEYS: readonly SettingsConfigKey[] = [
  "tunnelProvider",
  "ngrokExecutable",
  "tailscaleExecutable",
  "tailscaleDomain",
  "autoReconnect",
  "ngrokUseHttpProxy",
];
// The ngrok domain is NOT in this list on purpose: it is not a generic config
// key at all (validateNgrokDomain owns its grammar, so CONFIG_SPEC excludes it),
// and the card writes it through the dedicated saveDomain flow. Its control is
// still 选择-over-填空 — a list of the account's reserved domains, read from the
// same detection the rest of the card uses.


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
