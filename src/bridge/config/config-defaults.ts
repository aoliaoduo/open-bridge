/**
 * Canonical configuration defaults for Open Bridge.
 *
 * Shared by the CLI, console and MCP configuration tools. This table owns
 * defaults; config-values.ts owns input validation. New read sites should
 * use these defaults rather than introduce another literal copy.
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
  tailscaleDomain: "",
  tailscaleExecutable: "",
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
   * possession of the tokenized MCP URL grants access in public-open mode, so
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
  /** Bark server origin; loopback http is allowed (development), other http is refused. */
  "notify.serverUrl": "https://api.day.app",
  /**
   * Local audio alert: the other half of "tell me something happened".
   *
   * Bark answers "I am away from the desk"; this answers "I am right here
   * with the tab in the background". Both channels use the same waiting and
   * finished events — only moments when the AI has stopped and needs
   * a human. A chime on every completed todo is how a person ends up
   * disabling the whole thing.
   */
  "sound.enabled": false,
  /** Played when the AI is waiting for the operator's answer. */
  "sound.fileWaiting": "",
  /** Played when an exchange ends. */
  "sound.fileFinished": "",
});
