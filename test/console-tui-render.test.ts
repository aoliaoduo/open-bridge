/**
 * Serve-console TUI (stage 1): the render layer is pure string math, so the
 * whole layout contract — every line exactly `width` columns, never more than
 * `height` lines, the ainovel-cli vocabulary present — is pinned here without
 * a terminal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { charAtColumn, stripAnsi, visualWidth, truncateVisual, padEndVisual } from "../src/console/tui/text.js";
import { healthColor, paint } from "../src/console/tui/theme.js";
import { advanceScroll, formatDuration, formatBytes, renderFrame } from "../src/console/tui/render.js";
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
  assert.equal(snap.serviceRows.length, 3);
  assert.equal(snap.serviceRows.filter(s => s.running).length, 1);
  assert.deepEqual(snap.serviceRows[0], { name: "s1", running: true });
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

test("invoke rows retire against outcome rows that carry no args summary", () => {
  // The shapes the producers really write: the dispatcher logs the invoke WITH
  // an args summary; the MCP endpoint logs the outcome WITHOUT one. FIFO by
  // tool name must pair them — exact-key pairing never could.
  const view = {
    ...fixtureView(),
    activity: [
      { at: "1970-01-01T00:00:04.000Z", ts: 4000, tool: "read_files", status: "completed", message: "Completed in 30 ms." },
      { at: "1970-01-01T00:00:03.000Z", ts: 3000, tool: "run_command", status: "completed", message: "Completed in 900 ms." },
      { at: "1970-01-01T00:00:02.000Z", ts: 2000, tool: "run_command", status: "running", message: "Request received.", args_summary: "cmd: sleep" },
      { at: "1970-01-01T00:00:01.000Z", ts: 1000, tool: "read_files", status: "running", message: "Request received.", args_summary: "paths: [a]" },
    ],
  };
  const snap = buildSnapshot(view, { version: "v", rootName: "r", logPath: "l", now: 60_000 });
  assert.equal(snap.events.length, 2, "both invokes retired into their outcomes");
  assert.equal(snap.events[0]?.tool, "read_files");
  assert.equal(snap.events[0]?.durationMs, 3000);
  assert.equal(snap.events[1]?.tool, "run_command");
  assert.equal(snap.events[1]?.durationMs, 1000);
});

test("process Started rows resolve their truth from the command table", () => {
  const base = {
    ...fixtureView(),
    activity: [
      { at: "1970-01-01T00:00:05.000Z", ts: 5000, tool: "process", status: "running", message: "Started aaaa0000bbbb1111: live one" },
      { at: "1970-01-01T00:00:04.000Z", ts: 4000, tool: "process", status: "running", message: "Started aaaa0000bbbb2222: finished one" },
      { at: "1970-01-01T00:00:03.000Z", ts: 3000, tool: "process", status: "running", message: "Started aaaa0000bbbb3333: pruned one" },
    ],
  };
  base.commands = new Map([
    ["aaaa0000bbbb1111", { id: "aaaa0000bbbb1111", command: "live one", done: false, startedAt: 1000, output: { state: () => ({ totalBytes: 1, capacityBytes: 1 }) } }],
    ["aaaa0000bbbb2222", { id: "aaaa0000bbbb2222", command: "finished one", done: true, startedAt: 1000, endedAt: 3500, output: { state: () => ({ totalBytes: 1, capacityBytes: 1 }) } }],
  ]);
  const snap = buildSnapshot(base, { version: "v", rootName: "r", logPath: "l", now: 60_000 });
  assert.equal(snap.events[0]?.status, "running", "a live process keeps its spinner");
  assert.equal(snap.events[0]?.durationMs, undefined, "a lifecycle row never shows a paired-call duration");
  assert.equal(snap.events[1]?.status, "completed", "a finished process shows its real lifetime");
  assert.equal(snap.events[1]?.durationMs, 2500);
  assert.equal(snap.events[2]?.status, "progress", "a pruned process degrades to a neutral marker");
  assert.equal(snap.events[2]?.durationMs, undefined);
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

test("renderFrame pins the footer to the bottom rows however few the events", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const lines = renderFrame(snap, { width: 80, height: 40, now: 60_000 });
  assert.equal(lines.length, 40, "a tall window gets a full-height frame");
  for (const [i, line] of lines.entries()) {
    assert.equal(visualWidth(line), 80, `tall line ${i} must be exactly 80 columns`);
  }
  assert.match(stripAnsi(lines[38] ?? ""), /open-bridge/, "usage footer on the second-to-last row");
  assert.match(stripAnsi(lines[39] ?? ""), /Ctrl\+C 停止/, "hint row on the last row");
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

test("workbench layout: exact geometry with a sidebar divider column", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const lines = renderFrame(snap, { width: 110, height: 30, now: 60_000 });
  assert.equal(lines.length, 30, "a 30-row window gets a full-height workbench");
  for (const [i, line] of lines.entries()) {
    assert.equal(visualWidth(line), 110, `wb line ${i} must be exactly 110 columns`);
  }
  const plain = lines.map(stripAnsi);
  assert.match(plain[0] ?? "", /运行中/, "top bar present");
  const sidebarW = Math.max(24, Math.min(40, Math.floor(110 * 0.3)));
  for (let i = 2; i < 28; i += 1) {
    // Column, not string index: the sidebar contains CJK (2-column) characters.
    assert.equal(charAtColumn(plain[i] ?? "", sidebarW), "│", `divider column on body row ${i}`);
  }
  const joined = plain.join("\n");
  assert.match(joined, /─ 概览/);
  assert.match(joined, /─ 进程/);
  assert.match(joined, /─ 服务/);
  assert.match(joined, /活动 \(\d+\)/);
  assert.match(plain[28] ?? "", /open-bridge/, "usage footer on the second-to-last row");
  assert.match(plain[29] ?? "", /End 最新/, "scroll hint on the last row");
});

test("workbench panel follows the tail and reports history when scrolled", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const tail = renderFrame(snap, { width: 110, height: 30, now: 60_000 });
  const tailText = tail.map(stripAnsi).join("\n");
  assert.match(tailText, /send_to_shell/, "the newest event is visible in tail mode");
  assert.doesNotMatch(tailText, /End 回底/, "no history indicator while following the tail");

  // 30 events, 25 visible rows: the tail starts five rows in. Scrolling to
  // firstVisible 2 leaves two rows of history above the view.
  const many = Array.from({ length: 30 }, (_, i) => ({
    at: new Date(1000 + i).toISOString(),
    ts: 1000 + i,
    tool: `tool_${i}`,
    status: "completed" as const,
    message: `m${i}`,
  }));
  const manySnap = buildSnapshot(
    { ...fixtureView(), activity: many },
    { version: "v", rootName: "r", logPath: "l", now: 60_000 },
  );
  const scrolled = renderFrame(manySnap, { width: 110, height: 30, now: 60_000, firstVisible: 2 });
  const scrollText = scrolled.map(stripAnsi).join("\n");
  assert.match(scrollText, /↑2 行 · End 回底/, "scrolled view shows rows-above and the way back");
  assert.match(scrollText, /tool_2/, "the view starts at the requested event");
  assert.doesNotMatch(scrollText, /tool_0 /, "events above the view are not shown");
});

test("advanceScroll steps and clamps around the retained history", () => {
  // 10 events, 4 visible rows -> the tail starts at index 6.
  assert.equal(advanceScroll("up", 6, 10, 4), 5);
  assert.equal(advanceScroll("up", 0, 10, 4), 0, "cannot scroll past the oldest");
  assert.equal(advanceScroll("down", 5, 10, 4), 6);
  assert.equal(advanceScroll("down", 6, 10, 4), 6, "cannot scroll past the newest");
  assert.equal(advanceScroll("home", 6, 10, 4), 0);
  assert.equal(advanceScroll("end", 0, 10, 4), 6);
  assert.equal(advanceScroll("pageup", 6, 10, 4), 3);
  // A first-visible beyond the event count (the follow sentinel) behaves as
  // the tail, so the first scroll step is always one row of history.
  assert.equal(advanceScroll("up", Number.MAX_SAFE_INTEGER, 10, 4), 5);
});
