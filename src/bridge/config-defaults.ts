/**
 * Canonical configuration defaults for Open Bridge.
 *
 * Nothing declares these keys any more — the console settings page and
 * `open-bridge config` are the only surfaces — so this table is the single
 * source of truth. New config read sites should read from here instead of
 * restating a literal default.
 */
export const CONFIG_DEFAULTS: Record<string, unknown> = {
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
  "concurrency.enabled": true,
  "concurrency.holdTimeoutMs": 300_000,
  "concurrency.waitTimeoutMs": 120_000,
};
