import { STUCK_LOOP_RUN, type DiagnosticsReport, type Severity } from "./diagnostics-model.js";

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
