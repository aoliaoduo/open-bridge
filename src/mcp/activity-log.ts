/**
 * Audit-log search for the search_activity_log tool.
 *
 * Pure module: the caller supplies the log path (resolved via auditLogPath()),
 * so this file never imports bridge state and stays unit-testable.
 * Both audit.log and its single rotated generation (audit.log.1) are scanned;
 * malformed lines are skipped and missing files count as empty.
 */
import { readFile } from "node:fs/promises";

export interface ActivityLogEntry {
  at: string;
  ts?: number;
  tool: string;
  status: "running" | "completed" | "error" | "progress";
  message: string;
  /** Redacted argument summary (T-1); undefined on entries written before the field existed. */
  args_summary?: string;
}

export interface ActivityLogSearchResult {
  entries: ActivityLogEntry[];
  total_scanned: number;
  truncated: boolean;
}

export interface ActivityLogSearchArgs {
  tool?: string;
  status?: string;
  query?: string;
  since?: string | number;
  limit?: number;
  offset?: number;
}

function toEntry(value: unknown): ActivityLogEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== "string" || !raw.at) return undefined;
  const status = raw.status;
  return {
    at: raw.at,
    ts: typeof raw.ts === "number" ? raw.ts : new Date(raw.at).getTime() || undefined,
    tool: String(raw.tool ?? ""),
    status:
      status === "running" || status === "completed" || status === "error" || status === "progress"
        ? status
        : "completed",
    message: String(raw.message ?? ""),
    args_summary: typeof raw.args_summary === "string" ? raw.args_summary : undefined,
  };
}

function parseSinceMs(value: string | number): number {
  const ms = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(ms)) {
    throw new Error(`since must be an epoch-milliseconds number or an ISO date string; got: ${String(value)}`);
  }
  return ms;
}

function matches(entry: ActivityLogEntry, args: ActivityLogSearchArgs): boolean {
  if (args.tool && entry.tool !== args.tool) return false;
  if (args.status && entry.status !== args.status) return false;
  if (args.query) {
    const q = String(args.query).toLowerCase();
    if (!`${entry.tool} ${entry.message}`.toLowerCase().includes(q)) return false;
  }
  if (args.since !== undefined) {
    const sinceMs = typeof args.since === "number" ? args.since : new Date(String(args.since)).getTime();
    if (Number.isNaN(sinceMs)) return false;
    const entryMs = entry.ts ?? new Date(entry.at).getTime();
    if (entryMs < sinceMs) return false;
  }
  return true;
}

/**
 * Search the audit log newest-first. `logPath` is the live audit.log path;
 * `<logPath>.1` is scanned as the rotated generation when present.
 */
export async function searchActivityLog(
  logPath: string | undefined,
  args: ActivityLogSearchArgs = {},
): Promise<ActivityLogSearchResult> {
  const empty: ActivityLogSearchResult = { entries: [], total_scanned: 0, truncated: false };
  if (!logPath) return empty;
  // Validate before scanning: an unparseable `since` used to slip past the
  // per-line try/catch and silently match nothing ("no activity"), which is a
  // misleading answer rather than an error.
  if (args.since !== undefined) parseSinceMs(args.since);
  const entries: ActivityLogEntry[] = [];
  let totalScanned = 0;
  for (const file of [logPath, `${logPath}.1`]) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue; // missing or unreadable generation counts as empty
    }
    const lines = content.split("\n").filter(line => line.trim().length > 0);
    totalScanned += lines.length;
    for (const line of lines) {
      try {
        const entry = toEntry(JSON.parse(line));
        if (entry && matches(entry, args)) entries.push(entry);
      } catch {
        // skip malformed JSON lines
      }
    }
  }
  entries.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)); // newest first
  const limit = Math.min(Math.max(Number(args.limit ?? 50) || 50, 1), 500);
  const offset = Math.max(Number(args.offset ?? 0) || 0, 0);
  return {
    entries: entries.slice(offset, offset + limit),
    total_scanned: totalScanned,
    truncated: entries.length > offset + limit,
  };
}
