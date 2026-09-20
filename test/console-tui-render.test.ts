/**
 * Serve-console TUI (stage 1): the render layer is pure string math, so the
 * whole layout contract — every line exactly `width` columns, never more than
 * `height` lines, the ainovel-cli vocabulary present — is pinned here without
 * a terminal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { stripAnsi, visualWidth, truncateVisual, padEndVisual } from "../src/console/tui/text.js";
import { healthColor, paint } from "../src/console/tui/theme.js";
import { formatDuration, formatBytes, renderFrame } from "../src/console/tui/render.js";
import { buildSnapshot, type TuiStateView } from "../src/console/tui/snapshot.js";

test("visual width counts CJK as two columns and ignores ANSI", () => {
  assert.equal(visualWidth("中文a"), 5);
  assert.equal(visualWidth(paint("accent", "中文")), 4);
  assert.equal(stripAnsi(paint("error", "✕", { bold: true })), "✕");
});

test("truncateVisual never splits a wide character or exceeds the budget", () => {
  assert.equal(truncateVisual("中文字符串", 5), "中...");
  assert.equal(visualWidth(truncateVisual("中文abc更多", 7)), 7);
  assert.equal(truncateVisual("abc", 2), "ab");
  assert.equal(padEndVisual("中", 4), "中  ");
});

test("health gradient uses the ainovel-cli thresholds", () => {
  assert.equal(healthColor(69), "success");
  assert.equal(healthColor(70), "review");
  assert.equal(healthColor(84), "review");
  // 85 itself is already red — the ported code says >= 85, like the original.
  assert.equal(healthColor(85), "error");
});

test("formatters are stable and unit-friendly", () => {
  assert.equal(formatDuration(754_000), "12m34s");
  assert.equal(formatDuration(59_999), "59s");
  assert.equal(formatDuration(3_723_000), "1h02m");
  assert.equal(formatBytes(45 * 1024), "45KB");
  assert.equal(formatBytes(512), "512B");
});

function fixtureView(): TuiStateView {
  return {
    port: 8123,
    routeToken: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tunnelUrl: "",
    tunnelRole: "none",
    stopping: false,
    sessions: new Map([
      ["a", { activeRequests: 1, calls: 5, lastUsed: 1 }],
      ["b", { activeRequests: 0, calls: 1, lastUsed: 1 }],
    ]),
    commands: new Map([
      ["c1", {
        id: "cmd-1111aaaa",
        command: "npm run dev",
        done: false,
        startedAt: 1000,
        output: { state: () => ({ totalBytes: 16 * 1024 * 1024, capacityBytes: 32 * 1024 * 1024 }) },
      }],
      ["c2", {
        id: "cmd-2222bbbb",
        command: "finished",
        done: true,
        startedAt: 500,
        output: { state: () => ({ totalBytes: 0, capacityBytes: 32 * 1024 * 1024 }) },
      }],
    ]),
    services: new Map([
      ["s1", { commandId: "c1" }],
      ["s2", { commandId: "c2" }],
      ["s3", {}],
    ]),
    // 1970-aligned instants so the fake `now` (epoch ms) matches Date.parse.
    activity: [
      { at: "1970-01-01T00:00:03.000Z", ts: 3000, tool: "send_to_shell", status: "running", message: "probe", args_summary: "probe4" },
      { at: "1970-01-01T00:00:02.000Z", ts: 2000, tool: "run_command", status: "completed", message: "done", args_summary: "echo hi" },
      { at: "1970-01-01T00:00:01.000Z", ts: 1000, tool: "run_command", status: "running", message: "…", args_summary: "echo hi" },
    ],
    usage: { startedAt: 0, calls: 1234, successes: 1232, failures: 2 },
  };
}

test("buildSnapshot counts live state and redacts the route token", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  assert.equal(snap.sessions, 2);
  assert.equal(snap.sessionsActive, 1);
  assert.equal(snap.runningCommands.length, 1);
  assert.equal(snap.runningCommands[0]?.elapsedMs, 59_000);
  assert.equal(snap.servicesTotal, 3);
  assert.equal(snap.servicesRunning, 1); // c2 is done, s3 has no process
  assert.equal(snap.tunnel, "local");
  assert.ok(!snap.mcpUrl.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "route token never shown");
  assert.ok(snap.mcpUrl.includes("<redacted>"));
});

test("buildSnapshot reports a duration only for observed invoke/outcome pairs", () => {
  const snap = buildSnapshot(fixtureView(), { version: "v", rootName: "r", logPath: "l", now: 60_000 });
  // Newest first: the still-open invoke, then the completed call — whose own
  // invoke row retired when the outcome landed, leaving ONE row with duration.
  assert.equal(snap.events[0]?.tool, "send_to_shell");
  assert.equal(snap.events[0]?.status, "running");
  assert.equal(snap.events[1]?.tool, "run_command");
  assert.equal(snap.events[1]?.durationMs, 1000);
  assert.equal(snap.events.length, 2);

  const orphan = buildSnapshot(
    { ...fixtureView(), activity: [{ at: "1970-01-01T00:00:03.000Z", ts: 3000, tool: "x", status: "completed", message: "m" }] },
    { version: "v", rootName: "r", logPath: "l" },
  );
  assert.equal(orphan.events[0]?.durationMs, undefined);
});

test("renderFrame fills the exact geometry and shows the dashboard vocabulary", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const lines = renderFrame(snap, { width: 80, height: 24, now: 60_000 });
  assert.ok(lines.length <= 24, `frame is ${lines.length} rows, must fit 24`);
  for (const [i, line] of lines.entries()) {
    assert.equal(visualWidth(line), 80, `line ${i} must be exactly 80 columns`);
  }
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /运行中/);
  assert.match(text, /会话 2\/64/);
  assert.match(text, /50%/); // process card fill ratio
  assert.match(text, /✓/);
  assert.match(text, /57s…/); // live elapsed on the still-open invoke (now 60s - ts 3s)
  assert.match(text, /Ctrl\+C 停止/);
  assert.match(text, /概览/);
});

test("renderFrame degrades gracefully on a small window", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const lines = renderFrame(snap, { width: 40, height: 10, now: 60_000 });
  assert.ok(lines.length <= 10, `small frame is ${lines.length} rows, must fit 10`);
  for (const [i, line] of lines.entries()) {
    assert.equal(visualWidth(line), 40, `small line ${i} must be exactly 40 columns`);
  }
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /运行中/);
  assert.match(text, /Ctrl\+C 停止/);
});
