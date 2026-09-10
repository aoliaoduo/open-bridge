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
  shellPath: "",
  shellArgs: [] as string[],
  unrestrictedFileAccess: true,
  allowedDirectories: [] as string[],
  port: 0,
  publicHealthTimeoutMs: 20_000,
  autoReconnect: true,
  ngrokUseHttpProxy: true,
  toolProfile: "full",
  "auth.enabled": false,
  "auth.tokenTtlSeconds": 0,
  "concurrency.enabled": true,
  "concurrency.holdTimeoutMs": 300_000,
  "concurrency.waitTimeoutMs": 120_000,
};
