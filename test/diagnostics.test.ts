/**
 * The diagnostic export has one promise that matters more than its contents:
 * what it leaves out.
 *
 * It is written to be pasted into a public issue, so the assertions here are
 * mostly negative — a workspace path, a shell command, an argument value, a
 * route token or the data dir's own path must not appear, no matter what the
 * artifacts contain. That is why the fixtures below are seeded with exactly the
 * things that must not survive, rather than with benign ones.
 *
 * The positive assertions are the other half of the same promise: a projection
 * that dropped everything would also be safe, and just as useless. So each test
 * pairs "this is absent" with "and the fact it stands for is present".
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildDiagnosticsReport, renderDiagnosticsMarkdown } from "../src/cli/diagnostics.js";

let home: string;

/** One audit row, in the shape `record()` actually writes. */
function auditRow(entry: { at?: string; tool: string; status: string; message: string; args_summary?: string }): string {
  return JSON.stringify({ at: entry.at ?? "2026-09-22T10:00:00.000Z", ...entry });
}

function writeAudit(lines: string[]): void {
  writeFileSync(path.join(home, "audit.log"), `${lines.join("\n")}\n`, "utf8");
}

/** A runtime record whose pid is this test process, so it reads as alive. */
function writeLiveRuntime(suffix: string): void {
  writeFileSync(
    path.join(home, `runtime-${suffix}.json`),
    `${JSON.stringify({
      pid: process.pid, port: 18080, root: "C:\\secret\\workspace\\path", startedAt: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
}

function writeDeadRuntime(suffix: string, ageMs: number): void {
  const file = path.join(home, `runtime-${suffix}.json`);
  writeFileSync(file, `${JSON.stringify({
    pid: 4_000_000, port: 1, root: "C:\\secret\\workspace\\path", startedAt: new Date().toISOString(),
  })}\n`, "utf8");
  const past = (Date.now() - ageMs) / 1000;
  utimesSync(file, past, past);
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-diagnostics-"));
  writeFileSync(path.join(home, "config.json"), `${JSON.stringify({
    toolProfile: "core",
    "auth.enabled": true,
    "notify.barkKey": "SUPER-SECRET-BARK-KEY",
    "notify.serverUrl": "https://bark.example.invalid/SECRET-URL",
    "ngrokDomain": "SECRET-DOMAIN.ngrok-free.dev",
  })}\n`, "utf8");
  writeFileSync(path.join(home, "secrets.json"), `${JSON.stringify({
    "openBridge.routeToken.abc123": "TOKEN-PLAINTEXT-MUST-NOT-ESCAPE",
  })}\n`, "utf8");
  writeFileSync(path.join(home, "state.json"), "{}\n", "utf8");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("the report carries the behaviour but none of the sensitive text behind it", () => {
  writeAudit([
    auditRow({ tool: "run_command", status: "running", message: "Started C:\\secret\\workspace\\path\\deploy.ps1" }),
    auditRow({ tool: "run_command", status: "completed", message: "Completed in 12 ms.", args_summary: '{command:"npm run SECRET-COMMAND", path:"C:\\secret\\workspace\\path\\x.ts"}' }),
    auditRow({ tool: "read_files", status: "error", message: "Failed in 3 ms: ENOENT: no such file or directory, open 'C:\\secret\\workspace\\path\\missing.ts'" }),
    auditRow({ tool: "mcp", status: "progress", message: "legacy/other · HTTP 200 · 5ms · sse · session abc123" }),
  ]);

  const markdown = renderDiagnosticsMarkdown(buildDiagnosticsReport(home, "9.9.9-test"));

  // Absent: every string that would identify the operator or the work.
  for (const forbidden of [
    "C:\\secret", "secret\\workspace", "deploy.ps1", "missing.ts", "x.ts",
    "SECRET-COMMAND", "TOKEN-PLAINTEXT-MUST-NOT-ESCAPE", "SUPER-SECRET-BARK-KEY",
    "SECRET-URL", "SECRET-DOMAIN",
  ]) {
    assert.ok(!markdown.includes(forbidden), `the report must not contain ${forbidden}`);
  }
  // The data dir's own path carries the user name on a personal machine.
  assert.ok(!markdown.includes(home), "the report must not contain the data dir path");

  // Present: the facts those strings stood for.
  assert.match(markdown, /Tool calls 3/, "the three tool rows are counted; the mcp row is transport");
  assert.match(markdown, /`run_command` — 2/);
  assert.match(markdown, /`read_files` — 1/);
  assert.match(markdown, /ENOENT/, "the error survives as a class");
  // Three tool rows: one running, one completed, one error. The mcp row is
  // transport, counted in its own section and never here.
  assert.match(markdown, /completed=1/, "status counts are kept");
  assert.match(markdown, /running=1/);
  assert.match(markdown, /error=1/);
  assert.match(markdown, /Requests 1/, "the transport row is counted separately");
  assert.match(markdown, /legacy=1/, "and classified by era");
  assert.match(markdown, /200=1/);
});

test("error classes aggregate by cause, not by how long the failure took", () => {
  // The bridge's envelope is `Failed in <N> ms: <reason>`. Classifying on the
  // prefix before the first colon yields one class per duration, which is the
  // bug this pins: ten identical failures must not read as ten problems.
  const rows: string[] = [];
  for (const ms of [1, 2, 3, 0, 12, 117, 1568]) {
    rows.push(auditRow({ tool: "search_files", status: "error", message: `Failed in ${ms} ms: query is required.` }));
  }
  rows.push(auditRow({ tool: "read_files", status: "error", message: "Failed in 4 ms: ENOENT: no such file, open 'C:\\a\\b.ts'" }));
  writeAudit(rows);

  const report = buildDiagnosticsReport(home, "9.9.9-test");
  const classes = new Map(report.behavior.error_classes);

  assert.equal(classes.get("query is required."), 7, "one cause, one class, all seven in it");
  assert.equal(classes.get("ENOENT"), 1, "a system code wins over the prose around it");
  assert.ok(
    !report.behavior.error_classes.some(([name]) => /Failed in/.test(name)),
    "the envelope is not a class",
  );
});

test("unparsable audit lines are counted, and never quoted", () => {
  writeAudit([
    auditRow({ tool: "wait", status: "completed", message: "Completed in 5 ms." }),
    '{"at":"2026-09-22T10:00:01.000Z","tool":"run_command","message":"torn write C:\\secret\\path',
    "not json at all",
  ]);

  const report = buildDiagnosticsReport(home, "9.9.9-test");
  const markdown = renderDiagnosticsMarkdown(report);

  assert.equal(report.behavior.entries_parsed, 1);
  assert.equal(report.behavior.entries_unparsable, 2);
  assert.match(markdown, /2 unparsable audit line\(s\)/);
  // The finding's own wording says "torn write", so assert on the fixture's
  // payload rather than on a phrase the report legitimately uses about itself.
  assert.ok(!markdown.includes("C:\\secret\\path"), "the broken line's own text is not reproduced");
});

test("a serve lock held by a live instance is not called stale", () => {
  writeLiveRuntime("a1b2c3d4e5f60718293a4b5c");
  const lock = path.join(home, "serve-a1b2c3d4e5f60718293a4b5c.lock");
  writeFileSync(lock, String(process.pid), "utf8");
  // Old on purpose: the rule that used to fire here was an age threshold, and a
  // serve lock is held for the whole life of the instance, so age means nothing.
  const past = (Date.now() - 3_600_000) / 1000;
  utimesSync(lock, past, past);
  writeAudit([]);

  const report = buildDiagnosticsReport(home, "9.9.9-test");
  const markdown = renderDiagnosticsMarkdown(report);
  const row = report.artifacts.find(artifact => artifact.name === "serve-a1b2c3d4e5f60718293a4b5c.lock");

  assert.ok(row, "the lock is inventoried under its own name");
  assert.ok(row.health.includes("held by the live instance"), `got: ${row.health}`);
  assert.ok(!markdown.includes("STALE serve lock"));
  assert.equal(report.instances.alive, 1);
  assert.equal(report.instances.stale, 0);
  // The instance's workspace root is in that runtime record and must not leak.
  // Asserted as a path, not as the word "secret": `secrets.json` is a file name
  // this report legitimately prints, and a substring check on it would be
  // testing the inventory rather than the leak.
  assert.ok(!markdown.includes("C:\\secret"), "no workspace root from a runtime record");
  assert.ok(!markdown.includes("workspace\\path"), "nor any fragment of it");
});

test("a serve lock with no live instance behind it is stale, and says so", () => {
  writeDeadRuntime("ffffffffffffffffffffffff", 60_000);
  const lock = path.join(home, "serve-ffffffffffffffffffffffff.lock");
  writeFileSync(lock, "4000000", "utf8");
  const past = (Date.now() - 60_000) / 1000;
  utimesSync(lock, past, past);
  writeAudit([]);

  const report = buildDiagnosticsReport(home, "9.9.9-test");
  const markdown = renderDiagnosticsMarkdown(report);

  assert.match(markdown, /STALE serve lock/);
  assert.equal(report.instances.stale, 1, "the dead runtime record is stale too");
  assert.ok(
    report.findings.some(finding => finding.name === "stale serve lock" && finding.severity === "investigate"),
  );
});

test("a secrets.json with no token in it is critical, because it is the failure with no error message", () => {
  writeFileSync(path.join(home, "secrets.json"), "{}\n", "utf8");
  writeAudit([]);

  const report = buildDiagnosticsReport(home, "9.9.9-test");

  const finding = report.findings.find(entry => entry.name === "secrets.json holds no route token");
  assert.equal(finding?.severity, "critical");
  assert.match(renderDiagnosticsMarkdown(report), /PRESENT WITH NO ROUTE TOKEN/);
});

test("a data dir that never ran an instance is unused, not broken", () => {
  // The distinction the critical finding depends on: an absent secrets file is
  // the state of every fresh install, while a present-but-empty one means the
  // tokens were lost. Reporting the first as the second cries wolf on a machine
  // that has simply never been used.
  rmSync(path.join(home, "secrets.json"), { force: true });
  writeAudit([]);

  const report = buildDiagnosticsReport(home, "9.9.9-test");

  assert.ok(
    !report.findings.some(entry => entry.severity === "critical"),
    "nothing is critical about an unused data dir",
  );
  const unused = report.findings.find(entry => entry.name === "no secrets.json in this data dir");
  assert.equal(unused?.severity, "info");
});

test("a repeated run is reported once per tool, in calls rather than rows", () => {
  const rows: string[] = [];
  // Six invocations, each writing a running row and a terminal row: twelve rows
  // that must read as six calls, or the threshold is really half of what it says.
  for (let index = 0; index < 6; index += 1) {
    rows.push(auditRow({ tool: "read_files", status: "running", message: "Reading." }));
    rows.push(auditRow({ tool: "read_files", status: "completed", message: "Completed in 1 ms." }));
  }
  writeAudit(rows);

  const report = buildDiagnosticsReport(home, "9.9.9-test");
  const markdown = renderDiagnosticsMarkdown(report);

  assert.deepEqual(report.behavior.repeated_runs, [{ tool: "read_files", count: 6 }]);
  // The finding renders as "**investigate** — read_files called 6 times in a row".
  assert.equal(markdown.match(/read_files called 6 times in a row/g)?.length, 1, "one finding, not two");
});

test("an absent artifact is a row that says so, never a missing row", () => {
  writeAudit([]);

  const report = buildDiagnosticsReport(home, "9.9.9-test");
  const byName = new Map(report.artifacts.map(artifact => [artifact.name, artifact]));

  // Not created by the fixture, so genuinely absent.
  assert.equal(byName.get("bridge-peers.json")?.present, false);
  assert.equal(byName.get("bridge-peers.json")?.bytes, null);
  // Present but not expected: presence is read off the disk, not off a plan.
  writeFileSync(path.join(home, "state.json.bak"), "{}\n", "utf8");
  const again = buildDiagnosticsReport(home, "9.9.9-test");
  const bak = again.artifacts.find(artifact => artifact.name === "state.json.bak");
  assert.equal(bak?.present, true);
  assert.ok((bak?.bytes ?? 0) > 0);
  // A fresh backup is evidence; an old one is residue. This one is fresh.
  assert.equal(again.findings.find(finding => finding.name === "state.json.bak is present")?.severity, "investigate");
});

test("an empty data dir still produces a readable report", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "ob-diagnostics-empty-"));
  try {
    const report = buildDiagnosticsReport(empty, "9.9.9-test");
    const markdown = renderDiagnosticsMarkdown(report);

    assert.equal(report.behavior.calls, 0);
    assert.equal(report.behavior.entries_unparsable, 0);
    assert.equal(report.instances.records, 0);
    // An empty data dir is an unused one, so it must not look like a broken one.
    assert.ok(
      !report.findings.some(finding => finding.severity === "critical"),
      "no critical finding for a data dir nothing has used",
    );
    assert.match(markdown, /no tool calls in the window read/);
    assert.match(markdown, /Absent: no instance has run against this data dir/);
    assert.match(markdown, /## Not in this report/, "the exclusions are stated even when there is nothing to exclude");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the settings subset keeps flags and drops credentials", () => {
  writeAudit([]);

  const report = buildDiagnosticsReport(home, "9.9.9-test");
  const subset = report.config_subset;

  assert.equal(subset.toolProfile, "core", "behavioural settings are the point of the section");
  assert.equal(subset["auth.enabled"], true);
  assert.equal(subset["notify.barkKey"], "<set>", "a credential is reported as a fact about itself");
  assert.ok(!("notify.serverUrl" in subset), "a URL is not a setting this report will carry");
  assert.ok(!("ngrokDomain" in subset), "nor a domain");
  // auth.enabled is true here, so the "gate is off" note must not fire.
  assert.ok(!report.findings.some(finding => finding.name === "the bearer gate is off"));
});
