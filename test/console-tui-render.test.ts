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
import { advanceScroll, formatDuration, formatBytes, panelScrollMetrics, renderFrame } from "../src/console/tui/render.js";
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

test("process lifecycle rows stay off the dashboard", () => {
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
  assert.equal(snap.events.some(event => event.tool === "process"), false);
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
  assert.match(scrollText, /↑2 行 · Home 回顶/, "scrolled view shows rows-above and the way back");
  assert.match(scrollText, /tool_27 /, "the view starts at the requested event");
  assert.doesNotMatch(scrollText, /tool_29 /, "events above the view are not shown");
});

test("activity messages wrap on spaces instead of dropping their tail", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
  });
  const token = "WRAPTOKENTAILNOTELLIPSIS";
  snap.events = [{
    at: new Date(60_000).toISOString(),
    tool: "write_file",
    status: "error",
    message: `cannot write ${"subdir/".repeat(12)}${token}`,
  }];
  const metrics = panelScrollMetrics(snap, { width: 110, height: 30, panelView: "activity", now: 60_000 });
  assert.ok(metrics.totalRows > 1, "a long live line becomes several viewport rows");
  const top = renderFrame(snap, { width: 110, height: 30, now: 60_000, panelView: "activity", firstVisible: 0 }).map(stripAnsi).join("\n");
  assert.match(top, /cannot write/, "the reason stays on the first rows");
  const bottom = renderFrame(snap, {
    width: 110, height: 30, now: 60_000, panelView: "activity",
    firstVisible: Math.max(0, metrics.totalRows - metrics.rows),
  }).map(stripAnsi).join("\n");
  assert.match(bottom, new RegExp(token), "scrolling the wrapped rows reaches the message tail");
  for (const [width, height] of [[110, 30], [60, 12]] as const) {
    const lines = renderFrame(snap, { width, height, now: 60_000, panelView: "activity" });
    assert.equal(lines.length, height);
    for (const [i, line] of lines.entries()) {
      assert.equal(visualWidth(line), width, `${width}x${height} wrapped activity line ${i}`);
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
