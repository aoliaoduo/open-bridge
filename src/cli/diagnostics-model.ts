/** Shared structured contract for the publish-safe diagnostics pipeline. */

/** The same tool this many calls in a row is a loop, not a workload. */
export const STUCK_LOOP_RUN = 5;

export type Severity = "critical" | "investigate" | "info";

export interface ArtifactRow {
  name: string;
  present: boolean;
  bytes: number | null;
  age_ms: number | null;
  /** One sentence a maintainer can act on, rendered from `status` by healthProse. */
  health: string;
  /** The structured facts `health` restates — and the only thing buildFindings
   *  reads back. Set on the rows whose health a finding consults; undefined
   *  means the row carries no machine-readable state, never a guessed one. */
  status?: ArtifactStatus | undefined;
}

/**
 * The machine-readable half of an artifact row, keyed by which artifact it
 * describes. This is the single source for both halves of the report:
 * healthProse renders the sentence from it, and buildFindings reads `state`
 * off it. The prose is therefore output only — re-wording a health sentence
 * can no longer move a conclusion, because no finding ever parses the text.
 */
export type ArtifactStatus =
  | { kind: "secrets"; state: "absent" | "no-route-token" | "wired"; routeTokenRecords: number }
  | { kind: "runtime"; state: "alive" | "stale" | "no-live-process"; pid: number | undefined }
  | { kind: "serve-lock"; state: "held" | "stale" | "starting"; pid: number | undefined };

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
