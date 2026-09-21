/**
 * batchTool's own argument validation runs BEFORE the lazy dispatcher import,
 * so these branches are exercisable without a bridge. batch-plan.js — the pure
 * execution core — has its own suite (batch.test.ts); this covers the envelope
 * the dispatcher actually calls, where a bad envelope must fail with a message
 * that names the offending index instead of reaching invoke.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { batchTool } from "../src/bridge/batch.js";
import type { JsonArgs } from "../src/bridge/json-args.js";

test("calls must be an array of 1..20 entries", async () => {
  await assert.rejects(() => batchTool({} as JsonArgs), /calls must be an array of 1\.\.20/);
  await assert.rejects(() => batchTool({ calls: "nope" } as JsonArgs), /calls must be an array of 1\.\.20/);
  await assert.rejects(() => batchTool({ calls: [] }), /calls must be an array of 1\.\.20/);
  const twentyOne = Array.from({ length: 21 }, () => ({ tool: "wait" }));
  await assert.rejects(() => batchTool({ calls: twentyOne }), /calls must be an array of 1\.\.20/);
});

test("each entry needs a non-empty string tool name", async () => {
  await assert.rejects(() => batchTool({ calls: [{ tool: "" }] }), /calls\[0\]\.tool/);
  await assert.rejects(() => batchTool({ calls: [{ tool: 3 }] } as JsonArgs), /calls\[0\]\.tool/);
  await assert.rejects(() => batchTool({ calls: [null] } as JsonArgs), /calls\[0\]\.tool/);
  await assert.rejects(
    () => batchTool({ calls: [{ tool: "wait" }, { tool: "" }] }),
    /calls\[1\]\.tool/,
  );
});

test("arguments must be a plain object when present", async () => {
  await assert.rejects(
    () => batchTool({ calls: [{ tool: "wait", arguments: [1] }] }),
    /calls\[0\]\.arguments/,
  );
  await assert.rejects(
    () => batchTool({ calls: [{ tool: "wait", arguments: "x" }] }),
    /calls\[0\]\.arguments/,
  );
  await assert.rejects(
    () => batchTool({ calls: [{ tool: "wait", arguments: null }] }),
    /calls\[0\]\.arguments/,
  );
});

test('mode must be "sequential" or "parallel"', async () => {
  await assert.rejects(
    () => batchTool({ calls: [{ tool: "wait" }], mode: " Parallel" }),
    /mode must be/,
  );
});
