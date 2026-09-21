import assert from "node:assert/strict";
import test, { mock } from "node:test";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { state } from "../src/bridge/state.js";
import { consoleTuiActive, startConsoleTui, stopConsoleTui } from "../src/console/tui/driver.js";
import { buildSnapshot, type TuiStateView } from "../src/console/tui/snapshot.js";
import { renderFrame, panelScrollMetrics, type TuiSnapshot } from "../src/console/tui/render.js";
import { setAmbiguousWideForTests, stripAnsi, visualWidth } from "../src/console/tui/text.js";

const NOW = Date.parse("2026-01-01T00:00:00Z");

function fixtureView(count = 100): TuiStateView {
  return {
    port: 12345,
    routeToken: "synthetic-navigation-fixture",
    tunnelUrl: "",
    tunnelRole: "none",
    stopping: false,
    sessions: new Map(),
    commands: new Map(),
    services: new Map(),
    activity: Array.from({ length: 40 }, (_, index) => ({
      at: new Date(NOW - index * 1000).toISOString(),
      ts: NOW - index * 1000,
      tool: "probe",
      status: "completed",
      message: `EVENT_${String(index + 1).padStart(2, "0")}`,
    })),
    usage: { startedAt: NOW, calls: 0, successes: 0, failures: 0 },
    runtimeUsage: { calls: 0, successes: 0, failures: 0 },
    todos: Array.from({ length: count }, (_, index) => ({
      id: `task-${index + 1}`,
      title: `TASK_${String(index + 1).padStart(3, "0")}`,
      status: index === count - 1 ? "in_progress" : "pending",
    })),
  };
}

function snapshot(count = 100): TuiSnapshot {
  return buildSnapshot(fixtureView(count), {
    version: "test", rootName: "navigation-fixture", logPath: "synthetic.log",
    now: NOW, launchedAt: NOW, workspaceChanges: { files: 0, insertions: 0, deletions: 0 },
  });
}

function frame(snap: TuiSnapshot, width: number, height: number, taskFirstVisible = 0): string[] {
  // Before the implementation exists the old renderer simply ignores this
  // option, so the regressions fail on observable content, not on a missing import.
  const options = { width, height, taskFirstVisible, panelView: "tasks" as const, now: NOW, spinnerFrame: 0 };
  return renderFrame(snap, options).map(stripAnsi);
}

function assertGeometry(lines: string[], width: number, height: number): void {
  assert.equal(lines.length, height);
  for (const [index, line] of lines.entries()) {
    assert.equal(visualWidth(line), width, `row ${index} stays inside the terminal`);
    assert.doesNotMatch(line, /[\r\n]/, "a logical row cannot smuggle in physical newlines");
  }
}

test("task snapshot preserves the complete tool-supported list, not only its first sixteen", () => {
  const view = fixtureView();
  const snap = buildSnapshot(view, { version: "test", rootName: "r", logPath: "l", now: NOW });
  assert.equal(snap.todosTotal, 100);
  assert.deepEqual(snap.todos, view.todos.map(({ title, status }) => ({ title, status })));
});

test("sidebar counts in-progress tasks beyond the former snapshot cap", () => {
  const text = renderFrame(snapshot(), { width: 110, height: 24, now: NOW }).map(stripAnsi).join("\n");
  assert.match(text, /0\/100（0%）/);
});

test("task viewport reaches the final task and clamps excessive offsets", () => {
  const snap = snapshot();
  const first = frame(snap, 110, 24);
  const last = frame(snap, 110, 24, Number.MAX_SAFE_INTEGER);
  assert.match(first.join("\n"), /TASK_001/);
  assert.doesNotMatch(first.join("\n"), /TASK_100/);
  assert.match(last.join("\n"), /TASK_100/);
  assert.doesNotMatch(last.join("\n"), /TASK_001/);
  assert.doesNotMatch(last.join("\n"), /仅显示前/);
  assertGeometry(last, 110, 24);
});

test("task selection survives narrow and short layouts, including both workbench boundaries", () => {
  const snap = snapshot();
  for (const [width, height] of [[20, 6], [60, 20], [75, 22], [76, 21], [76, 22], [110, 24]] as const) {
    const first = frame(snap, width, height);
    const last = frame(snap, width, height, Number.MAX_SAFE_INTEGER);
    assertGeometry(first, width, height);
    assertGeometry(last, width, height);
    assert.match(first.join("\n"), /TASK_001/, `${width}x${height} shows the selected task view`);
    assert.match(last.join("\n"), /TASK_100/, `${width}x${height} can reach the final task`);
    assert.doesNotMatch(first.join("\n"), /EVENT_/);
    assert.doesNotMatch(first.join("\n"), /Tab 任务|Tab 变更|Tab 返回活动|Tab 活动/, "the title row does not advertise the Tab cycle");
  }
});

test("wrapped CJK and multiline titles remain complete at the task viewport tail", () => {
  for (const ambiguous of [false, true]) {
    setAmbiguousWideForTests(ambiguous);
    try {
      const snap = snapshot(1);
      snap.todos = [{ title: `开始${"中文长标题".repeat(30)}\r\n第二行\n${"更多内容".repeat(20)}末尾可见`, status: "completed" }];
      const last = frame(snap, 60, 12, Number.MAX_SAFE_INTEGER);
      assertGeometry(last, 60, 12);
      assert.ok(last.slice(3, -2).join("").replace(/\s/g, "").includes("末尾可见"));
    } finally {
      setAmbiguousWideForTests(false);
    }
  }
});

test("empty tasks are explicit and remain safe after an old long-list scroll offset", () => {
  for (const [width, height] of [[60, 12], [110, 24]] as const) {
    const lines = frame(snapshot(0), width, height, Number.MAX_SAFE_INTEGER);
    assertGeometry(lines, width, height);
    assert.match(lines.join("\n"), /暂无任务/);
    assert.doesNotMatch(lines.join("\n"), /Tab 任务|Tab 变更|Tab 返回活动|Tab 活动/);
    assert.doesNotMatch(lines.join("\n"), /EVENT_/);
  }
});

class TerminalOutput extends EventEmitter {
  isTTY = true;
  columns = 110;
  rows = 24;
  frame = "";
  payload = "";
  write(payload: string): boolean {
    if (payload.startsWith("\x1b[H")) {
      this.payload = payload;
      this.frame = stripAnsi(payload);
    }
    return true;
  }
}

/** Exercise the real startConsoleTui/key listener without spawning a Bridge,
 * touching a real terminal, running Git, or emitting an actual SIGINT. */
function withTerminal(run: (terminal: {
  output: TerminalOutput;
  press: (name: string, ctrl?: boolean) => string;
  resize: (width: number, height: number) => string;
  killCalls: () => unknown[][];
}) => void): void {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout");
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  assert.ok(stdoutDescriptor && stdinDescriptor);
  const output = new TerminalOutput();
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this; },
  });
  const previousTodos = state.todos;
  const previousActivity = state.activity;
  const view = fixtureView();
  state.todos = view.todos;
  state.activity = view.activity.map(entry => ({ ...entry, ts: entry.ts ?? NOW }));
  const gitMock = mock.method(childProcess, "execFile", (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === "function") callback(new Error("fixture: no Git probe"), "", "");
    return {} as ChildProcess;
  });
  const killMock = mock.method(process, "kill", () => true);
  syncBuiltinESMExports();
  Object.defineProperty(process, "stdout", { configurable: true, value: output });
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  try {
    assert.equal(startConsoleTui({ version: "test", rootName: "fixture", rootPath: process.cwd(), logPath: "synthetic.log" }), true);
    assert.equal(input.isRaw, true);
    run({
      output,
      press(name, ctrl = false) {
        input.emit("keypress", name === "tab" ? "\t" : ctrl && name === "c" ? "\x03" : "", { name, ctrl });
        output.emit("resize"); // also exercises the existing repaint entry
        return output.frame;
      },
      resize(width, height) {
        output.columns = width;
        output.rows = height;
        output.emit("resize");
        return output.frame;
      },
      killCalls: () => killMock.mock.calls.map(call => call.arguments),
    });
  } finally {
    stopConsoleTui();
    const rawAfterStop = input.isRaw;
    state.todos = previousTodos;
    state.activity = previousActivity;
    Object.defineProperty(process, "stdout", stdoutDescriptor);
    Object.defineProperty(process, "stdin", stdinDescriptor);
    input.destroy();
    gitMock.mock.restore();
    killMock.mock.restore();
    syncBuiltinESMExports();
    assert.equal(rawAfterStop, false, "stop restores raw stdin");
    assert.equal(consoleTuiActive(), false);
  }
}

function eventLabels(text: string): string[] {
  return text.match(/EVENT_\d+/g) ?? [];
}

test("real driver routes scroll keys to the visible panel and only Tab switches views", () => {
  withTerminal(({ press, killCalls }) => {
    const activity = eventLabels(press("pagedown"));
    assert.ok(activity.length > 0 && !activity.includes("EVENT_01"));
    assert.match(press("tab"), /TASK_001/);
    assert.doesNotMatch(press("pagedown"), /TASK_001/);
    assert.match(press("end"), /TASK_100/);
    assert.match(press("tab"), /变更/, "the third page is the file list");
    assert.deepEqual(eventLabels(press("tab")), activity, "task scrolling did not move the hidden activity view");
    assert.match(press("tab"), /TASK_100/, "task position survives the round trip");
    assert.match(press("escape"), /TASK_001/, "Esc goes to the task head, not another view");
    assert.doesNotMatch(press("down"), /TASK_001/);
    assert.match(press("up"), /TASK_001/);
    press("pagedown");
    assert.match(press("pageup"), /TASK_001/);
    press("end");
    assert.match(press("home"), /TASK_001/);
    press("tab"); // tasks → changes
    assert.deepEqual(eventLabels(press("tab")), activity);
    assert.ok(eventLabels(press("home")).includes("EVENT_01"));
    press("c", true);
    assert.deepEqual(killCalls(), [[process.pid, "SIGINT"]], "raw Ctrl+C keeps the graceful shutdown signal path");
  });
});

test("the activity cursor selects, Enter expands the full copy, Esc is the only exit", () => {
  withTerminal(({ press }) => {
    const detail = press("return");
    assert.match(detail, /事件详情/);
    assert.match(detail, /Esc 返回活动/);
    assert.match(detail, /EVENT_01/, "the cursor starts on the newest event");
    assert.match(press("tab"), /事件详情/, "Tab is inert inside the detail view");
    const back = press("escape");
    assert.match(back, /EVENT_01/, "Esc returns to the activity page on the same row");
    press("down");
    assert.match(press("return"), /EVENT_02/, "the selection moved before expanding");
    assert.match(press("escape"), /EVENT_02/, "the cursor survives the round trip");
  });
});

test("a long detail pages through: End reaches the tail the first page cannot show", () => {
  withTerminal(({ press }) => {
    const sentence = "这是一段超长的中文执行详情用于验证详情页必须能滚动看完全部内容";
    const long = Array.from({ length: 40 }, (_, i) => `${sentence}标记${i}END`).join("");
    state.activity.unshift({ at: new Date(NOW + 50_000).toISOString(), ts: NOW + 50_000, tool: "run_command", status: "completed", message: long });
    // 光标行取自「上一帧」快照：改完状态先催一帧重绘（home 无副作用地回到
    // 头部并重画），让操作者——和 Enter——看见的是含新事件的列表。
    press("home");
    const detail = press("return");
    assert.match(detail, /事件详情/);
    assert.doesNotMatch(detail, /标记3[5-9]END/, "the first page cannot show the tail");
    const lastPage = press("end");
    assert.match(lastPage, /标记3[5-9]END/, "paging reaches the tail of the detail");
    assert.match(press("escape"), /EVENT_01/, "Esc returns to the activity page");
  });
});

test("real driver clamps task scroll after resize and list shrink without resurrecting old offsets", () => {
  withTerminal(({ press, resize }) => {
    press("tab");
    assert.match(press("end"), /TASK_100/);
    resize(60, 12);
    assert.match(press("end"), /TASK_100/);
    assert.match(resize(110, 60), /TASK_100/, "growing the viewport clamps to the new last page");
    state.todos = fixtureView(2).todos;
    assert.match(resize(60, 12), /TASK_001/);
    state.todos = fixtureView().todos;
    assert.match(resize(110, 24), /TASK_001/, "a stale offset does not return when the list grows again");
  });
});


// Additional coverage for the new viewport contract; these are not claimed
// as separately reproduced defects on the old implementation.
test("paging the task viewport can visit every one of the hundred tasks", () => {
  const snap = snapshot();
  const dimensions = { width: 76, height: 22, panelView: "tasks" as const };
  const metrics = panelScrollMetrics(snap, dimensions);
  const seen = new Set<string>();
  for (let offset = 0; offset < metrics.totalRows; offset += Math.max(1, metrics.rows - 1)) {
    const lines = frame(snap, dimensions.width, dimensions.height, offset);
    assertGeometry(lines, dimensions.width, dimensions.height);
    for (const label of lines.join("\n").match(/TASK_\d+/g) ?? []) seen.add(label);
  }
  assert.deepEqual([...seen].sort(), snap.todos.map(todo => todo.title));
});

test("every wrapped title character survives, not only the first and last line", () => {
  for (const ambiguous of [false, true]) {
    setAmbiguousWideForTests(ambiguous);
    try {
      for (const width of [20, 60]) {
        const snap = snapshot(1);
        const title = `开头${"完整中文与ASCII".repeat(12)}\n第二行${"保持正文".repeat(12)}末尾可见`;
        snap.todos = [{ title: title.replace(/\\n/g, "\n"), status: "completed" }];
        const metrics = panelScrollMetrics(snap, { width, height: 6, panelView: "tasks" });
        assert.equal(metrics.rows, 1);
        const collected: string[] = [];
        for (let offset = 0; offset < metrics.totalRows; offset += 1) {
          const lines = frame(snap, width, 6, offset);
          assertGeometry(lines, width, 6);
          collected.push((lines[3] ?? "").replace(/^✓ */u, "").trim());
        }
        assert.equal(collected.join(""), snap.todos[0]?.title.replace(/\n/g, ""));
      }
    } finally {
      setAmbiguousWideForTests(false);
    }
  }
});

test("real narrow activity scrolling uses the rows left after overview cards", () => {
  withTerminal(({ press, resize }) => {
    const initial = eventLabels(resize(60, 12));
    assert.ok(initial.length > 1 && initial.includes("EVENT_01"));
    const advanced = eventLabels(press("pagedown"));
    assert.equal(advanced[0], `EVENT_${String(initial.length).padStart(2, "0")}`);
    press("tab");
    assert.match(press("end"), /TASK_100/);
    press("tab"); // tasks → changes
    assert.deepEqual(eventLabels(press("tab")), advanced);
  });
});


test("real driver clears before drawing and never erases the last painted cell", () => {
  withTerminal(({ output, press }) => {
    press("tab");
    const esc = String.fromCharCode(27);
    assert.ok(output.payload.startsWith(`${esc}[H${esc}[2K`), "erase the row BEFORE its ink, not at the pending-wrap cursor");
    assert.doesNotMatch(output.payload, new RegExp(`${esc}\\[(?:0)?[KJ]`), "erase-to-end after a full row deletes its last cell");
    assert.ok(!output.payload.includes("\n") && !output.payload.includes("\r"), "explicit row addresses do not rely on terminal newline modes");
    for (let row = 2; row <= output.rows; row += 1) {
      assert.ok(output.payload.includes(`${esc}[${row};1H${esc}[2K`), `row ${row} is positioned and cleared before drawing`);
    }
  });
});

test("untrusted inline fields cannot add terminal rows, move the cursor, or open OSC sequences", () => {
  const esc = String.fromCharCode(27);
  const oscLink = `${esc}]8;;https://example.invalid${esc}\\LINK${esc}]8;;${esc}\\`;
  const hostile = `alpha\nbeta\rrewind\ttab${String.fromCharCode(8)}${esc}[2J${oscLink}`;
  const snap = snapshot(1);
  snap.rootName = hostile;
  snap.mcpUrl = `http://example.invalid/${hostile}`;
  snap.events = [{ at: new Date(NOW).toISOString(), tool: "probe", status: "completed", message: hostile }];
  snap.runningCommands = [{ id: "synthetic", command: hostile, elapsedMs: 0, capturedBytes: 0, capacityBytes: 1024 }];
  snap.serviceRows = [{ name: hostile, running: true }];
  snap.servicesTotal = 1;
  snap.servicesRunning = 1;
  snap.todos = [{ title: hostile, status: "in_progress" }];
  const sgr = new RegExp(`${esc}\\[[0-9;]*m`, "g");
  for (const panelView of ["activity", "tasks", "changes"] as const) {
    for (const [width, height] of [[60, 20], [180, 30]] as const) {
      const lines = renderFrame(snap, { width, height, panelView, now: NOW, spinnerFrame: 0 });
      assertGeometry(lines.map(stripAnsi), width, height);
      for (const line of lines) {
        // Remove only paint's SGR: stripping all VT sequences here would hide
        // the very cursor/OSC injection this regression is meant to catch.
        const controls = [...line.replace(sgr, "")].filter(ch => {
          const code = ch.codePointAt(0) ?? 0;
          return code < 32 || (code >= 127 && code < 160);
        });
        assert.deepEqual(controls, [], "all remaining bytes describe printable cells");
      }
      if (panelView === "activity" && width === 180) {
        assert.ok(lines.map(stripAnsi).join("\n").includes("alpha beta"), "inline newlines become readable spaces, not discarded content");
      }
    }
  }
});
