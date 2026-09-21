/**
 * Serve-console TUI (stage 1): the render layer is pure string math, so the
 * whole layout contract — every line exactly `width` columns, never more than
 * `height` lines, the ainovel-cli vocabulary present — is pinned here without
 * a terminal.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { charAtColumn, fillVisualWidth, setAmbiguousWideForTests, stripAnsi, visualWidth, truncateVisual, padEndVisual } from "../src/console/tui/text.js";
import { healthColor, paint } from "../src/console/tui/theme.js";
import { advanceScroll, eventRows, formatDuration, formatBytes, panelScrollMetrics, renderFrame } from "../src/console/tui/render.js";

test("activity rows are single-line: the message truncates instead of wrapping", () => {
  const long = "curl -s http://127.0.0.1:8123/api/skills | head -c 400 plus extra padding padding padding to push this well past one panel width for sure";
  const view = { ...fixtureView(), activity: [
    { at: "2026-09-22T06:00:00Z", ts: 60_000, tool: "run_command", status: "completed", message: long },
    { at: "2026-09-22T06:01:00Z", ts: 66_000, tool: "mcp", status: "progress", message: "HTTP 200 · 3808ms · session abc" },
  ] };
  const snap = buildSnapshot(view, { version: "1.0.0", rootName: "r", logPath: "l", now: 70_000 });
  const metrics = panelScrollMetrics(snap, { width: 100, height: 30, panelView: "activity" });
  assert.equal(metrics.totalRows, 2, "one event, one row — mcp included, nothing filtered");
  const frame = renderFrame(snap, { width: 100, height: 30, panelView: "activity", now: 70_000 });
  const plain = frame.map(stripAnsi);
  const row = plain.find(l => l.includes("curl -s")) ?? "";
  assert.ok(row.includes("..."), "truncation is marked with an ellipsis");
  assert.ok(plain.some(l => l.includes("HTTP 200")), "mcp lines ride along now");
});

test("the cursor row is highlighted and the detail page shows the full copy", () => {
  const view = { ...fixtureView(), activity: [
    { at: "2026-09-22T06:00:00Z", ts: 60_000, tool: "run_command", status: "completed", message: "first" },
    { at: "2026-09-22T06:01:00Z", ts: 66_000, tool: "run_command", status: "completed", message: "second" },
  ] };
  const snap = buildSnapshot(view, { version: "1.0.0", rootName: "r", logPath: "l", now: 70_000 });
  const frame = renderFrame(snap, { width: 100, height: 30, panelView: "activity", now: 70_000, activityCursor: 1 });
  const rawSecond = frame.find(l => stripAnsi(l).includes("second")) ?? "";
  assert.ok(rawSecond.includes("\x1b[1m"), "the cursor row paints bold");
  const detail = renderFrame(snap, { width: 100, height: 30, panelView: "event", now: 70_000, eventDetailKey: "2026-09-22T06:01:00Z|run_command" });
  const plain = detail.map(stripAnsi);
  assert.ok(plain.some(l => l.includes("事件详情")), "detail heading");
  assert.ok(plain.some(l => l.includes("Esc 返回活动")), "the one exit is advertised");
  assert.ok(plain.some(l => l.includes("second")), "the body shows the event copy");
  const gone = renderFrame(snap, { width: 100, height: 30, panelView: "event", now: 70_000, eventDetailKey: "missing|key" });
  assert.ok(gone.map(stripAnsi).some(l => l.includes("已滚出")), "rotated-out events degrade gracefully");
});
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

test("ambiguous-width characters follow the CJK locale", () => {
  try {
    setAmbiguousWideForTests(false);
    assert.equal(visualWidth("◆ · ✓"), 5);
    assert.equal(fillVisualWidth("─", 5), "─────");
    setAmbiguousWideForTests(true);
    assert.equal(visualWidth("◆ · ✓"), 8, "in a CJK terminal the ambiguous marks render two columns each");
    assert.equal(fillVisualWidth("─", 5), "── ", "a 2-column rule cannot split; the last cell becomes a space");
  } finally {
    setAmbiguousWideForTests(false);
  }
});

test("geometry holds under the CJK ambiguous regime", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  try {
    setAmbiguousWideForTests(true);
    for (const [w, h] of [[80, 24], [110, 30], [40, 10]] as const) {
      const lines = renderFrame(snap, { width: w, height: h, now: 60_000 });
      assert.ok(lines.length <= h, `${w}x${h}: frame fits the height`);
      for (const [i, line] of lines.entries()) {
        assert.equal(visualWidth(line), w, `${w}x${h}: line ${i} must be exactly ${w} columns under the wide regime`);
      }
    }
  } finally {
    setAmbiguousWideForTests(false);
  }
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
    // Since-launch counters — what the TUI displays. Deliberately different
    // numbers from the persisted window above so a wrong source cannot pass.
    runtimeUsage: { calls: 7, successes: 6, failures: 1 },
    todos: [
      { id: "t1", title: "验证 TUI 布局", status: "completed" },
      { id: "t2", title: "接入任务列表", status: "in_progress" },
      { id: "t3", title: "清理收尾", status: "pending" },
      // A title no 33-column sidebar could ever show whole — the reason the
      // task view exists.
      { id: "t4", title: "TUI 阶段一：仪表盘（7c75440）+ 阶段三只读工作台（3f8fc6b）+ CJK 行尾修复全部完成待提交推送", status: "pending" },
    ],
  };
}

test("buildSnapshot counts live state and shows the full MCP URL", () => {
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
  assert.equal(snap.todos.length, 4, "the task list rides along for the panel");
  assert.equal(snap.todos[1]?.title, "接入任务列表");
  assert.equal(snap.todosTotal, 4, "the count stays honest beyond the render cap");
  assert.equal(snap.changes, undefined, "no workspace changes passed — the renderer names it 非 git");
  const clean = buildSnapshot(fixtureView(), {
    version: "v", rootName: "r", logPath: "l", now: 60_000,
    workspaceChanges: { files: 0, insertions: 0, deletions: 0 },
  });
  assert.deepEqual(clean.changes, { files: 0, insertions: 0, deletions: 0 }, "a clean tree carries an all-zero summary, not absence");
  assert.equal(snap.tunnel, "local");
  // Operator's call: the full address, token included — the startup banner
  // and `open-bridge url` print it in full; a redacted copy is unusable for
  // the paste-it-into-the-client job the footer exists for.
  assert.ok(snap.mcpUrl.includes("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "the full MCP URL, token included");
  assert.ok(!snap.mcpUrl.includes("<redacted>"));
  // Counters are since-launch, not the persisted usage window.
  assert.equal(snap.calls, 7);
  assert.equal(snap.successes, 6);
  assert.equal(snap.failures, 1);
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

test("process lifecycle rows ride along, dimmed, with their real state", () => {
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
  assert.equal(snap.events.length, 3, "nothing is dropped: the lifecycle stays visible");
  assert.equal(snap.events.every(event => event.subtle === true), true, "process rows ride dimmed");
  const states = snap.events.map(event => event.status).sort().join(",");
  assert.match(states, /completed/, "the finished process keeps its finished state");
  assert.match(states, /running/, "the live process keeps its live state");
});

test("renderFrame fills the exact geometry and shows the dashboard vocabulary", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  // 70 columns keeps this frame on the stacked dashboard ladder; the
  // workbench owns everything >= 76x22 and has its own geometry tests.
  const lines = renderFrame(snap, { width: 70, height: 24, now: 60_000 });
  assert.ok(lines.length <= 24, `frame is ${lines.length} rows, must fit 24`);
  for (const [i, line] of lines.entries()) {
    assert.equal(visualWidth(line), 70, `line ${i} must be exactly 70 columns`);
  }
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /运行中/);
  assert.match(text, /会话 2 · 活跃 1/);
  assert.doesNotMatch(text, /\/64/, "the session cap is developer knowledge, not operator-facing");
  assert.match(text, /50%/); // process card fill ratio
  assert.match(text, /✓/);
  assert.match(text, /57s…/); // live elapsed on the still-open invoke (now 60s - ts 3s)
  assert.doesNotMatch(text, /Ctrl\+C/, "closing the terminal window stops the serve; the hint is noise");
  assert.match(text, /控制台 http:\/\/127\.0\.0\.1:8123\/console/, "the web console entry rides the footer");
  assert.match(text, /调用 7（✓ 6 ✕ 1）/, "counters are since-launch, not the persisted window");
  assert.match(text, /概览/);
});

test("renderFrame pins addresses to the bottom of the sidebar in tall workbench window", () => {
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
  const plain = lines.map(stripAnsi);
  assert.equal(charAtColumn(plain[39] ?? "", 24), "│", "sidebar divider extends to the last row");
  assert.match(plain[38] ?? "", /控制台 http/, "the console entry is pinned to the bottom of the sidebar");
  assert.match(plain[39] ?? "", /8123\/console/, "console URL continuation on the last line");
  assert.doesNotMatch(plain[39] ?? "", /console\//, "no trailing slash");
  assert.doesNotMatch(plain.join("\n"), /MCP http/, "MCP address is removed from the sidebar");
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
  assert.match(text, /控制台 http:\/\/127\.0\.0\.1:8123\/console/, "the console entry survives even the smallest window");
});

test("workbench layout: exact geometry with a sidebar divider column", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
    workspaceChanges: { files: 2, insertions: 53, deletions: 18 },
  });
  const lines = renderFrame(snap, { width: 110, height: 30, now: 60_000 });
  assert.equal(lines.length, 30, "a 30-row window gets a full-height workbench");
  for (const [i, line] of lines.entries()) {
    assert.equal(visualWidth(line), 110, `wb line ${i} must be exactly 110 columns`);
  }
  const plain = lines.map(stripAnsi);
  assert.match(plain[0] ?? "", /运行中/, "top bar present");
  const sidebarW = Math.max(24, Math.min(40, Math.floor(110 * 0.3)));
  for (let i = 2; i < 30; i += 1) {
    // Column, not string index: the sidebar contains CJK (2-column) characters.
    assert.equal(charAtColumn(plain[i] ?? "", sidebarW), "│", `divider column on body row ${i}`);
  }
  const joined = plain.join("\n");
  assert.match(joined, /─ 概览/);
  assert.match(joined, /─ 进程/);
  assert.match(joined, /─ 服务/);
  assert.doesNotMatch(joined, /状态/, "the top-bar capsule owns the status; the sidebar does not repeat it");
  assert.match(joined, /仅本机/, "tunnel wording reads 隧道 · 仅本机, not 隧道 隧道 ●");
  assert.match(joined, /活动 \(\d+\)/);
  assert.doesNotMatch(joined, /─ 任务/, "titles no longer cram into the narrow sidebar");
  assert.match(joined, /任务\s+1\/4（25%）/, "a one-line progress summary replaces the truncated section");
  assert.doesNotMatch(joined, /Tab 任务|Tab 变更|Tab 返回活动|Tab 活动/, "the title row does not advertise the Tab cycle");
  assert.match(joined, /\+53 -18 · 2 文件/, "workspace changes since the last commit");
  // Additions green, deletions red — the diff convention every tool shares.
  const rawChangeRow = lines.find(line => stripAnsi(line).includes("+53")) ?? "";
  assert.ok(rawChangeRow.includes(paint("success", "+53")), "insertions paint green");
  assert.ok(rawChangeRow.includes(paint("error", "-18")), "deletions paint red");
  // The row is a permanent resident: clean reads as 干净 and a workspace
  // without git is named — a missing row cannot say which state it is in.
  const cleanSnap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2", rootName: "open-bridge", logPath: "C:/x/bridge.log", now: 60_000,
    workspaceChanges: { files: 0, insertions: 0, deletions: 0 },
  });
  assert.match(renderFrame(cleanSnap, { width: 110, height: 30, now: 60_000 }).map(stripAnsi).join("\n"), /变更\s+干净/, "a clean tree keeps the row, reading 干净");
  const noGitSnap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2", rootName: "open-bridge", logPath: "C:/x/bridge.log", now: 60_000,
  });
  assert.match(renderFrame(noGitSnap, { width: 110, height: 30, now: 60_000 }).map(stripAnsi).join("\n"), /变更\s+非 git/, "no git is named honestly, never silently hidden");
  assert.match(joined, /会话\s+2 · 活跃 1/);
  assert.doesNotMatch(joined, /\/64/, "the session cap is developer knowledge");
  assert.match(plain[28] ?? "", /控制台 http/, "the console entry is wrapped in the sidebar");
  assert.doesNotMatch(joined, /MCP http/, "MCP address is removed from the sidebar");
  assert.equal(charAtColumn(plain[28] ?? "", sidebarW), "│", "body row 28 has the divider column, not a full-width footer");
  assert.equal(charAtColumn(plain[29] ?? "", sidebarW), "│", "body row 29 has the divider column, not a full-width footer");
});

test("sidebar wraps web console URL within narrow sidebar width and omits MCP address", () => {
  const snap = buildSnapshot({
    ...fixtureView(),
    tunnelUrl: "https://bridge.example.invalid/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tunnelRole: "public",
    tunnelProvider: "ngrok",
  }, {
    version: "1.0.0",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const lines = renderFrame(snap, { width: 110, height: 30, now: 60_000 });
  const plain = lines.map(stripAnsi);
  const sidebarLines = plain.slice(2, 30).map(l => l.split("│")[0]?.trimEnd() ?? "");
  const sidebarText = sidebarLines.join("\n");
  assert.match(sidebarText, /控制台 http:\/\/127\.0\.0\.1:8123\/cons\nole/);
  assert.doesNotMatch(sidebarText, /console\//);
  assert.doesNotMatch(sidebarText, /MCP https:/);
});

test("top bar displays active workspace directory, version, and omits port/name/diamond", () => {
  const view = { ...fixtureView(), activeWorkspaceRoot: "C:/Projects/my-app" };
  const snap = buildSnapshot(view, {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const lines = renderFrame(snap, { width: 110, height: 30, now: 60_000 });
  const topBar = stripAnsi(lines[0] ?? "");
  assert.match(topBar, /v1\.0\.0-rc\.2/);
  assert.doesNotMatch(topBar, /◆/);
  assert.match(topBar, /C:\/Projects\/my-app/);
  assert.match(topBar, /运行中/);
  assert.doesNotMatch(topBar, /端口/);
  assert.doesNotMatch(topBar, /open-bridge/);
});

test("sidebar displays specific tunnel provider (ngrok / tailscale)", () => {
  const ngrokView = {
    ...fixtureView(),
    tunnelUrl: "https://demo.ngrok-free.dev/mcp/token",
  };
  const ngrokSnap = buildSnapshot(ngrokView, {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const ngrokLines = renderFrame(ngrokSnap, { width: 110, height: 30, now: 60_000 });
  assert.match(ngrokLines.map(stripAnsi).join("\n"), /隧道\s+ngrok 公网 ●/);

  const tsView = {
    ...fixtureView(),
    tunnelUrl: "https://my-node.ts.net/mcp/token",
  };
  const tsSnap = buildSnapshot(tsView, {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const tsLines = renderFrame(tsSnap, { width: 110, height: 30, now: 60_000 });
  assert.match(tsLines.map(stripAnsi).join("\n"), /隧道\s+tailscale 公网 ●/);
});

test("task view: Tab swaps the wide panel and shows full titles", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const lines = renderFrame(snap, { width: 110, height: 30, now: 60_000, panelView: "tasks" });
  assert.equal(lines.length, 30);
  for (const [i, line] of lines.entries()) {
    assert.equal(visualWidth(line), 110, `task line ${i} must be exactly 110 columns`);
  }
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /─ 任务 \(4\)/, "the wide panel belongs to the tasks");
  assert.doesNotMatch(text, /Tab 任务|Tab 变更|Tab 返回活动|Tab 活动/, "the title row does not advertise the Tab cycle");
  assert.match(text, /25% · 1\/4 完成/, "heading displays completion percentage and count");
  assert.doesNotMatch(text, /进行中/, "heading omits the redundant in-progress segment");
  assert.ok(lines.some(line => line.includes("\x1b[1m") && line.includes("接入任务列表")), "in-progress task is painted bold");
  assert.match(text, /✓ 验证 TUI 布局/);
  assert.match(text, /接入任务列表/);
  assert.match(text, /· 清理收尾/);
  // The long title survives by WRAPPING, not truncation: its tail must be on
  // screen — the 33-column sidebar could only ever amputate it. The wrap can
  // land mid-phrase, so the assertion allows the line break + indent.
  assert.match(text, /行尾修复全/, "the wrap keeps the tail — part one");
  assert.match(text, /部完成待提交推送/, "the wrap keeps the tail — part two");
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
  assert.doesNotMatch(tailText, /Home 回顶/, "no history indicator while following the head");

  // 30 events, 25 visible rows: the history below the head starts five rows
  // in. The array mirrors the real log (state.activity.unshift): NEWEST
  // FIRST — tool_29 (ts 1029) at index 0 is the live head, and follow keeps
  // it on screen, never the oldest window.
  const many = Array.from({ length: 30 }, (_, j) => ({
    at: new Date(1029 - j).toISOString(),
    ts: 1029 - j,
    tool: `tool_${29 - j}`,
    status: "completed" as const,
    message: `m${29 - j}`,
  }));
  const manySnap = buildSnapshot(
    { ...fixtureView(), activity: many },
    { version: "v", rootName: "r", logPath: "l", now: 60_000 },
  );
  const follow = renderFrame(manySnap, { width: 110, height: 30, now: 60_000 });
  const followText = follow.map(stripAnsi).join("\n");
  assert.match(followText, /tool_29/, "follow locks onto the newest event once the panel overflows");
  assert.doesNotMatch(followText, /tool_0 /, "the oldest events are history when the panel overflows");
  const scrolled = renderFrame(manySnap, { width: 110, height: 30, now: 60_000, firstVisible: 2 });
  const scrollText = scrolled.map(stripAnsi).join("\n");
  assert.match(scrollText, /Enter 展开 · ↑2 行/, "scrolled view shows rows-above and the selection affordance");
  assert.match(scrollText, /tool_27 /, "the view starts at the requested event");
  assert.doesNotMatch(scrollText, /tool_29 /, "events above the view are not shown");
});

test("activity messages truncate on the row; the Enter detail keeps the tail", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const token = "TRUNCTOKENTAILINDETAIL";
  snap.events = [{
    at: new Date(60_000).toISOString(),
    tool: "write_file",
    status: "error",
    message: `cannot write ${"subdir/".repeat(12)}${token}`,
    detail: `cannot write ${"subdir/".repeat(12)}${token}`,
  }];
  const metrics = panelScrollMetrics(snap, { width: 110, height: 30, panelView: "activity", now: 60_000 });
  assert.equal(metrics.totalRows, 1, "one event, one row — no wrapping");
  const top = renderFrame(snap, { width: 110, height: 30, now: 60_000, panelView: "activity", firstVisible: 0 }).map(stripAnsi).join("\n");
  assert.match(top, /cannot write/, "the reason stays on the row");
  assert.match(top, /\.\.\./, "the cut is marked with an ellipsis");
  assert.doesNotMatch(top, new RegExp(token), "the tail beyond the row is cut from the list");
  assert.ok((snap.events[0]?.detail ?? "").includes(token), "the Enter page keeps the tail");
  for (const [width, height] of [[110, 30], [60, 12]] as const) {
    const lines = renderFrame(snap, { width, height, now: 60_000, panelView: "activity" });
    assert.equal(lines.length, height);
    for (const [i, line] of lines.entries()) {
      assert.equal(visualWidth(line), width, `${width}x${height} single-line activity ${i}`);
    }
  }
});

test("advanceScroll steps and clamps around the retained history", () => {
  // 10 events, 4 visible rows -> the oldest window starts at index 6. Index 0
  // is the head: the newest event, where follow mode stays.
  assert.equal(advanceScroll("up", 6, 10, 4), 5);
  assert.equal(advanceScroll("up", 0, 10, 4), 0, "cannot scroll past the newest");
  assert.equal(advanceScroll("down", 5, 10, 4), 6);
  assert.equal(advanceScroll("down", 6, 10, 4), 6, "cannot scroll past the oldest");
  assert.equal(advanceScroll("home", 6, 10, 4), 0);
  assert.equal(advanceScroll("end", 0, 10, 4), 6);
  assert.equal(advanceScroll("pageup", 6, 10, 4), 3);
  // A first-visible below zero (the follow sentinel) behaves as the head, so
  // the first scroll step into history is always one row.
  assert.equal(advanceScroll("down", -1, 10, 4), 1);
});

test("the diff panel renders the cumulative review diff", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
    diff: { loading: false, ok: true, text: "@@ -1 +1 @@\n-seed\n+seed\nplus one", truncated: false, since: "last_shown", checkpoint: "retained", reason: "" },
  });
  const lines = renderFrame(snap, { width: 100, height: 30, panelView: "diff" });
  const joined = lines.join("\n");
  assert.ok(joined.includes("累计 diff"), "the panel title names the view");
  assert.ok(joined.includes("+seed"), "added lines render");
  assert.ok(joined.includes("-seed"), "removed lines render");
  assert.ok(joined.includes("已截断") === false, "untruncated diff stays quiet about truncation");
});

test("the diff panel shows loading and failure states", () => {
  const loading = buildSnapshot(fixtureView(), {
    version: "1.0.0", rootName: "r", logPath: "l",
    diff: { loading: true, ok: false, text: "", truncated: false, since: "", checkpoint: "", reason: "" },
  });
  assert.ok(renderFrame(loading, { width: 100, height: 30, panelView: "diff" }).join("\n").includes("正在读取累计 diff"));
  const failed = buildSnapshot(fixtureView(), {
    version: "1.0.0", rootName: "r", logPath: "l",
    diff: { loading: false, ok: false, text: "", truncated: false, since: "", checkpoint: "", reason: "review_changes requires a Git workspace" },
  });
  assert.ok(renderFrame(failed, { width: 100, height: 30, panelView: "diff" }).join("\n").includes("Git workspace"));
  const established = buildSnapshot(fixtureView(), {
    version: "1.0.0", rootName: "r", logPath: "l",
    diff: { loading: false, ok: true, text: "", truncated: false, since: "workspace_open", checkpoint: "established", reason: "" },
  });
  assert.ok(renderFrame(established, { width: 100, height: 30, panelView: "diff" }).join("\n").includes("已建立审阅基线"));
});

test("the duration column keeps a fixed width so rows stop flickering", () => {
  const base = { at: "2026-09-22T10:00:00Z", tool: "run_command", status: "completed" as const, message: "审查代码变更" };
  // "900ms" / "1s" / "59s" 各不相同，但正文必须从同一列开始 —— 右列宽度
  // 不再随时长单位变化，底部行因此不会偶发翻转。
  const columns = [900, 1000, 59000].map(durationMs =>
    stripAnsi(eventRows({ ...base, durationMs }, 80, 0, 0)[0] ?? "").indexOf("审查代码变更"));
  assert.ok(columns[0] >= 0 && columns[0] === columns[1] && columns[1] === columns[2]);
});

test("the changes panel advertises d and the preview advertises Esc", () => {
  const changesSnap = buildSnapshot(fixtureView(), {
    version: "1.0.0", rootName: "r", logPath: "l",
    workspaceChanges: { files: 0, insertions: 0, deletions: 0, entries: [] },
  });
  const changes = renderFrame(changesSnap, { width: 100, height: 30, panelView: "changes" }).join("\n");
  assert.ok(stripAnsi(changes).includes("d 预览 diff"), "the changes title hints the preview key");

  const diffSnap = buildSnapshot(fixtureView(), {
    version: "1.0.0", rootName: "r", logPath: "l",
    diff: { loading: false, ok: true, text: "", truncated: false, since: "last_shown", checkpoint: "retained", reason: "" },
  });
  const diff = renderFrame(diffSnap, { width: 100, height: 30, panelView: "diff" }).join("\n");
  assert.ok(stripAnsi(diff).includes("Esc 返回变更"), "the preview title hints the only exit");
});

test("the completion clock keeps a gap and its own tone apart from the title", async () => {
  const todos = [
    { id: "1", title: "这一行标题很长很长很长这一行标题很长很长很长这一行标题很长很长很长这一行标题很长很长", status: "completed", completedAt: "2026-09-22T06:00:00Z" },
  ];
  const snap = buildSnapshot({ ...fixtureView(), todos }, { version: "1.0.0", rootName: "r", logPath: "l", now: 60_000, todosUpdatedAt: "2026-09-22T09:58:00Z" });
  const frame = renderFrame(snap, { width: 100, height: 30, panelView: "tasks", now: 60_000 });
  const line = frame.map(l => stripAnsi(l)).find(l => l.includes("这一行标题很长")) ?? "";
  const titleEnd = line.indexOf("这一行标题很长") + visualWidth("这一行标题很长");
  const clockAt = line.indexOf("06:00:00");
  assert.ok(clockAt > 0, `clock missing in ${line}`);
  assert.ok(clockAt - titleEnd >= 2, `clock jammed against title (gap ${clockAt - titleEnd})`);
  // 标题 muted (#b8b09c)、时钟 dim (#8a8175)：真彩 SGR 直接断言两种灰阶。
  const raw = frame.find(l => stripAnsi(l).includes("这一行标题很长")) ?? "";
  assert.ok(raw.includes("38;2;184;176;156"), "title should paint muted #b8b09c");
  assert.ok(raw.includes("38;2;138;129;117"), "clock should paint dim #8a8175");
});

test("completed todos render a fixed-width completion clock", () => {
  const todos = [
    { id: "1", title: "审查代码变更", status: "completed", completedAt: "2026-09-22T06:00:00Z" },
    { id: "2", title: "写补丁", status: "completed", completedAt: "2026-09-22T09:30:00Z" },
  ];
  const snap = buildSnapshot({ ...fixtureView(), todos }, { version: "1.0.0", rootName: "r", logPath: "l", now: 60_000 });
  const plain = stripAnsi(renderFrame(snap, { width: 100, height: 30, panelView: "tasks" }).join("\n"));
  assert.ok(/\d{2}:\d{2}:\d{2}/.test(plain), "the completion clock renders");
  // Stamps differ but the titles start at the same column: fixed-width right
  // column, the same anti-flicker contract as the activity rows.
  // Per-line columns: absolute offsets in the joined frame mean nothing across
  // different lines — the contract is "same column within the task list".
  const lines = plain.split("\n");
  // Compare VISUAL columns (the sidebar mixes CJK and latin, so string indexes
  // differ line to line even when the layout is pixel-identical).
  const columns = ["审查代码变更", "写补丁"].map(title => {
    const line = lines.find(candidate => candidate.includes(title)) ?? "";
    return visualWidth(line.slice(0, line.indexOf(title)));
  });
  assert.ok(columns[0] > 0 && columns[0] === columns[1]);
});

test("the task title shows freshness and warns when stale work sits in progress", () => {
  const todos = [
    { id: "1", title: "a", status: "completed" },
    { id: "2", title: "b", status: "in_progress" },
  ];
  const now = Date.parse("2026-09-22T10:00:00Z");
  const fresh = buildSnapshot({ ...fixtureView(), todos }, { version: "1.0.0", rootName: "r", logPath: "l", now, todosUpdatedAt: "2026-09-22T09:58:00Z" });
  assert.ok(stripAnsi(renderFrame(fresh, { width: 100, height: 30, panelView: "tasks", now }).join("\n")).includes("更新 "));
  const stale = buildSnapshot({ ...fixtureView(), todos }, { version: "1.0.0", rootName: "r", logPath: "l", now, todosUpdatedAt: "2026-09-22T09:30:00Z" });
  assert.ok(stripAnsi(renderFrame(stale, { width: 100, height: 30, panelView: "tasks", now }).join("\n")).includes("分钟未更新"));
});
