import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setHost, type Host } from "../src/host/host.js";
import { state } from "../src/bridge/state.js";
import { invoke } from "../src/bridge/dispatcher.js";
import { batchTool } from "../src/bridge/batch.js";
import { runScript } from "../src/bridge/script-tools.js";
import { buildSnapshot } from "../src/console/tui/snapshot.js";

const memoryHost: Host = {
  config: {
    get: <T>(key: string, fallback: T): T => key === "concurrency.enabled" ? false as T : fallback,
    update: async () => undefined,
  },
  secrets: { get: async () => undefined, store: async () => undefined },
  state: { get: <T>(_key: string, fallback: T): T => fallback, update: async () => undefined },
  // record() explicitly tolerates an absent sink; no test log is written into
  // the user's repository or real Bridge data directory.
  storageDir: () => { throw new Error("No disk audit sink in this fixture"); },
  version: () => "test",
  bundledRipgrep: () => undefined,
  projectRoot: () => process.cwd(),
  notify: () => undefined,
  log: () => undefined,
  ui: { update: () => undefined, refresh: () => undefined },
};

beforeEach(() => {
  setHost(memoryHost);
  state.activity = [];
  state.usage = { startedAt: Date.now(), calls: 0, successes: 0, failures: 0, byTool: {} };
  state.runtimeUsage = { calls: 0, successes: 0, failures: 0 };
});

function statuses(tool: string): string[] {
  return state.activity.filter(entry => entry.tool === tool).map(entry => entry.status).reverse();
}

function assertRetired(tool: string, outcome: "completed" | "error"): void {
  assert.deepEqual(statuses(tool), ["running", outcome], "each started nested call has exactly one real outcome");
  const snap = buildSnapshot(state, { version: "test", rootName: "fixture", logPath: "unused", now: Date.now() + 15 * 60_000 });
  const events = snap.events.filter(entry => entry.tool === tool);
  assert.equal(events.length, 1, "the result replaces its invoke row in the TUI");
  assert.equal(events[0]?.status, outcome, "it cannot still spin fifteen minutes later");
  assert.equal(typeof events[0]?.durationMs, "number", "a matched result has observed, finite duration");
}

test("a nested invocation retires only when its actual promise resolves, without counting usage twice", async () => {
  const pending = invoke("get_todos", {}, undefined, { countUsage: false });
  assert.deepEqual(statuses("get_todos"), ["running"]);
  await pending;
  assert.deepEqual(state.runtimeUsage, { calls: 0, successes: 0, failures: 0 });
  assert.equal(state.usage.calls, 0);
  assertRetired("get_todos", "completed");
});

test("nested validation failure records its reason and still rethrows the real error", async () => {
  await assert.rejects(invoke("get_file_info", {}, undefined, { countUsage: false }), /path/i);
  assert.equal(state.usage.calls, 0);
  assertRetired("get_file_info", "error");
  const failure = state.activity.find(entry => entry.tool === "get_file_info" && entry.status === "error");
  assert.match(failure?.message ?? "", /^Failed in \d+ ms: .*path/i);
});

test("parallel batch children keep both success and failure outcomes for the TUI", async () => {
  const result = await batchTool({ mode: "parallel", calls: [
    { tool: "get_todos" },
    { tool: "get_file_info", arguments: {} },
  ] });
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.equal(state.usage.calls, 0, "the outer MCP request remains the sole accounting point");
  assertRetired("get_todos", "completed");
  assertRetired("get_file_info", "error");
});

test("real run_script dispatch closes successful child calls, not just its envelope", async () => {
  const result = await runScript({ source: "await Promise.all([tools.get_todos({}), tools.get_usage_stats({})]); return true;" });
  assert.equal(result.ok, true);
  assert.equal(result.calls, 2);
  assert.equal(state.usage.calls, 0);
  assertRetired("get_todos", "completed");
  assertRetired("get_usage_stats", "completed");
});

test("a failed run_script child has a terminal error event while the recovery envelope stays intact", async () => {
  const result = await runScript({ source: "return await tools.get_file_info({});" });
  assert.equal(result.ok, false);
  assert.equal(result.calls, 1);
  assertRetired("get_file_info", "error");
});

test("normal top-level dispatch leaves completion and accounting to the MCP endpoint", async () => {
  await invoke("get_todos", {});
  assert.deepEqual(statuses("get_todos"), ["running"], "do not add a duplicate top-level terminal event");
  assert.equal(state.runtimeUsage.calls, 1);
  assert.equal(state.usage.calls, 1);
});
