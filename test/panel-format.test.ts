import { test } from "node:test";
import assert from "node:assert/strict";
import {
  durationCn,
  formatDiffBadge,
  groupTodos,
  isPanelActivity,
  normalizeTodos,
  overflowProcessesText,
  relativeTimeShort,
  serviceSubLine,
  takeWithOverflow,
  todoDoneSummary,
  todoGroupLabel,
  topToolsByCount,
} from "../src/bridge/panel-format.js";

test("formatDiffBadge totals changes and hides empty signal", () => {
  assert.equal(
    formatDiffBadge([
      { additions: 2, deletions: 0 },
      { additions: 1, deletions: 3 },
    ]),
    "+3/−3",
  );
  assert.equal(formatDiffBadge([{ additions: 5, deletions: 0 }]), "+5/−0");
  assert.equal(formatDiffBadge([{ additions: 0, deletions: 0 }]), "");
  assert.equal(formatDiffBadge([]), "");
});

test("relativeTimeShort covers 刚刚/s/m/h/d boundaries", () => {
  const now = 1_000_000_000_000;
  assert.equal(relativeTimeShort(now, now), "刚刚");
  assert.equal(relativeTimeShort(now - 9_000, now), "刚刚");
  assert.equal(relativeTimeShort(now - 12_000, now), "12s");
  assert.equal(relativeTimeShort(now - 42 * 60_000, now), "42m");
  assert.equal(relativeTimeShort(now - 3 * 3_600_000, now), "3h");
  assert.equal(relativeTimeShort(now - 2 * 86_400_000, now), "2d");
  // Future timestamps clamp to 刚刚 instead of going negative.
  assert.equal(relativeTimeShort(now + 60_000, now), "刚刚");
});

test("durationCn formats uptime in Chinese units", () => {
  assert.equal(durationCn(42_000), "42 秒");
  assert.equal(durationCn(42 * 60_000), "42 分钟");
  assert.equal(durationCn(3 * 3_600_000), "3 小时");
  assert.equal(durationCn(2 * 86_400_000), "2 天");
});

test("normalizeTodos keeps valid entries and drops malformed ones", () => {
  const todos = normalizeTodos([
    { id: "1", title: "done", status: "completed" },
    { id: "2", title: "doing", status: "in_progress" },
    { id: "3", title: "later", status: "pending" },
    { id: "", title: "no id", status: "pending" },
    { id: "4", title: "", status: "pending" },
    { id: "5", title: "bad status", status: "weird" },
    "not-an-object",
    null,
  ]);
  assert.deepEqual(todos.map(t => t.id), ["1", "2", "3"]);
  assert.equal(normalizeTodos("nope").length, 0);
  assert.equal(normalizeTodos(undefined).length, 0);
});

test("groupTodos buckets by status in render order and omits empty groups", () => {
  const groups = groupTodos([
    { id: "c", title: "done", status: "completed" },
    { id: "a", title: "doing", status: "in_progress" },
    { id: "b", title: "later", status: "pending" },
    { id: "d", title: "later2", status: "pending" },
  ]);
  assert.deepEqual(groups.map(g => [g.status, g.label, g.items.map(t => t.id)]), [
    ["in_progress", "进行中", ["a"]],
    ["pending", "待办", ["b", "d"]],
    ["completed", "已完成", ["c"]],
  ]);
  // Completed group carries the collapsed-header summary.
  assert.equal(groups[2].summary, "已完成 1 项");
  assert.equal(groups[0].summary, "");
  // Empty groups are omitted.
  assert.deepEqual(
    groupTodos([{ id: "x", title: "X", status: "pending" }]).map(g => g.status),
    ["pending"],
  );
  assert.deepEqual(groupTodos([]), []);
});

test("todoGroupLabel and todoDoneSummary format group text", () => {
  assert.equal(todoGroupLabel("in_progress"), "进行中");
  assert.equal(todoGroupLabel("pending"), "待办");
  assert.equal(todoGroupLabel("completed"), "已完成");
  assert.equal(todoDoneSummary(0), "已完成 0 项");
  assert.equal(todoDoneSummary(3), "已完成 3 项");
});

test("serviceSubLine composes group, port and status text", () => {
  assert.equal(serviceSubLine("dev", 3000, "running", "42 分钟"), "dev · :3000 · 42 分钟");
  assert.equal(serviceSubLine("api", 8080, "stopped", ""), "api · :8080 · 已停止");
  assert.equal(serviceSubLine("default", undefined, "idle", ""), "default · 未启动");
});

test("isPanelActivity hides bridge-internal noise, keeps tool calls", () => {
  for (const internal of ["bridge", "ngrok", "health", "process"]) {
    assert.equal(isPanelActivity(internal), false, `${internal} should be filtered`);
  }
  for (const tool of ["edit_block", "run_command", "set_todos", "search_files"]) {
    assert.equal(isPanelActivity(tool), true, `${tool} should be shown`);
  }
});

test("takeWithOverflow splits shown rows and remainder", () => {
  const { shown, overflow } = takeWithOverflow([1, 2, 3, 4, 5], 2);
  assert.deepEqual(shown, [1, 2]);
  assert.equal(overflow, 3);
  assert.deepEqual(takeWithOverflow([1], 2), { shown: [1], overflow: 0 });
  assert.deepEqual(takeWithOverflow([], 2), { shown: [], overflow: 0 });
});

test("overflowProcessesText formats the aggregate row", () => {
  assert.equal(overflowProcessesText(1), "另 1 个进程运行中");
  assert.equal(overflowProcessesText(3), "另 3 个进程运行中");
});

test("topToolsByCount ranks by count with alphabetical tie-break", () => {
  const top = topToolsByCount({ read_files: 32, edit_block: 20, run_command: 20, lsp: 1 }, 3);
  assert.deepEqual(top, [
    { name: "read_files", count: 32 },
    { name: "edit_block", count: 20 },
    { name: "run_command", count: 20 },
  ]);
  assert.deepEqual(topToolsByCount({}, 3), []);
  assert.deepEqual(topToolsByCount({ a: 1 }, 0), []);
});
