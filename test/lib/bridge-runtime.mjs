/**
 * Instance-record helpers shared by the integration suites.
 *
 * Runtime records are per workspace root (`runtime-<suffix>.json`), because the
 * app supports one Bridge per directory sharing a single data dir. A suite also
 * has to keep working against the pre-multi-instance layout, so the legacy
 * single `runtime.json` is consulted for its own root only — the same rule the
 * CLI applies.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const suffixFor = root => createHash("sha256").update(root).digest("hex").slice(0, 24);

export const runtimeFileFor = (home, root) => path.join(home, `runtime-${suffixFor(root)}.json`);

/** The record for one root: its own file first, then a legacy file naming it. */
export function readRuntimeFor(home, root) {
  for (const file of [runtimeFileFor(home, root), path.join(home, "runtime.json")]) {
    try {
      const info = JSON.parse(readFileSync(file, "utf8"));
      if (typeof info.port === "number" && info.root && path.resolve(info.root) === path.resolve(root)) return info;
    } catch { /* absent, half-written, or another root's record */ }
  }
  return undefined;
}

/** Waits for a root's listener to be published, then reports its record. */
export async function waitForRuntime(home, root, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const info = readRuntimeFor(home, root);
    if (info && info.port > 0) return info;
    await delay(250);
  }
  throw new Error(`no runtime record for ${root} in ${home} — serve failed to start`);
}

export function routeTokenFor(home, root) {
  const secrets = JSON.parse(readFileSync(path.join(home, "secrets.json"), "utf8"));
  return secrets[`openBridge.routeToken.${suffixFor(root)}`];
}
