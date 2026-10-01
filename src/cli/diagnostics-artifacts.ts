/** Publish-safe projection of the Bridge data directory and behavioural config. */
import * as fs from "node:fs";
import * as path from "node:path";

import { CONFIG_DEFAULTS } from "../bridge/config/config-defaults.js";
import { MAX_AUDIT_LOG_BYTES } from "../bridge/activity.js";
import { ROUTE_TOKEN_KEY } from "../bridge/runtime-state.js";
import { pidAlive, RUNTIME_FILE, SERVE_LOCK_FILE } from "./registry.js";
import type { ArtifactRow, ArtifactStatus } from "./diagnostics-model.js";

/** A lock or runtime record older than this, with no live process, is leftover. */
const STALE_AFTER_MS = 5_000;

/** Size and mtime for one path; all nulls when it is not there. Never throws. */
function statOf(target: string, now: number): { bytes: number | null; mtimeMs: number | null; age_ms: number | null } {
  try {
    const stat = fs.statSync(target);
    return { bytes: stat.size, mtimeMs: stat.mtimeMs, age_ms: Math.max(0, now - stat.mtimeMs) };
  } catch {
    return { bytes: null, mtimeMs: null, age_ms: null };
  }
}

/** Names in the data dir, so the inventory can say what is present but unrecognised. */
function listHome(home: string): string[] {
  try {
    return fs.readdirSync(home);
  } catch {
    return [];
  }
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The settings that describe behaviour without identifying anyone: every flag
 * and every timeout, and no URL, key, path or domain. `notify.barkKey` is a
 * credential, so the most this report will ever say about it is whether one is
 * set — the same rule `get_config` follows.
 */
export function safeConfigSubset(home: string): Record<string, unknown> {
  const config = readJsonFile(path.join(home, "config.json"));
  const get = (key: string, fallback: unknown): unknown => {
    const value = config?.[key];
    return value === undefined ? fallback : value;
  };
  return {
    toolProfile: get("toolProfile", "full"),
    logMaxBytes: get("logMaxBytes", CONFIG_DEFAULTS.logMaxBytes),
    "auth.enabled": get("auth.enabled", CONFIG_DEFAULTS["auth.enabled"]),
    "auth.tokenTtlSeconds": get("auth.tokenTtlSeconds", CONFIG_DEFAULTS["auth.tokenTtlSeconds"]),
    "oauth.enabled": get("oauth.enabled", CONFIG_DEFAULTS["oauth.enabled"]),
    "concurrency.enabled": get("concurrency.enabled", CONFIG_DEFAULTS["concurrency.enabled"]),
    "concurrency.holdTimeoutMs": get("concurrency.holdTimeoutMs", CONFIG_DEFAULTS["concurrency.holdTimeoutMs"]),
    "concurrency.waitTimeoutMs": get("concurrency.waitTimeoutMs", CONFIG_DEFAULTS["concurrency.waitTimeoutMs"]),
    "notify.enabled": get("notify.enabled", CONFIG_DEFAULTS["notify.enabled"]),
    "notify.barkKey": typeof config?.["notify.barkKey"] === "string" && config?.["notify.barkKey"] !== ""
      ? "<set>"
      : "<unset>",
    "sound.enabled": get("sound.enabled", CONFIG_DEFAULTS["sound.enabled"]),
  };
}


/**
 * The health sentence for a status-bearing row, rendered from `status` alone.
 * These strings are the report's contract with its readers, but they are output
 * only: every conclusion in buildFindings reads `status.state`, never this
 * text, so re-wording a sentence cannot silently change what the report claims.
 */
function healthProse(status: ArtifactStatus): string {
  switch (status.state) {
    case "absent": return "Absent: no instance has run against this data dir yet, so there is no route token to lose.";
    case "no-route-token": return "PRESENT WITH NO ROUTE TOKEN: every MCP URL for this machine has stopped working. Content never read.";
    case "wired": return `${String(status.routeTokenRecords)} route token record(s). Content never read, not even redacted.`;
    case "alive": return `Instance record, pid ${String(status.pid)} alive.`;
    case "stale": return status.kind === "serve-lock"
      ? "STALE serve lock: the start wedged or crashed. `serve` will refuse until it is removed."
      : `STALE: pid ${status.pid === undefined ? "unknown" : String(status.pid)} is gone and the record was never cleaned up.`;
    case "no-live-process": return "Instance record; no live process (recently stopped, or mid-cleanup).";
    case "held": return `Serve lock held by the live instance (pid ${String(status.pid)}). Expected while it runs.`;
    case "starting": return "Serve lock with no live instance behind it, recently taken: a start is in progress.";
  }
}

/**
 * Every artifact this report knows about, with the one question each answers.
 * An absent artifact is a row that says so — never a missing row, because
 * "this file does not exist" is itself a diagnostic fact.
 */
export function buildArtifacts(home: string, now: number): ArtifactRow[] {
  const names = listHome(home);
  const rows: ArtifactRow[] = [];
  // Presence is a fact about the disk, never about what this report expected:
  // an artifact that is there gets a row that says so, and one that is not gets
  // a row that says that instead. Guessing here would be the one place in the
  // report where a reader could not trust a column.
  const row = (name: string, health: string, status?: ArtifactStatus | undefined): void => {
    const stat = statOf(path.join(home, name), now);
    rows.push({
      name,
      present: stat.bytes !== null,
      bytes: stat.bytes,
      age_ms: stat.age_ms,
      health,
      status,
    });
  };

  const secretsPath = path.join(home, "secrets.json");
  const secrets = readJsonFile(secretsPath);
  const secretsPresent = statOf(secretsPath, now).bytes !== null;
  const tokenKeys = Object.keys(secrets ?? {}).filter(key => key.startsWith(`${ROUTE_TOKEN_KEY}.`));
  row("config.json", "Settings. This report carries a whitelist subset of it, never a URL, key or domain.");
  row("state.json", "Service definitions, todos and usage counters. Rebuilt state, not identity.");
  // Absent and empty are different facts and only one of them is an emergency:
  // a data dir that never ran an instance has no secrets file at all, while a
  // file that is there with no token in it means every URL just stopped working.
  const secretsStatus: ArtifactStatus = !secretsPresent
    ? { kind: "secrets", state: "absent", routeTokenRecords: 0 }
    : tokenKeys.length === 0
      ? { kind: "secrets", state: "no-route-token", routeTokenRecords: 0 }
      : { kind: "secrets", state: "wired", routeTokenRecords: tokenKeys.length };
  row("secrets.json", healthProse(secretsStatus), secretsStatus);
  // No row for state.json.bak on purpose: nothing in this repo writes one. Both
  // data-dir writers go through a `.<pid>.tmp` file and a rename, so a .bak that
  // turns up came from outside, and the unrecognised bucket below says exactly
  // that instead of this report inventing a cause for it.
  row("audit.log", "Behaviour history. Projected into counts below; no line is copied into this report.");
  row("audit.log.1", "One rotated generation of the audit log.");
  row("bridge-peers.json", "Which instance on this machine owns the shared tunnel.");

  const logs = statOf(path.join(home, "logs", "bridge.log"), now);
  rows.push({
    name: "logs/bridge.log",
    present: logs.bytes !== null,
    bytes: logs.bytes,
    age_ms: logs.age_ms,
    health: "Narrative log. Not read here: it carries command text and paths.",
  });

  let serviceLogCount = 0;
  try {
    serviceLogCount = fs.readdirSync(path.join(home, "service-logs")).length;
  } catch {
    serviceLogCount = 0;
  }
  rows.push({
    name: "service-logs/",
    present: serviceLogCount > 0,
    bytes: null,
    age_ms: null,
    health: `${serviceLogCount} supervised-service log file(s). Not read here.`,
  });

  // One row per instance record, named rather than rooted: which directory an
  // instance serves is the operator's business, not a maintainer's. The pattern
  // is registry.ts's own, so this inventory and `readAllRuntimes` can never
  // disagree about which files are instance records.
  for (const name of names.filter(entry => RUNTIME_FILE.test(entry)).sort()) {
    const stat = statOf(path.join(home, name), now);
    const info = readJsonFile(path.join(home, name));
    const pid = typeof info?.pid === "number" ? info.pid : undefined;
    const alive = pid !== undefined && pidAlive(pid);
    const stale = !alive && stat.age_ms !== null && stat.age_ms > STALE_AFTER_MS;
    const status: ArtifactStatus = alive
      ? { kind: "runtime", state: "alive", pid }
      : stale
        ? { kind: "runtime", state: "stale", pid }
        : { kind: "runtime", state: "no-live-process", pid };
    rows.push({
      name,
      present: true,
      bytes: stat.bytes,
      age_ms: stat.age_ms,
      health: healthProse(status),
      status,
    });
  }

  for (const name of names.filter(entry => SERVE_LOCK_FILE.test(entry)).sort()) {
    const stat = statOf(path.join(home, name), now);
    // Not the 5s staleness rule the data-dir write lock uses: a serve lock is
    // held for the whole life of the instance, so its age says nothing. The
    // question is whether the instance sharing its suffix is still alive.
    const suffix = SERVE_LOCK_FILE.exec(name)?.[1] ?? "";
    const owner = readJsonFile(path.join(home, `runtime-${suffix}.json`));
    const ownerPid = typeof owner?.pid === "number" ? owner.pid : undefined;
    const heldByLiveInstance = ownerPid !== undefined && pidAlive(ownerPid);
    const stale = !heldByLiveInstance && stat.age_ms !== null && stat.age_ms > STALE_AFTER_MS;
    const status: ArtifactStatus = heldByLiveInstance
      ? { kind: "serve-lock", state: "held", pid: ownerPid }
      : stale
        ? { kind: "serve-lock", state: "stale", pid: ownerPid }
        : { kind: "serve-lock", state: "starting", pid: ownerPid };
    rows.push({
      name,
      present: stat.bytes !== null,
      bytes: stat.bytes,
      age_ms: stat.age_ms,
      health: healthProse(status),
      status,
    });
  }

  // Anything present but unrecognised is named, because a file this report does
  // not know about is exactly the file a maintainer needs to hear about.
  const known = new Set(rows.map(entry => entry.name));
  for (const dirName of ["logs", "service-logs"]) known.add(dirName);
  const unrecognised = names
    .filter(name => !known.has(name) && !RUNTIME_FILE.test(name) && !SERVE_LOCK_FILE.test(name))
    .sort();
  if (unrecognised.length > 0) {
    rows.push({
      name: `(unrecognised: ${unrecognised.join(", ")})`,
      present: true,
      bytes: null,
      age_ms: null,
      health: "Present in the data dir and not known to this report. Content never read.",
    });
  }

  // logMaxBytes is logs/bridge.log's ceiling, not this file's: audit.log rotates
  // at MAX_AUDIT_LOG_BYTES, and comparing it against the wrong limit reported a
  // log one rename away from rotating as barely started.
  const audit = rows.find(entry => entry.name === "audit.log");
  if (audit?.bytes !== undefined && audit.bytes !== null) {
    const ratio = audit.bytes / MAX_AUDIT_LOG_BYTES;
    if (ratio >= 0.9) {
      audit.health += ` At ${Math.round(ratio * 100)}% of its ${String(MAX_AUDIT_LOG_BYTES >> 20)} MB rotation limit: about to rotate.`;
    }
  }
  return rows;
}
