import assert from "node:assert/strict";
import test from "node:test";
import { buildArgsSummary } from "../src/bridge/tools/args-summary.js";
import { clearActivityHints, rememberActivityHint } from "../src/bridge/activity-presentation.js";
import { tuiActivityDetail, tuiActivityMessage, tuiActivityPresentation } from "../src/console/tui/activity-copy.js";
import { buildSnapshot, type TuiStateView } from "../src/console/tui/snapshot.js";
import { renderFrame } from "../src/console/tui/render.js";
import { stripAnsi } from "../src/console/tui/text.js";
import { tuiView } from "./lib/tui-view.js";

const NOW = 60_000;

function fixtureView(activity: TuiStateView["activity"]): TuiStateView {
  return tuiView({
    port: 8123,
    routeToken: "tok",
    activity,
    usage: { startedAt: NOW, calls: 0, successes: 0, failures: 0 },
  });
}

test("mcp/process ride along dimmed instead of being filtered away", () => {
  const view = fixtureView([
    { at: new Date(NOW).toISOString(), ts: NOW, tool: "mcp", status: "completed", message: "modern/tools/call · POST · HTTP 200 · 74ms · json · tool 4e816176161d" },
    { at: new Date(NOW + 1).toISOString(), ts: NOW + 1, tool: "process", status: "running", message: "Started f7e5f178ae04a9fe: git status -sb (cwd: C:/x)" },
  ]);
  const snap = buildSnapshot(view, { version: "1.0.0", rootName: "r", logPath: "l", now: NOW + 5_000 });
  assert.equal(snap.events.length, 2, "nothing is filtered: what was logged is shown");
  assert.equal(snap.events.every(event => event.subtle === true), true, "both ride with the subtle flag");
  const mcp = snap.events.find(event => event.tool === "mcp");
  assert.equal(mcp?.status, "completed", "a response-close trace is terminal, not an in-progress spinner");
  assert.equal(mcp?.action, "MCP");
  assert.equal(mcp?.subject, "工具调用");
  assert.equal(mcp?.qualifier, "HTTP 200 · JSON");
  assert.equal(mcp?.durationMs, 74, "transport duration moves into the shared right-hand duration column");
  assert.match(mcp?.detail ?? "", /modern\/tools\/call/);
  assert.match(mcp?.detail ?? "", /tool 4e816176161d/, "Enter keeps the hashed diagnostic trace");
});

test("activity copy stays uncapped until the renderer owns the terminal width", () => {
  const long = "run_command with a very long command argument that runs well past the former fifty-six column cap of the dashboard row";
  assert.ok(tuiActivityMessage({ tool: "run_command", status: "completed", message: long }).length > 80,
    "semantic copy no longer throws away wide-terminal content before rendering");
  assert.ok(tuiActivityDetail({ tool: "run_command", status: "completed", message: long }).length > 80,
    "Enter detail keeps the same uncapped fact");
});

test("operator copy is the action, not the protocol or the JSON dump", () => {
  assert.equal(tuiActivityMessage({
    tool: "bridge",
    status: "completed",
    message: "Started: https://example.invalid/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }), "已启动");
  assert.equal(tuiActivityMessage({
    tool: "run_command",
    status: "completed",
    message: "Completed in 12 ms.",
    args_summary: buildArgsSummary({
      command: "git status -sb && git log -1 --oneline",
      timeout_ms: 15_000,
    }),
  }), "git status -sb");
  assert.equal(tuiActivityMessage({
    tool: "run_command",
    status: "running",
    message: "Request received · command: git push origin main && git status -sb · cwd: C:/workspace/open-bridge",
  }), "git push origin main");
  assert.equal(tuiActivityMessage({
    tool: "read_files",
    status: "completed",
    message: "Completed in 4 ms.",
    args_summary: buildArgsSummary({ paths: ["src/console/tui/activity-copy.ts"] }),
  }), "src/console/tui/activity-copy.ts");
  assert.equal(tuiActivityMessage({
    tool: "bridge_status",
    status: "completed",
    message: "Completed in 18 ms.",
    args_summary: buildArgsSummary({ section: "overview" }),
  }), "概览");
  assert.equal(tuiActivityPresentation({
    tool: "bridge_status",
    status: "completed",
    message: "Completed in 18 ms.",
    args_summary: buildArgsSummary({ section: "overview" }),
  }).action, "状态");
  assert.equal(tuiActivityMessage({
    tool: "list_directory",
    status: "completed",
    message: "Completed in 3 ms.",
    args_summary: buildArgsSummary({ path: "src/console/tui" }),
  }), "src/console/tui");
  assert.equal(tuiActivityMessage({
    tool: "search_files",
    status: "completed",
    message: "Completed in 8 ms.",
    args_summary: buildArgsSummary({
      query: "tuiActivityMessage",
      path: "src/console/tui",
      include: ["*.ts"],
      max_results: 5,
    }),
  }), "tuiActivityMessage · src/console/tui");
  assert.equal(tuiActivityMessage({
    tool: "write_file",
    status: "completed",
    message: "Completed in 4 ms.",
  }), "");
});

test("snapshot prefers the private structured hint for a correlated terminal row", () => {
  clearActivityHints();
  rememberActivityHint("call-1", { action: "读取", subject: "src/from-structured.ts", subjectKind: "path" });
  try {
    const snap = buildSnapshot(fixtureView([
      {
        id: "done-1",
        invocation_id: "call-1",
        at: "1970-01-01T00:00:03.000Z",
        ts: 3000,
        tool: "read_files",
        status: "completed",
        message: "Completed in 4 ms.",
        args_summary: buildArgsSummary({ paths: ["src/from-serialized.ts"] }),
      },
    ]), { version: "v", rootName: "r", logPath: "l", now: NOW });
    assert.equal(snap.events[0]?.message, "src/from-structured.ts");
    assert.match(snap.events[0]?.detail ?? "", /src\/from-structured\.ts/, "headline prefers the private structured hint");
    assert.match(snap.events[0]?.detail ?? "", /src\/from-serialized\.ts/, "detail still exposes the redacted audit args");
  } finally {
    clearActivityHints();
  }
});

test("mcp/process traces ride along dimmed; argv never reaches the rows", () => {
  const snap = buildSnapshot(fixtureView([
    { at: "1970-01-01T00:00:04.000Z", ts: 4000, tool: "mcp", status: "progress", message: "modern/other · HTTP 200 · 3808ms · sse · session abc · tool def" },
    {
      at: "1970-01-01T00:00:03.000Z",
      ts: 3000,
      tool: "run_command",
      status: "completed",
      message: "Completed in 3800 ms.",
      args_summary: buildArgsSummary({ command: "git push origin main && git status -sb", timeout_ms: 15_000 }),
    },
    { at: "1970-01-01T00:00:02.000Z", ts: 2000, tool: "process", status: "running", message: "Started f7e5f178ae04a9fe: git push origin main (cwd: C:/x)" },
    { at: "1970-01-01T00:00:01.000Z", ts: 1000, tool: "write_file", status: "completed", message: "Completed in 4 ms." },
  ]), { version: "v", rootName: "r", logPath: "l", now: NOW });
  assert.equal(snap.events.filter(event => event.subtle === true).length, 2, "mcp/process are present and marked subtle");
  const text = renderFrame(snap, { width: 110, height: 30, now: NOW }).map(stripAnsi).join("\n");
  assert.match(text, /HTTP 200/, "the transport line is shown now, dimmed by tone rather than deleted");
  assert.doesNotMatch(text, /timeout_ms|\{command:/, "rows still never dump argv");
  assert.match(text, /命令/);
  assert.match(text, /git push origin main/);
  assert.doesNotMatch(text, /git status -sb/);
  assert.match(text, /写入/);
  assert.doesNotMatch(text, /Completed in 3800/);
  assert.doesNotMatch(text, /f7e5f178ae04a9fe/, "process ids stay out of the operator copy");
});

test("semantic presentations keep high-value action/subject/qualifier fields separate", () => {
  assert.deepEqual(tuiActivityPresentation({
    tool: "file_op", status: "completed", message: "Completed in 5 ms.",
    args_summary: buildArgsSummary({ op: "delete", path: "dist/bundle.js" }),
  }), { action: "删除", subject: "dist/bundle.js", subjectKind: "path" });

  assert.deepEqual(tuiActivityPresentation({
    tool: "service", status: "completed", message: "Completed in 20 ms.",
    args_summary: buildArgsSummary({ action: "restart", name: "web-server" }),
  }), { action: "服务", subject: "web-server", qualifier: "restart", subjectKind: "generic" });

  assert.deepEqual(tuiActivityPresentation({
    tool: "batch", status: "completed", message: "Completed in 30 ms.",
    args_summary: buildArgsSummary({ calls: [{ tool: "a" }, { tool: "b" }], mode: "sequential" }),
  }), { action: "批量", subject: "2 项", qualifier: "sequential", subjectKind: "generic" });

  assert.deepEqual(tuiActivityPresentation({
    tool: "edit_block", status: "completed", message: "Completed in 10 ms.",
    args_summary: buildArgsSummary({
      path: "src/app.ts",
      edits: [{ old_text: "a", new_text: "b" }, { old_text: "c", new_text: "d" }],
    }),
  }), { action: "修改", subject: "src/app.ts", qualifier: "2 处修改", subjectKind: "path" });

  assert.deepEqual(tuiActivityPresentation({
    tool: "workspace_brief", status: "completed", message: "Completed in 15 ms.",
  }), { action: "项目", subject: "项目概况", subjectKind: "generic" });
});

test("Enter detail restores the redacted args that the one-line headline intentionally omits", () => {
  const commandDetail = tuiActivityDetail({
    tool: "run_command",
    status: "completed",
    message: "Completed in 12 ms.",
    args_summary: buildArgsSummary({
      command: "git status -sb && git log -1 --oneline",
      timeout_ms: 15_000,
    }),
  });
  assert.match(commandDetail, /git status -sb/);
  assert.match(commandDetail, /git log -1 --oneline/, "the full chained command survives in detail");
  assert.match(commandDetail, /timeout_ms:15000/);

  const filesDetail = tuiActivityDetail({
    tool: "read_files",
    status: "completed",
    message: "Completed in 4 ms.",
    args_summary: buildArgsSummary({
      paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
      start_line: 20,
      end_line: 80,
    }),
  });
  assert.match(filesDetail, /src\/a\.ts/);
  assert.match(filesDetail, /src\/b\.ts/);
  assert.match(filesDetail, /src\/c\.ts/);
  assert.match(filesDetail, /start_line:20/);
  assert.match(filesDetail, /end_line:80/);
});

test("failure presentation keeps target context but promotes the failure reason", () => {
  const entry = {
    tool: "search_files",
    status: "error",
    message: "Failed in 58 ms: ENOENT: no such file or directory, scandir 'C:/repo/src test'",
    args_summary: buildArgsSummary({
      query: "MESSAGE_CAP|tuiActivityMessage(",
      path: "src test",
      regex: true,
    }),
  };
  const presentation = tuiActivityPresentation(entry);
  assert.equal(presentation.action, "搜索");
  assert.equal(presentation.subject, "MESSAGE_CAP|tuiActivityMessage(");
  assert.equal(presentation.qualifier, "src test");
  assert.match(presentation.failure ?? "", /ENOENT/);
  const detail = tuiActivityDetail(entry);
  assert.match(detail, /MESSAGE_CAP\|tuiActivityMessage/);
  assert.match(detail, /src test/);
  assert.match(detail, /ENOENT/);
});
