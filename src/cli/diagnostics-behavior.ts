/** Audit-log projection used by diagnostics: counts and classes, never payload text. */
import * as fs from "node:fs";
import * as path from "node:path";

import { FAILURE_LINE_PATTERN } from "../bridge/failure-line.js";
import { STUCK_LOOP_RUN, type BehaviorSkeleton } from "./diagnostics-model.js";

/** Read at most this much of the newest audit bytes; older history is counted as skipped. */
const AUDIT_TAIL_BYTES = 8 * 1024 * 1024;
/** How many tools get a repeated-run line each in the report and in the findings. */
const MAX_REPORTED_RUNS = 5;

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
  // The shared envelope pattern (failure-line.ts) stays the wider of the two
  // parsers on purpose: it must also strip whatever older audit rows carry.
  const normalised = message
    .replace(FAILURE_LINE_PATTERN, "")
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
export function buildBehavior(home: string): BehaviorSkeleton {
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
