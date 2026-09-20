import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBatchCalls, runBatchPlan, type BatchCall } from "../src/bridge/batch-plan.js";

type Exec = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

function makeExec(called: string[], failing: Set<string>): Exec {
  return async (tool, args) => {
    called.push(tool);
    if (failing.has(tool)) throw new Error(`Unknown tool: "${tool}".`);
    return `ok:${tool}:${JSON.stringify(args ?? {})}`;
  };
}

test("sequential: all succeed, counts and results are right", async () => {
  const called: string[] = [];
  const r = await runBatchPlan(
    [
      { tool: "a", arguments: { x: 1 } },
      { tool: "b" },
    ],
    "sequential",
    false,
    makeExec(called, new Set()),
  );
  assert.deepEqual(called, ["a", "b"]);
  assert.equal(r.mode, "sequential");
  assert.equal(r.total, 2);
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.stopped_early, false);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].index, 0);
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[0].result, "ok:a:{\"x\":1}");
  assert.equal(r.results[1].index, 1);
  assert.equal(r.results[1].result, "ok:b:{}");
});

test("sequential: an item failure is recorded, does not throw, rest continues", async () => {
  const called: string[] = [];
  const r = await runBatchPlan(
    [
      { tool: "a" },
      { tool: "bad" },
      { tool: "c" },
    ],
    "sequential",
    false,
    makeExec(called, new Set(["bad"])),
  );
  assert.deepEqual(called, ["a", "bad", "c"]);
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.stopped_early, false);
  assert.equal(r.results[1].ok, false);
  assert.match(r.results[1].error ?? "", /Unknown tool/);
});

test("sequential + fail_fast: stops at first failure, later items not executed, total = calls length", async () => {
  const called: string[] = [];
  const r = await runBatchPlan(
    [
      { tool: "a" },
      { tool: "bad" },
      { tool: "c" },
      { tool: "d" },
    ],
    "sequential",
    true,
    makeExec(called, new Set(["bad"])),
  );
  assert.deepEqual(called, ["a", "bad"]);
  assert.equal(r.total, 4);
  assert.equal(r.results.length, 2);
  assert.equal(r.stopped_early, true);
  assert.equal(r.succeeded, 1);
  assert.equal(r.failed, 1);
});

test("parallel: all items run despite failures, stopped_early stays false, fail_fast ignored", async () => {
  const called: string[] = [];
  const r = await runBatchPlan(
    [
      { tool: "a" },
      { tool: "bad" },
      { tool: "c" },
    ],
    "parallel",
    true,
    makeExec(called, new Set(["bad"])),
  );
  assert.equal(called.length, 3);
  assert.equal(r.mode, "parallel");
  assert.equal(r.succeeded, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.stopped_early, false);
  assert.equal(r.results.length, 3);
});

test("nested batch is rejected per item without calling the executor", async () => {
  const called: string[] = [];
  const r = await runBatchPlan(
    [
      { tool: "a" },
      { tool: "batch", arguments: { calls: [{ tool: "a" }] } },
    ],
    "parallel",
    false,
    makeExec(called, new Set()),
  );
  assert.deepEqual(called, ["a"]);
  assert.equal(r.results[1].ok, false);
  assert.match(r.results[1].error ?? "", /nested batch not allowed/);
  assert.equal(r.failed, 1);
});

test("normalizeBatchCalls: args alias is promoted when arguments is absent", () => {
  const normalized = normalizeBatchCalls([{ tool: "a", args: { x: 1 } }] as unknown as BatchCall[]);
  assert.deepEqual(normalized[0].arguments, { x: 1 });
});

test("normalizeBatchCalls: arguments wins when both are present", () => {
  const normalized = normalizeBatchCalls([{ tool: "a", arguments: { x: 1 }, args: { y: 2 } }] as unknown as BatchCall[]);
  assert.deepEqual(normalized[0].arguments, { x: 1 });
});

test("normalizeBatchCalls: non-object args is ignored", () => {
  const normalized = normalizeBatchCalls([
    { tool: "a", args: "nope" },
    { tool: "b", args: [1, 2] },
    { tool: "c", args: null },
  ] as unknown as BatchCall[]);
  assert.equal(normalized[0].arguments, undefined);
  assert.equal(normalized[1].arguments, undefined);
  assert.equal(normalized[2].arguments, undefined);
});

test("result indices identify duplicate tool calls and the first unstarted fail-fast item", async () => {
  const called: number[] = [];
  const r = await runBatchPlan(
    [
      { tool: "read_files", arguments: { slot: 0 } },
      { tool: "read_files", arguments: { slot: 1 } },
      { tool: "read_files", arguments: { slot: 2 } },
    ],
    "sequential",
    true,
    async (_tool, args) => {
      const slot = Number(args.slot);
      called.push(slot);
      if (slot === 1) throw new Error("second read failed");
      return { slot };
    },
  );
  assert.deepEqual(called, [0, 1]);
  assert.equal(r.stopped_early, true);
  assert.deepEqual(r.results.map(item => [item.index, item.tool, item.ok]), [
    [0, "read_files", true],
    [1, "read_files", false],
  ]);
  assert.equal(r.results[1].error, "second read failed");
  assert.equal(r.results.find(item => item.index === 2), undefined, "index 2 is the precise resume point");
});
