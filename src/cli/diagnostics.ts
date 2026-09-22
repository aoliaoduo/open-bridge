/**
 * The shareable diagnostic: a whitelist projection of this machine's Bridge
 * artifacts into one Markdown file an operator can paste into an issue.
 *
 * Why this is a projection and not an export. `audit.log` is already scrubbed
 * for tunnel URLs, route tokens and `Authorization` headers, but that scrubber
 * is a denylist: it has nothing to say about a workspace path, a shell command
 * or a file's contents, and `args_summary` carries exactly those. Shipping the
 * log would ship them. So this module never copies a message, an argument or a
 * path out of any artifact — it counts, classifies and measures, and emits only
 * fields this file names. Safe by construction rather than by scrubbing, which
 * is the only kind of safe that survives someone adding a new field upstream.
 *
 * Reads the data dir, not the live instance, for two reasons: the report is
 * needed most when the instance is wedged or will not start, and the artifacts
 * outlive the process that wrote them. Nothing here imports `node-host.ts` —
 * `config.json` is read as the plain JSON it is, so this stays a local-state
 * command with no host to install.
 *
 * Reports only, never repairs. A finding is a sentence for a human; nothing in
 * this module deletes a stale lock, rotates a log or restarts anything.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { CONFIG_DEFAULTS } from "../bridge/config-defaults.js";
import { MAX_AUDIT_LOG_BYTES, ROUTE_TOKEN_KEY } from "../bridge/state.js";
import { pidAlive, resolveHome, RUNTIME_FILE, SERVE_LOCK_FILE } from "./registry.js";
import { t } from "../bridge/cli-i18n.js";
import { fail, type ParsedArgs } from "./args.js";
import { VERSION } from "./version.js";

/** Read at most this much of the newest audit bytes; older history is counted as skipped. */
const AUDIT_TAIL_BYTES = 8 * 1024 * 1024;
/** A lock or runtime record older than this, with no live process, is leftover. */
const STALE_AFTER_MS = 5_000;
/** One in ten calls failing is worth a sentence; below that it is ordinary noise. */
const ERROR_RATIO = 0.1;
/** A ratio needs a denominator before it means anything. */
const MIN_CALLS_FOR_RATIO = 20;
/** The same tool this many *calls* in a row is a loop, not a workload. */
const STUCK_LOOP_RUN = 5;
/** How many tools get a repeated-run line each in the report and in the findings. */
const MAX_REPORTED_RUNS = 5;

export type Severity = "critical" | "investigate" | "info";

export interface ArtifactRow {
  name: string;
  present: boolean;
  bytes: number | null;
  age_ms: number | null;
  /** One sentence a maintainer can act on. */
  health: string;
}

export interface Finding {
  severity: Severity;
  name: string;
  detail: string;
}

export interface TransportFacts {
  requests: number;
  by_era: Record<string, number>;
  by_http_status: Record<string, number>;
  failures: number;
}

export interface BehaviorSkeleton {
  /** Tool calls: audit rows whose tool is not one of the bridge's own narrators. */
  calls: number;
  by_tool: Record<string, number>;
  by_status: Record<string, number>;
  /** Error messages reduced to their class ("ENOENT", "lock wait timed out"). */
  error_classes: Array<[string, number]>;
  /** Longest run per tool, in calls: the shape of a stuck agent loop. */
  repeated_runs: Array<{ tool: string; count: number }>;
  /** Audit rows that carried an invocation id. Not every row does, so this is a
   *  floor on distinct invocations, never a count of them. */
  invocations: number;
  entries_parsed: number;
  entries_unparsable: number;
  audit_window: { first_at: string | null; last_at: string | null };
  audit_bytes_read: number;
  audit_bytes_skipped: number;
  transport: TransportFacts;
}

export interface DiagnosticsReport {
  generated_at: string;
  home: string;
  environment: {
    version: string;
    node: string;
    platform: string;
    /** Resolved zone plus its offset; an unusable TZ is `doctor`'s subject, not this one's. */
    timezone: string;
  };
  config_subset: Record<string, unknown>;
  instances: { records: number; alive: number; stale: number };
  artifacts: ArtifactRow[];
  findings: Finding[];
  behavior: BehaviorSkeleton;
}

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
function safeConfigSubset(home: string): Record<string, unknown> {
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
 * The newest `AUDIT_TAIL_BYTES` of one audit file. A log that grew past the cap
 * is reported as skipped bytes rather than silently read in full: the report has
 * to stay bounded no matter how long the instance ran.
 */
function readAuditTail(file: string): { text: string; bytes_read: number; bytes_skipped: number } {
  // A descriptor, not a promise FileHandle: this whole module is synchronous so
  // it stays callable from a CLI that has installed no host.
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = size > AUDIT_TAIL_BYTES ? size - AUDIT_TAIL_BYTES : 0;
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString("utf8"), bytes_read: length, bytes_skipped: start };
  } catch {
    return { text: "", bytes_read: 0, bytes_skipped: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * An error message reduced to a class that aggregates, with the volatile parts
 * taken out first.
 *
 * Cutting at the first colon -- the obvious rule -- is wrong here, because the
 * bridge's own envelope is `Failed in 12 ms: <reason>`. That classifies by
 * duration and throws the reason away, so one broken path turns into a dozen
 * singleton classes named after how long each took to fail. Measured on a real
 * data dir: ten classes reading `Failed in 1 ms`, `Failed in 2 ms`, and so on.
 *
 * So the volatile parts go first: quoted spans (where a path or a command's own
 * output lives), then hex identifiers, then every remaining digit. What is left
 * is shape, not instance. A recognised system error code wins outright;
 * otherwise the leading words stand in. Nothing here can carry a path, an id or
 * a duration into a report meant to be published.
 */
function errorClassOf(message: string): string {
  // The bridge's own failure envelope goes first. It distinguishes nothing --
  // every failed call wears one -- and left in place it prefixes every class
  // with the same five words of noise.
  const normalised = message
    .replace(/^Failed in [\d.]+ m?s:\s*/, "")
    .replace(/"[^"]*"/g, '"<q>"')
    .replace(/'[^']*'/g, "'<q>'")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+/g, "N");
  const code = /\b(?:[A-Z][A-Z0-9]{2,}|E[A-Z]{2,})\b/.exec(normalised)?.[0];
  if (code) return code;
  const words = normalised.trim().split(/\s+/).slice(0, 6).join(" ");
  return words.slice(0, 48) || "(empty)";
}

function countInto(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

/**
 * The behavior skeleton: what the Bridge was asked to do, how often it failed,
 * and whether it got stuck — with no argument, path or output text anywhere.
 */
function buildBehavior(home: string): BehaviorSkeleton {
  const byTool: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const errorClasses = new Map<string, number>();
  const byEra: Record<string, number> = {};
  const byHttpStatus: Record<string, number> = {};
  const invocations = new Set<string>();
  const sequence: string[] = [];

  let calls = 0;
  let parsed = 0;
  let unparsable = 0;
  let transportRequests = 0;
  let transportFailures = 0;
  let bytesRead = 0;
  let bytesSkipped = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  // Oldest generation first, so `sequence` is chronological and a run of one
  // tool means consecutive calls rather than two adjacent pages.
  for (const file of ["audit.log.1", "audit.log"]) {
    const tail = readAuditTail(path.join(home, file));
    bytesRead += tail.bytes_read;
    bytesSkipped += tail.bytes_skipped;

    for (const line of tail.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(trimmed);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an entry");
        entry = value as Record<string, unknown>;
      } catch {
        unparsable += 1;
        continue;
      }
      parsed += 1;

      const tool = typeof entry.tool === "string" ? entry.tool : "(unknown)";
      const status = typeof entry.status === "string" ? entry.status : "(unknown)";
      const message = typeof entry.message === "string" ? entry.message : "";
      const at = typeof entry.at === "string" ? entry.at : null;
      if (at) {
        firstAt ??= at;
        lastAt = at;
      }
      if (typeof entry.invocation_id === "string") invocations.add(entry.invocation_id);

      // The bridge's own narrators describe the transport, not a tool call.
      if (tool === "mcp") {
        transportRequests += 1;
        const era = /^(legacy|modern)\//.exec(message)?.[1];
        if (era) countInto(byEra, era);
        const httpStatus = /HTTP (\d{3})/.exec(message)?.[1];
        if (httpStatus) countInto(byHttpStatus, httpStatus);
        if (/HTTP [45]\d\d/.test(message)) transportFailures += 1;
        continue;
      }
      if (tool === "bridge" || tool === "process") {
        countInto(byStatus, status);
        if (status === "error") {
          const key = errorClassOf(message);
          errorClasses.set(key, (errorClasses.get(key) ?? 0) + 1);
        }
        continue;
      }

      calls += 1;
      countInto(byTool, tool);
      countInto(byStatus, status);
      // One invocation writes a `running` row and a terminal row, so counting
      // both would double every run and report two calls where one happened.
      // Only terminal rows go into the sequence; `running` left behind by a
      // crash is exactly the row that must not extend a run.
      if (status !== "running") sequence.push(tool);
      if (status === "error") {
        const key = errorClassOf(message);
        errorClasses.set(key, (errorClasses.get(key) ?? 0) + 1);
      }
    }
  }

  const repeatedRuns: Array<{ tool: string; count: number }> = [];
  for (let index = 0; index < sequence.length;) {
    const tool = sequence[index] as string;
    let end = index + 1;
    while (end < sequence.length && sequence[end] === tool) end += 1;
    const count = end - index;
    if (count >= STUCK_LOOP_RUN) repeatedRuns.push({ tool, count });
    index = end;
  }
  repeatedRuns.sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  // One line per tool, keeping its longest run: two runs of the same tool are
  // the same observation, and a report that repeats itself reads as two problems.
  const longestPerTool = new Map<string, number>();
  for (const run of repeatedRuns) {
    const seen = longestPerTool.get(run.tool);
    if (seen === undefined || run.count > seen) longestPerTool.set(run.tool, run.count);
  }
  const deduped = [...longestPerTool.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));

  return {
    calls,
    by_tool: byTool,
    by_status: byStatus,
    error_classes: [...errorClasses.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10),
    repeated_runs: deduped.slice(0, MAX_REPORTED_RUNS),
    invocations: invocations.size,
    entries_parsed: parsed,
    entries_unparsable: unparsable,
    audit_window: { first_at: firstAt, last_at: lastAt },
    audit_bytes_read: bytesRead,
    audit_bytes_skipped: bytesSkipped,
    transport: {
      requests: transportRequests,
      by_era: byEra,
      by_http_status: byHttpStatus,
      failures: transportFailures,
    },
  };
}

/**
 * Every artifact this report knows about, with the one question each answers.
 * An absent artifact is a row that says so — never a missing row, because
 * "this file does not exist" is itself a diagnostic fact.
 */
function buildArtifacts(home: string, now: number): ArtifactRow[] {
  const names = listHome(home);
  const rows: ArtifactRow[] = [];
  // Presence is a fact about the disk, never about what this report expected:
  // an artifact that is there gets a row that says so, and one that is not gets
  // a row that says that instead. Guessing here would be the one place in the
  // report where a reader could not trust a column.
  const row = (name: string, health: string): void => {
    const stat = statOf(path.join(home, name), now);
    rows.push({
      name,
      present: stat.bytes !== null,
      bytes: stat.bytes,
      age_ms: stat.age_ms,
      health,
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
  row("secrets.json", !secretsPresent
    ? "Absent: no instance has run against this data dir yet, so there is no route token to lose."
    : tokenKeys.length === 0
      ? "PRESENT WITH NO ROUTE TOKEN: every MCP URL for this machine has stopped working. Content never read."
      : `${tokenKeys.length} route token record(s). Content never read, not even redacted.`);
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
    rows.push({
      name,
      present: true,
      bytes: stat.bytes,
      age_ms: stat.age_ms,
      health: alive
        ? `Instance record, pid ${String(pid)} alive.`
        : stale
          ? `STALE: pid ${pid === undefined ? "unknown" : String(pid)} is gone and the record was never cleaned up.`
          : "Instance record; no live process (recently stopped, or mid-cleanup).",
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
    rows.push({
      name,
      present: stat.bytes !== null,
      bytes: stat.bytes,
      age_ms: stat.age_ms,
      health: heldByLiveInstance
        ? `Serve lock held by the live instance (pid ${String(ownerPid)}). Expected while it runs.`
        : stale
          ? "STALE serve lock: the start wedged or crashed. `serve` will refuse until it is removed."
          : "Serve lock with no live instance behind it, recently taken: a start is in progress.",
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

/**
 * What deserves a human's attention. Thresholds are named constants above
 * rather than inline numbers, because a finding that cannot say why it fired is
 * noise, and a threshold nobody can find is a rumour.
 */
function buildFindings(
  artifacts: ArtifactRow[],
  behavior: BehaviorSkeleton,
  configSubset: Record<string, unknown>,
  timezone: string,
): Finding[] {
  const findings: Finding[] = [];
  const byName = new Map(artifacts.map(artifact => [artifact.name, artifact]));

  const secrets = byName.get("secrets.json");
  if (secrets?.health.startsWith("PRESENT WITH NO ROUTE TOKEN")) {
    findings.push({
      severity: "critical",
      name: "secrets.json holds no route token",
      detail: "Every MCP URL for this machine has stopped working, and nothing in the UI says why. "
        + "Starting an instance in the affected workspace mints a new token, which changes the URL.",
    });
  } else if (secrets?.present === false) {
    findings.push({
      severity: "info",
      name: "no secrets.json in this data dir",
      detail: "Normal for a data dir no instance has used yet. If one has, --home or OPEN_BRIDGE_HOME "
        + "is pointing somewhere other than where the Bridge actually writes.",
    });
  }

  const staleRecords = artifacts.filter(artifact => RUNTIME_FILE.test(artifact.name) && artifact.health.startsWith("STALE"));
  if (staleRecords.length > 0) {
    findings.push({
      severity: "investigate",
      name: `${String(staleRecords.length)} stale instance record(s)`,
      detail: "A runtime record names a pid that is gone. The instance crashed or was killed without cleanup, and "
        + "`instances` will not list it because that command only reports live ones \u2014 this report is the only place it shows.",
    });
  }

  if (artifacts.some(artifact => SERVE_LOCK_FILE.test(artifact.name) && artifact.health.startsWith("STALE"))) {
    findings.push({
      severity: "investigate",
      name: "stale serve lock",
      detail: "A start wedged or crashed while holding the lock. `serve` refuses to start until the lock file is gone.",
    });
  }

  if (behavior.entries_unparsable > 0) {
    findings.push({
      severity: "investigate",
      name: `${behavior.entries_unparsable} unparsable audit line(s)`,
      detail: "A torn write or an interleaved append. The count is reported, the lines are not: they may carry paths.",
    });
  }

  const errors = behavior.by_status.error ?? 0;
  if (behavior.calls >= MIN_CALLS_FOR_RATIO && errors / behavior.calls >= ERROR_RATIO) {
    findings.push({
      severity: "investigate",
      name: `${errors} of ${behavior.calls} tool calls errored`,
      detail: `That is ${Math.round((errors / behavior.calls) * 100)}% of the audit window read for this report. `
        + "The classes below say which kind of failure dominates.",
    });
  }

  for (const run of behavior.repeated_runs.slice(0, 3)) {
    findings.push({
      severity: "investigate",
      name: `${run.tool} called ${run.count} times in a row`,
      detail: "The shape of an agent loop that is not making progress. Counted in invocations, not audit rows, "
        + "and which call it was is deliberately not reported.",
    });
  }

  if (behavior.audit_bytes_skipped > 0) {
    findings.push({
      severity: "info",
      name: "audit history was cut for this report",
      detail: `${behavior.audit_bytes_skipped} older byte(s) were not read; counts cover the newest `
        + `${behavior.audit_bytes_read} byte(s) only.`,
    });
  }

  if (/^Etc\//.test(timezone) || timezone.startsWith("(unresolved)")) {
    findings.push({
      severity: "info",
      name: "the timezone is a derived fixed offset",
      detail: `${timezone} has no DST rule, so every timestamp in this report and in the logs is a fixed `
        + "shift of UTC. `open-bridge doctor` explains the TZ value that caused it.",
    });
  }

  if (configSubset["auth.enabled"] === false) {
    findings.push({
      severity: "info",
      name: "the bearer gate is off",
      detail: "Whether that is exposure depends on the tunnel, which only a running instance knows "
        + "(`bridge_status.exposure`). Off is the shipped default, not a defect.",
    });
  }

  return findings;
}

/** Everything this report knows how to say about one data dir. Never throws. */
export function buildDiagnosticsReport(home: string, version: string): DiagnosticsReport {
  const now = Date.now();
  const configSubset = safeConfigSubset(home);
  const artifacts = buildArtifacts(home, now);
  const behavior = buildBehavior(home);
  // Not readAllRuntimes(): it filters to LIVE instances, so a stale count
  // derived from it is always zero and the field says nothing. The artifact rows
  // already checked each record's pid, so the truth is counted off them.
  const runtimeRows = artifacts.filter(artifact => RUNTIME_FILE.test(artifact.name));
  const aliveCount = runtimeRows.filter(artifact => artifact.health.includes("alive")).length;
  const instances = {
    records: runtimeRows.length,
    alive: aliveCount,
    stale: runtimeRows.length - aliveCount,
  };
  const offsetMinutes = -new Date().getTimezoneOffset();
  const offset = `${offsetMinutes >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(offsetMinutes) % 60).padStart(2, "0")}`;
  const timezone = `${Intl.DateTimeFormat().resolvedOptions().timeZone || "(unresolved)"} (${offset})`;

  return {
    generated_at: new Date(now).toISOString(),
    home,
    environment: {
      version,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      timezone,
    },
    config_subset: configSubset,
    instances,
    artifacts,
    findings: buildFindings(artifacts, behavior, configSubset, timezone),
    behavior,
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, investigate: 1, info: 2 };

function sortedCounts(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function ageOf(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function bytesOf(value: number | null): string {
  return value === null ? "-" : String(value);
}

/**
 * The Markdown an operator pastes. English on purpose: the audience is whoever
 * picks up the issue, and every identifier in it is already English. The
 * exclusions are listed in the document itself, so a reader can tell a
 * deliberate boundary from an oversight instead of trusting the header.
 */
export function renderDiagnosticsMarkdown(report: DiagnosticsReport): string {
  const lines: string[] = [];
  const { behavior, environment } = report;

  lines.push("# Open Bridge diagnostics");
  lines.push("");
  lines.push("A whitelist projection: counts, classes and measurements. No audit line, argument, workspace path,");
  lines.push("command text, log content or secret is reproduced here, so this file is safe to publish in an issue.");
  lines.push("");
  lines.push(`Generated ${report.generated_at} · open-bridge ${environment.version} · node ${environment.node}`);
  lines.push(`Platform ${environment.platform} · timezone ${environment.timezone}`);
  // The data dir's own path is deliberately not printed: on a personal machine
  // it carries the user name, and this file exists to be pasted into a public
  // issue. What is in it is the inventory below, which is the useful half.
  void report.home;
  lines.push(`Instances: ${report.instances.records} record(s), ${report.instances.alive} alive, ${report.instances.stale} stale`);
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  if (report.findings.length === 0) {
    lines.push("Nothing crossed a threshold. That is a statement about the window read, not a clean bill of health.");
  } else {
    for (const finding of [...report.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
      lines.push(`- **${finding.severity}** — ${finding.name}: ${finding.detail}`);
    }
  }
  lines.push("");

  lines.push("## Artifacts");
  lines.push("");
  lines.push("| artifact | present | bytes | age | what it answers |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const artifact of report.artifacts) {
    lines.push(`| \`${artifact.name}\` | ${artifact.present ? "yes" : "no"} | ${bytesOf(artifact.bytes)} | ${ageOf(artifact.age_ms)} | ${artifact.health} |`);
  }
  lines.push("");

  lines.push("## Behaviour skeleton");
  lines.push("");
  lines.push(`Tool calls ${behavior.calls} · audit rows parsed ${behavior.entries_parsed} · unparsable ${behavior.entries_unparsable}`);
  lines.push(`Rows carrying an invocation id ${behavior.invocations} (a floor on distinct invocations, not a count of them)`);
  const window = behavior.audit_window;
  lines.push(`Audit window ${window.first_at ?? "(none)"} .. ${window.last_at ?? "(none)"}`);
  lines.push(`Bytes read ${behavior.audit_bytes_read} · older bytes skipped ${behavior.audit_bytes_skipped}`);
  lines.push("");
  lines.push(`By status: ${sortedCounts(behavior.by_status).map(([key, value]) => `${key}=${String(value)}`).join(", ") || "(none)"}`);
  lines.push("");
  lines.push("Top tools:");
  lines.push("");
  for (const [tool, count] of sortedCounts(behavior.by_tool).slice(0, 15)) {
    lines.push(`- \`${tool}\` — ${String(count)}`);
  }
  if (sortedCounts(behavior.by_tool).length === 0) lines.push("- (no tool calls in the window read)");
  lines.push("");
  lines.push("Error classes (quoted spans, hex ids and digits normalised away, so one cause is one class):");
  lines.push("");
  for (const [key, count] of behavior.error_classes) {
    lines.push(`- \`${key}\` — ${String(count)}`);
  }
  if (behavior.error_classes.length === 0) lines.push("- (none)");
  lines.push("");
  lines.push(`Repeated runs (>= ${String(STUCK_LOOP_RUN)} consecutive calls of one tool, longest run per tool):`);
  lines.push("");
  for (const run of behavior.repeated_runs) {
    lines.push(`- \`${run.tool}\` x${String(run.count)}`);
  }
  if (behavior.repeated_runs.length === 0) lines.push("- (none)");
  lines.push("");

  const transport = behavior.transport;
  lines.push("## Transport");
  lines.push("");
  lines.push(`Requests ${transport.requests} · 4xx/5xx ${transport.failures}`);
  lines.push(`By era: ${sortedCounts(transport.by_era).map(([key, value]) => `${key}=${String(value)}`).join(", ") || "(none)"}`);
  lines.push(`By HTTP status: ${sortedCounts(transport.by_http_status).map(([key, value]) => `${key}=${String(value)}`).join(", ") || "(none)"}`);
  lines.push("");

  lines.push("## Settings subset");
  lines.push("");
  for (const [key, value] of Object.entries(report.config_subset)) {
    lines.push(`- \`${key}\`: ${JSON.stringify(value)}`);
  }
  lines.push("");

  lines.push("## Not in this report");
  lines.push("");
  lines.push("- `secrets.json` content — route tokens and hashed personal tokens. Not read, so not redacted either.");
  lines.push("- Audit `message` and `args_summary` text — they carry workspace paths, shell commands and file names.");
  lines.push("- `logs/bridge.log` and `service-logs/*` content — narrative text, same reason.");
  lines.push("- Workspace roots, the directory each instance serves, and this data dir's own path.");
  lines.push("- Tunnel and MCP URLs, ngrok or Tailscale domains, and every credential.");
  lines.push("");
  lines.push("Deliberate: a denylist scrubber has nothing to say about a path or a command, so this report");
  lines.push("emits only the fields it names. `open-bridge doctor` covers the environment, `open-bridge health`");
  lines.push("a running instance, and `bridge_status` the live view an MCP client can ask for.");
  lines.push("");

  return lines.join("\n");
}


/**
 * `open-bridge diagnostics [--out FILE]`
 *
 * Writes the report and prints where it went plus anything worth acting on. The
 * file is the deliverable — it is what gets pasted into an issue — so stdout
 * stays short enough to read standing up.
 *
 * Overwrites rather than appends, and defaults to a fixed name inside the data
 * dir: a diagnostic that accumulated one run per invocation would eventually be
 * the largest file in there, and the one anybody filing an issue actually wants
 * is the newest.
 *
 * Works with no instance running, and installs no host. The artifacts outlive
 * the process that wrote them, and the moment this command is most useful is
 * the moment `serve` will not come up.
 */
export async function cmdDiagnostics(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  try {
    fs.mkdirSync(home, { recursive: true });
  } catch (error) {
    fail(t(`无法访问数据目录 ${home}: ${error instanceof Error ? error.message : String(error)}`,
      `Cannot access the data dir ${home}: ${error instanceof Error ? error.message : String(error)}`));
  }

  const report = buildDiagnosticsReport(home, VERSION);
  const markdown = renderDiagnosticsMarkdown(report);

  const flag = parsed.flags.get("out");
  const target = typeof flag === "string" && flag.trim()
    ? path.resolve(flag.trim())
    : path.join(home, "diagnostics.md");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdown, "utf8");
  } catch (error) {
    fail(t(`写入诊断文件失败 ${target}: ${error instanceof Error ? error.message : String(error)}`,
      `Could not write the diagnostic file ${target}: ${error instanceof Error ? error.message : String(error)}`));
  }

  console.log(`${t("已写入", "Wrote")} ${target} (${String(Buffer.byteLength(markdown, "utf8"))} bytes)`);
  console.log(t(
    "白名单投影：不含审计行原文、参数、工作区路径、命令文本、日志内容与任何密钥，可直接公开。",
    "A whitelist projection: no audit line, argument, workspace path, command text, log content or secret. Safe to publish.",
  ));

  const actionable = report.findings.filter(finding => finding.severity !== "info");
  if (actionable.length === 0) {
    console.log(t("没有越过阈值的发现。", "No finding crossed a threshold."));
    return;
  }
  console.log(t(
    `${String(actionable.length)} 项需要看一眼：`,
    `${String(actionable.length)} worth a look:`,
  ));
  for (const finding of actionable) {
    console.log(`  [${finding.severity === "critical" ? "!!" : " ?"}] ${finding.name}`);
  }
}
