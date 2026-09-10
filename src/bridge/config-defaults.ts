/**
 * Canonical configuration defaults for Open Bridge.
 *
 * The VS Code settings manifest no longer declares these keys — the graphical
 * settings page is the ONLY settings surface — so this table is the single
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
  autoStart: false,
  toolProfile: "full",
  "auth.enabled": false,
  "auth.tokenTtlSeconds": 0,
  "concurrency.enabled": true,
  "concurrency.holdTimeoutMs": 300_000,
  "concurrency.waitTimeoutMs": 120_000,
};
