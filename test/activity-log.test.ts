import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { searchActivityLog } from "../src/mcp/activity-log.js";

function tmpLog(name: string, lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-activity-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

const entry = (tool: string, status: string, message: string, at: string): string =>
  JSON.stringify({ at, tool, status, message });

test("undefined path returns empty result", async () => {
  const r = await searchActivityLog(undefined, {});
  assert.deepEqual(r.entries, []);
  assert.equal(r.total_scanned, 0);
  assert.equal(r.truncated, false);
});

test("missing file returns empty result", async () => {
  const r = await searchActivityLog(path.join(os.tmpdir(), "ob-definitely-missing", "audit.log"), {});
  assert.deepEqual(r.entries, []);
  assert.equal(r.total_scanned, 0);
});

test("malformed lines are skipped, newest first", async () => {
  const f = tmpLog("audit.log", [
    "not json",
    entry("run_command", "completed", "ok", "2026-09-01T00:00:00.000Z"),
    entry("write_file", "error", "boom", "2026-09-02T00:00:00.000Z"),
  ]);
  const r = await searchActivityLog(f, {});
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].tool, "write_file"); // newest first
  assert.equal(r.total_scanned, 3);
  assert.equal(r.truncated, false);
});

test("rotated .1 generation is included", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-activity-"));
  const main = path.join(dir, "audit.log");
  fs.writeFileSync(main, entry("a", "completed", "new", "2026-09-02T00:00:00.000Z") + "\n");
  fs.writeFileSync(`${main}.1`, entry("b", "completed", "old", "2026-09-01T00:00:00.000Z") + "\n");
  const r = await searchActivityLog(main, {});
  assert.equal(r.entries.length, 2);
  assert.equal(r.total_scanned, 2);
});

test("tool/status/query/since filters", async () => {
  const f = tmpLog("audit.log", [
    entry("run_command", "completed", "npm test passed", "2026-09-01T10:00:00.000Z"),
    entry("run_command", "error", "npm test failed", "2026-09-02T10:00:00.000Z"),
    entry("write_file", "completed", "saved foo", "2026-09-03T10:00:00.000Z"),
  ]);
  assert.equal((await searchActivityLog(f, { tool: "write_file" })).entries.length, 1);
  assert.equal((await searchActivityLog(f, { status: "error" })).entries[0].message, "npm test failed");
  assert.equal((await searchActivityLog(f, { query: "npm TEST" })).entries.length, 2); // case-insensitive
  assert.equal((await searchActivityLog(f, { since: "2026-09-02T00:00:00.000Z" })).entries.length, 2);
  const byMs = await searchActivityLog(f, { since: Date.parse("2026-09-03T00:00:00.000Z") });
  assert.equal(byMs.entries.length, 1);
});

test("limit/offset pagination and truncated flag", async () => {
  const lines = Array.from({ length: 5 }, (_, i) =>
    entry("t", "completed", `m${i}`, `2026-09-0${i + 1}T00:00:00.000Z`));
  const f = tmpLog("audit.log", lines);
  const p1 = await searchActivityLog(f, { limit: 2 });
  assert.equal(p1.entries.length, 2);
  assert.equal(p1.entries[0].message, "m4"); // newest first
  assert.equal(p1.truncated, true);
  const p2 = await searchActivityLog(f, { limit: 2, offset: 4 });
  assert.equal(p2.entries.length, 1);
  assert.equal(p2.truncated, false);
});


test("warning audit rows retain their recorded status", async () => {
  const f = tmpLog("audit.log", [entry("run_command", "warning", "slow call", "2026-09-01T00:00:00.000Z")]);
  try {
    const r = await searchActivityLog(f, {});
    assert.equal(r.entries[0]?.status, "warning");
  } finally { fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
});

test("warning filter finds warnings and completed filter excludes them", async () => {
  const f = tmpLog("audit.log", [entry("run_command", "warning", "slow call", "2026-09-01T00:00:00.000Z")]);
  try {
    assert.equal((await searchActivityLog(f, { status: "warning" })).entries.length, 1);
    assert.equal((await searchActivityLog(f, { status: "completed" })).entries.length, 0);
  } finally { fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
});


test("all recorded statuses round-trip and unknown values retain the legacy fallback", async () => {
  const statuses = ["running", "completed", "error", "progress", "warning"];
  const f = tmpLog("audit.log", [...statuses, "future-status"].map(status =>
    entry("run_command", status, status, "2026-09-01T00:00:00.000Z")));
  try {
    const r = await searchActivityLog(f, {});
    for (const status of statuses) {
      assert.equal(r.entries.find(row => row.message === status)?.status, status);
    }
    assert.equal(r.entries.find(row => row.message === "future-status")?.status, "completed");
  } finally { fs.rmSync(path.dirname(f), { recursive: true, force: true }); }
});

test("a present limit must be an integer in 1..500, not silently rewritten", async () => {
  // limit:0 is a legal number the old `|| 50` rewrote into a 50-row page —
  // the exact inversion of a caller probing for matches — and garbage got
  // the same treatment. The schema's own range is 1..500; refuse by name.
  const f = tmpLog("audit.log", [
    entry("t", "completed", "m0", "2026-09-01T00:00:00.000Z"),
    entry("t", "completed", "m1", "2026-09-02T00:00:00.000Z"),
  ]);
  for (const bad of [0, -3, 501, 1.5, Number.NaN]) {
    await assert.rejects(searchActivityLog(f, { limit: bad }), /limit/,
      `limit ${String(bad)} must be refused`);
  }
  assert.equal((await searchActivityLog(f, { limit: 1 })).entries.length, 1);
  assert.equal((await searchActivityLog(f, {})).entries.length, 2, "absent limit keeps the 50 default");
});
