/**
 * set_todos / report_progress persistence is the operator's TUI panel source.
 * The store serializes read-merge-write into ONE per-workspace document: a
 * progress write must never clobber the todo list (and vice versa), the entry
 * must be stamped with the reporting session (not the document's last writer),
 * and an out-of-vocabulary phase must not survive — types are erased at
 * runtime and this document is also read back from disk.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setHost, type Host, type StateStore } from "../src/host/host.js";
import { applyCompletionTimes, persistTodos, persistProgress } from "../src/bridge/todo-store.js";
import { state, type SessionState } from "../src/bridge/state.js";

function memoryStateStore(): StateStore & { dump(): Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    get<T>(key: string, fallback: T): T {
      return (m.has(key) ? m.get(key) : fallback) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      m.set(key, value);
    },
    dump: () => m,
  };
}

function installHostFor(store: StateStore, root: string): void {
  setHost({
    config: { get<T>(_key: string, fallback: T): T { return fallback; }, async update(): Promise<void> {} },
    secrets: { async get() { return undefined; }, async store() {} },
    state: store,
    storageDir: () => root,
    version: () => "test",
    bundledRipgrep: () => undefined,
    projectRoot: () => root,
    notify: () => {},
    log: () => {},
    ui: { update: () => {}, refresh: () => {} },
  } as Host);
}

/** The store defers writes through a promise tail; two macrotasks drain it. */
const drain = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
};

let store: ReturnType<typeof memoryStateStore>;
let workspace: string;
let saved: { root: string; latest: SessionState | null; sessions: Map<string, SessionState> };

beforeEach(() => {
  store = memoryStateStore();
  workspace = `ob-todos-${Math.random().toString(36).slice(2)}`;
  saved = { root: state.activeWorkspaceRoot, latest: state.latestSession, sessions: state.sessions };
  const session = { marker: true } as unknown as SessionState;
  state.sessions = new Map([["sess-1", session]]);
  state.latestSession = session;
  state.activeWorkspaceRoot = workspace;
  installHostFor(store, workspace);
});

afterEach(() => {
  state.activeWorkspaceRoot = saved.root;
  state.latestSession = saved.latest;
  state.sessions = saved.sessions;
});

const doc = (): Record<string, unknown> => {
  const value = store.dump().get(`openBridge.todos.${workspace}`);
  assert.ok(value, "the workspace todo document must exist after a write");
  return value as Record<string, unknown>;
};

test("persistTodos writes the list under the workspace key, stamped with the session", async () => {
  persistTodos([{ id: "t1", title: "x", status: "pending" }]);
  await drain();
  const d = doc();
  assert.deepEqual(d.todos, [{ id: "t1", title: "x", status: "pending" }]);
  assert.equal(d.sessionId, "sess-1");
  assert.equal(d.lastProgress, null);
  assert.equal(typeof d.updatedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(d.updatedAt as string)));
});

test("report_progress merges into the same document without clobbering todos", async () => {
  persistTodos([{ id: "t1", title: "x", status: "in_progress" }]);
  await drain();
  persistProgress({ message: "halfway", percent: 50, level: "info" });
  await drain();
  const d = doc();
  assert.deepEqual(d.todos, [{ id: "t1", title: "x", status: "in_progress" }]);
  const progress = d.lastProgress as Record<string, unknown>;
  assert.equal(progress.message, "halfway");
  assert.equal(progress.percent, 50);
  assert.equal(progress.sessionId, "sess-1");
  assert.equal(typeof progress.at, "string");
});

test("an out-of-vocabulary phase is dropped instead of persisted", async () => {
  persistProgress({ message: "x", phase: "not-a-phase" as never, level: "info" });
  await drain();
  const progress = doc().lastProgress as Record<string, unknown>;
  assert.equal(progress.phase, undefined);
  assert.equal(progress.message, "x");
});

test("persisted todos are isolated from later caller mutations", async () => {
  const list: Array<Record<string, unknown>> = [{ v: 1 }];
  persistTodos(list);
  await drain();
  list[0].v = 99;
  await drain();
  assert.deepEqual(doc().todos, [{ v: 1 }]);
});

test("an unbound workspace persists under the literal unbound key", async () => {
  state.activeWorkspaceRoot = "";
  persistTodos([]);
  await drain();
  assert.ok(store.dump().has("openBridge.todos.unbound"));
});

test("applyCompletionTimes stamps new completions, keeps stamps, clears on reopen", () => {
  const first = applyCompletionTimes([], [
    { id: "a", title: "x", status: "completed" },
    { id: "b", title: "y", status: "in_progress" },
  ], "2026-09-22T01:00:00.000Z");
  assert.equal(first[0]!.completedAt, "2026-09-22T01:00:00.000Z");
  assert.equal("completedAt" in first[1]!, false);

  const second = applyCompletionTimes(first, [
    { id: "a", title: "x", status: "completed" },
    { id: "b", title: "y", status: "completed" },
  ], "2026-09-22T02:00:00.000Z");
  assert.equal(second[0]!.completedAt, "2026-09-22T01:00:00.000Z");
  assert.equal(second[1]!.completedAt, "2026-09-22T02:00:00.000Z");

  const reopened = applyCompletionTimes(second, [{ id: "a", title: "x", status: "pending" }], "2026-09-22T03:00:00.000Z");
  assert.equal("completedAt" in reopened[0]!, false);
});
