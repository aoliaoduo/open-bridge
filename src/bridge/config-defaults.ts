/**
 * Canonical configuration defaults for Open Bridge.
 *
 * Nothing declares these keys any more — the console settings page and
 * `open-bridge config` are the only surfaces — so this table is the single
 * source of truth. New config read sites should read from here instead of
 * restating a literal default.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The table ships deeply frozen: `get` hands out copies, so nothing may
 * mutate the canonical values in place — an accidental push() now throws a
 * TypeError at the culprit instead of silently corrupting every default.
 */
export const CONFIG_DEFAULTS: Record<string, unknown> = deepFreeze({
  tunnelProvider: "ngrok",
  ngrokDomain: "",
  ngrokExecutable: "ngrok",
  /** Extra/override path to another instance's peer registry ("" = discover). */
  sharedPeerRegistry: "",
  shellPath: "",
  shellArgs: [] as string[],
  unrestrictedFileAccess: true,
  allowedDirectories: [] as string[],
  port: 0,
  publicHealthTimeoutMs: 20_000,
  autoReconnect: true,
  ngrokUseHttpProxy: true,
  toolProfile: "full",
  /** `logs/bridge.log` rotates to `.1` at this size (0 = never rotate). */
  logMaxBytes: 10 * 1024 * 1024,
  "auth.enabled": false,
  "auth.tokenTtlSeconds": 0,
  /**
   * OAuth 2.1 authorization server. OFF by default, like the bearer gate: the
   * route token inside the MCP URL already authenticates a URL-only client, so
   * this is an opt-in upgrade to per-client, individually revocable credentials
   * — not a new default that could lock an existing client out.
   */
  "oauth.enabled": false,
  /** Extra redirect hosts a dynamically registered client may use ([] = built-in list). */
  "oauth.allowedRedirectHosts": [] as string[],
  "concurrency.enabled": true,
  "concurrency.holdTimeoutMs": 300_000,
  "concurrency.waitTimeoutMs": 120_000,
  /**
   * Phone notifications (Bark). The switch ships ON so "connect and tell my
   * phone" works the moment a key exists, but nothing can push until the
   * operator supplies one — an unset key is its own default-off.
   */
  "notify.enabled": true,
  /** The device key path segment of `https://api.day.app/<key>/…`; "" = not set. */
  "notify.barkKey": "",
  /** `frequent` pushes progress (every completed todo item); `dnd` pushes only attention/done. */
  "notify.mode": "frequent",
  /** Minutes of silence with an open work list before the idle watchdog bells; 0 = off. */
  "notify.idleMinutes": 60,
  /** Bark server origin; loopback http is allowed (development), other http is refused. */
  "notify.serverUrl": "https://api.day.app",
});
