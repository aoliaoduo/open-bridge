/**
 * Assemble the shareable diagnostics report from independent publish-safe
 * projections. This layer coordinates facts; it does not parse or render them.
 */
import { RUNTIME_FILE } from "./registry.js";
import { buildArtifacts, safeConfigSubset } from "./diagnostics-artifacts.js";
import { buildBehavior } from "./diagnostics-behavior.js";
import { buildFindings } from "./diagnostics-findings.js";
import type { DiagnosticsReport } from "./diagnostics-model.js";

/** Everything this report knows how to say about one data dir. Never throws. */
export function buildDiagnosticsReport(home: string, version: string): DiagnosticsReport {
  const now = Date.now();
  const configSubset = safeConfigSubset(home);
  const artifacts = buildArtifacts(home, now);
  const behavior = buildBehavior(home);
  // Not readAllRuntimes(): it filters to LIVE instances, so a stale count
  // derived from it is always zero and the field says nothing. The artifact rows
  // already checked each record's pid, so the truth is counted off their
  // structured status.
  const runtimeRows = artifacts.filter(artifact => RUNTIME_FILE.test(artifact.name));
  const aliveCount = runtimeRows.filter(artifact => artifact.status?.state === "alive").length;
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
