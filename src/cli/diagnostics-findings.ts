/** Threshold-based human findings derived only from structured diagnostic facts. */
import { RUNTIME_FILE, SERVE_LOCK_FILE } from "./registry.js";
import type { ArtifactRow, BehaviorSkeleton, Finding } from "./diagnostics-model.js";

/** One in ten calls failing is worth a sentence; below that it is ordinary noise. */
const ERROR_RATIO = 0.1;
/** A ratio needs a denominator before it means anything. */
const MIN_CALLS_FOR_RATIO = 20;

/**
 * What deserves a human's attention. Thresholds are named constants above
 * rather than inline numbers, because a finding that cannot say why it fired is
 * noise, and a threshold nobody can find is a rumour.
 */
export function buildFindings(
  artifacts: ArtifactRow[],
  behavior: BehaviorSkeleton,
  configSubset: Record<string, unknown>,
  timezone: string,
): Finding[] {
  const findings: Finding[] = [];
  const byName = new Map(artifacts.map(artifact => [artifact.name, artifact]));

  // Findings read the rows' structured status, never the health prose: the
  // sentence is rendered output, the state is the fact.
  const secrets = byName.get("secrets.json");
  if (secrets?.status?.state === "no-route-token") {
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

  const staleRecords = artifacts.filter(artifact => RUNTIME_FILE.test(artifact.name) && artifact.status?.state === "stale");
  if (staleRecords.length > 0) {
    findings.push({
      severity: "investigate",
      name: `${String(staleRecords.length)} stale instance record(s)`,
      detail: "A runtime record names a pid that is gone. The instance crashed or was killed without cleanup, and "
        + "`instances` will not list it because that command only reports live ones \u2014 this report is the only place it shows.",
    });
  }

  if (artifacts.some(artifact => SERVE_LOCK_FILE.test(artifact.name) && artifact.status?.state === "stale")) {
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
