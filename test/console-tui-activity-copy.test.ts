import assert from "node:assert/strict";
import test from "node:test";
import { buildArgsSummary } from "../src/bridge/args-summary.js";
import { tuiActivityMessage, tuiActivityVisible } from "../src/console/tui/activity-copy.js";
import { buildSnapshot, type TuiStateView } from "../src/console/tui/snapshot.js";
import { renderFrame } from "../src/console/tui/render.js";
import { stripAnsi } from "../src/console/tui/text.js";

const NOW = 60_000;

function fixtureView(activity: TuiStateView["activity"]): TuiStateView {
  return {
    port: 8123,
    routeToken: "tok",
    tunnelUrl: "",
    tunnelRole: "none",
    stopping: false,
    sessions: new Map(),
    commands: new Map(),
    services: new Map(),
    activity,
    usage: { startedAt: NOW, calls: 0, successes: 0, failures: 0 },
    runtimeUsage: { calls: 0, successes: 0, failures: 0 },
    todos: [],
  };
}

test("transport mcp lines and process lifecycle are not dashboard facts", () => {
  assert.equal(tuiActivityVisible({
    tool: "mcp",
    status: "progress",
    message: "modern/other · HTTP 200 · 3808ms · sse · session abc · tool def",
  }), false);
  assert.equal(tuiActivityVisible({
    tool: "process",
    status: "running",
    message: "Started f7e5f178ae04a9fe: git status -sb (cwd: C:/x)",
  }), false);
  assert.equal(tuiActivityVisible({
    tool: "process",
    status: "completed",
    message: "f7e5f178ae04a9fe exited with code 0",
  }), false);
  assert.equal(tuiActivityVisible({
    tool: "write_file",
    status: "completed",
    message: "Completed in 4 ms.",
  }), true);
});

test("operator copy is the action, not the protocol or the JSON dump", () => {
  assert.equal(tuiActivityMessage({
    tool: "bridge",
    status: "completed",
    message: "Started: https://example.invalid/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }), "Started");
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
    message: "Request received · command: git push origin main && git status -sb · cwd: C:/Users/aolia/Desktop/open-bridge",
  }), "git push origin main");
  assert.equal(tuiActivityMessage({
    tool: "read_files",
    status: "completed",
    message: "Completed in 4 ms.",
    args_summary: buildArgsSummary({ paths: ["src/console/tui/activity-copy.ts"] }),
  }), "src/console/tui/activity-copy.ts");
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
  }), "tuiActivityMessage");
  assert.equal(tuiActivityMessage({
    tool: "write_file",
    status: "completed",
    message: "Completed in 4 ms.",
  }), "");
});

test("the activity panel hides mcp/process traces and does not dump argv", () => {
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
  assert.equal(snap.events.some(event => event.tool === "mcp"), false);
  assert.equal(snap.events.some(event => event.tool === "process"), false);
  const text = renderFrame(snap, { width: 110, height: 30, now: NOW }).map(stripAnsi).join("\n");
  assert.doesNotMatch(text, /HTTP 200|session |sse|timeout_ms|\{command:/);
  assert.match(text, /run_command/);
  assert.match(text, /git push origin main/);
  assert.doesNotMatch(text, /git status -sb/);
  assert.match(text, /write_file/);
  assert.doesNotMatch(text, /Completed in 3800/);
});
