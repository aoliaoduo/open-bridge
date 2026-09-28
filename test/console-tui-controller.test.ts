import assert from "node:assert/strict";
import test from "node:test";
import {
  controllerRenderOptions,
  createTuiControllerState,
  reduceTuiController,
  syncTuiControllerFrame,
  type TuiControllerState,
} from "../src/console/tui/controller.js";
import { buildSnapshot } from "../src/console/tui/snapshot.js";
import type { TuiSnapshot } from "../src/console/tui/render.js";
import { tuiView } from "./lib/tui-view.js";

const NOW = Date.parse("2026-09-28T10:00:00Z");

function snapshot(
  ids: string[] = ["a", "b", "c"],
  changes: TuiSnapshot["changes"] = { status: "ready", files: 2, insertions: 2, deletions: 0, entries: [
    { path: "a.txt", insertions: 1, deletions: 0 },
    { path: "b.txt", insertions: 1, deletions: 0 },
  ] },
): TuiSnapshot {
  return buildSnapshot(tuiView({
    activity: ids.map((id, index) => ({
      id,
      at: new Date(NOW - index * 1000).toISOString(),
      ts: NOW - index * 1000,
      tool: "probe",
      status: "completed",
      message: id.toUpperCase(),
    })),
  }), {
    version: "test",
    rootName: "controller",
    logPath: "unused",
    now: NOW,
    workspaceChanges: changes,
  });
}

function withMetrics(
  state: TuiControllerState,
  view: TuiControllerState["panelView"],
  rows: number,
  totalRows: number,
  snap = snapshot(),
): TuiControllerState {
  const selected = { ...state, panelView: view };
  return syncTuiControllerFrame(selected, undefined, snap, { rows, totalRows });
}

test("initial controller state has one canonical viewport state per panel", () => {
  const state = createTuiControllerState();
  assert.equal(state.panelView, "activity");
  assert.equal(state.activity.firstVisible, -1, "activity starts in live-head follow mode");
  assert.equal(state.activity.cursor, 0);
  assert.equal(state.tasks.firstVisible, 0);
  assert.equal(state.changes.cursor, 0);
  assert.deepEqual(state.diff.target, { kind: "cumulative" });
  assert.equal(state.event.detailKey, undefined);
});

test("Tab cycles only the three main views and is inert in detail/diff", () => {
  let state = createTuiControllerState();
  for (const expected of ["tasks", "changes", "activity"] as const) {
    const transition = reduceTuiController(state, { type: "tab" });
    state = transition.state;
    assert.equal(state.panelView, expected);
    assert.deepEqual(transition.effect, { type: "paint" });
  }

  const detail = { ...state, panelView: "event" as const };
  const detailTab = reduceTuiController(detail, { type: "tab" });
  assert.equal(detailTab.state.panelView, "event");
  assert.deepEqual(detailTab.effect, { type: "paint" });

  const diff = { ...state, panelView: "diff" as const };
  const diffTab = reduceTuiController(diff, { type: "tab" });
  assert.equal(diffTab.state.panelView, "diff");
  assert.deepEqual(diffTab.effect, { type: "paint" });
});

test("activity selection opens a stable event detail and Esc preserves the cursor", () => {
  const snap = snapshot();
  let state = withMetrics(createTuiControllerState(), "activity", 2, snap.events.length, snap);
  state = reduceTuiController(state, { type: "scroll", key: "down" }, snap).state;
  assert.equal(state.activity.cursor, 1);

  const opened = reduceTuiController(state, { type: "enter" }, snap);
  assert.equal(opened.state.panelView, "event");
  assert.equal(opened.state.event.detailKey, "id:b");
  assert.equal(opened.state.event.firstVisible, 0);

  const closed = reduceTuiController(opened.state, { type: "escape" }, snap);
  assert.equal(closed.state.panelView, "activity");
  assert.equal(closed.state.activity.cursor, 1);
});

test("changes selection produces a file-diff effect; d produces cumulative diff", () => {
  const snap = snapshot();
  let state = withMetrics(createTuiControllerState(), "changes", 1, 2, snap);
  state = reduceTuiController(state, { type: "scroll", key: "down" }, snap).state;
  assert.equal(state.changes.cursor, 1);

  const file = reduceTuiController(state, { type: "enter" }, snap);
  assert.equal(file.state.panelView, "diff");
  assert.deepEqual(file.state.diff.target, {
    kind: "file",
    file: { path: "b.txt", insertions: 1, deletions: 0 },
  });
  assert.deepEqual(file.effect, {
    type: "load_diff",
    target: { kind: "file", file: { path: "b.txt", insertions: 1, deletions: 0 } },
  });

  const back = reduceTuiController(file.state, { type: "escape" }, snap);
  assert.equal(back.state.panelView, "changes");
  const cumulative = reduceTuiController(back.state, { type: "diff" }, snap);
  assert.equal(cumulative.state.panelView, "diff");
  assert.deepEqual(cumulative.state.diff.target, { kind: "cumulative" });
  assert.deepEqual(cumulative.effect, { type: "load_diff", target: { kind: "cumulative" } });
});

test("reloading a diff keeps its target and resets only the diff viewport", () => {
  const snap = snapshot();
  let state = withMetrics(createTuiControllerState(), "changes", 1, 2, snap);
  state = reduceTuiController(state, { type: "scroll", key: "down" }, snap).state;
  state = reduceTuiController(state, { type: "enter" }, snap).state;
  state = {
    ...state,
    diff: { ...state.diff, firstVisible: 9, metrics: { rows: 3, totalRows: 20 } },
  };
  const reload = reduceTuiController(state, { type: "diff" }, snap);
  assert.equal(reload.state.diff.firstVisible, 0);
  assert.equal(reload.state.changes.cursor, 1);
  assert.equal(reload.effect?.type, "load_diff");
  assert.deepEqual(reload.state.diff.target, state.diff.target);
});

test("historical activity selection follows event identity when live rows prepend", () => {
  const previous = snapshot(["a", "b", "c"]);
  const next = snapshot(["new", "a", "b", "c"]);
  let state = createTuiControllerState();
  state = {
    ...state,
    activity: {
      ...state.activity,
      cursor: 1,
      firstVisible: 1,
      metrics: { rows: 2, totalRows: 3 },
    },
  };
  const synced = syncTuiControllerFrame(state, previous, next, { rows: 2, totalRows: 4 });
  assert.equal(synced.activity.cursor, 2, "the selected B row moves down when NEW is prepended");
  assert.equal(synced.activity.firstVisible, 2, "the historical viewport shifts with the same event");

  const liveHead = {
    ...state,
    activity: { ...state.activity, cursor: 0, firstVisible: -1 },
  };
  const liveSynced = syncTuiControllerFrame(liveHead, previous, next, { rows: 2, totalRows: 4 });
  assert.equal(liveSynced.activity.cursor, 0, "cursor zero deliberately follows the new live head");
  assert.equal(liveSynced.activity.firstVisible, -1);
});

test("visible view metrics clamp stale scroll and change cursor after list shrink", () => {
  const many = snapshot(["a"], {
    status: "ready",
    files: 4,
    insertions: 4,
    deletions: 0,
    entries: Array.from({ length: 4 }, (_, i) => ({ path: `${i}.txt`, insertions: 1, deletions: 0 })),
  });
  let state = createTuiControllerState();
  state = {
    ...state,
    panelView: "changes",
    changes: {
      ...state.changes,
      cursor: 3,
      firstVisible: 3,
      metrics: { rows: 1, totalRows: 4 },
    },
  };
  const one = snapshot(["a"], {
    status: "ready",
    files: 1,
    insertions: 1,
    deletions: 0,
    entries: [{ path: "0.txt", insertions: 1, deletions: 0 }],
  });
  const synced = syncTuiControllerFrame(state, many, one, { rows: 4, totalRows: 1 });
  assert.equal(synced.changes.cursor, 0);
  assert.equal(synced.changes.firstVisible, 0);

  const tasks = {
    ...createTuiControllerState(),
    panelView: "tasks" as const,
    tasks: { firstVisible: 50, metrics: { rows: 5, totalRows: 100 } },
  };
  const taskSynced = syncTuiControllerFrame(tasks, undefined, snapshot(), { rows: 10, totalRows: 12 });
  assert.equal(taskSynced.tasks.firstVisible, 2);
});

test("render options are a projection of controller state, not a second state model", () => {
  const state: TuiControllerState = {
    ...createTuiControllerState(),
    panelView: "event",
    activity: { firstVisible: 4, cursor: 5, metrics: { rows: 3, totalRows: 20 } },
    tasks: { firstVisible: 6, metrics: { rows: 4, totalRows: 30 } },
    changes: { firstVisible: 7, cursor: 8, metrics: { rows: 4, totalRows: 30 } },
    diff: { firstVisible: 9, metrics: { rows: 4, totalRows: 30 }, target: { kind: "cumulative" } },
    event: { firstVisible: 10, metrics: { rows: 4, totalRows: 30 }, detailKey: "id:x" },
  };
  assert.deepEqual(controllerRenderOptions(state), {
    panelView: "event",
    firstVisible: 4,
    taskFirstVisible: 6,
    changeFirstVisible: 7,
    diffFirstVisible: 9,
    expandFirstVisible: 10,
    activityCursor: 5,
    changeCursor: 8,
    eventDetailKey: "id:x",
  });
});
