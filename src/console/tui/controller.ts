/**
 * Pure interaction state for the serve-console TUI.
 *
 * The driver owns terminal/IO effects; this module owns navigation. Keeping
 * panel, cursor, scroll and viewport metrics in one value prevents impossible
 * combinations from growing as the workbench gains views.
 */
import type { ChangeFile } from "./changes.js";
import {
  advanceScroll,
  eventKeyOf,
  maxFirstVisible,
  nextPanelView,
  type PanelView,
  type ScrollKey,
  type TuiSnapshot,
} from "./render.js";

export type PanelMetrics = { rows: number; totalRows: number };
export type DiffTarget = { kind: "cumulative" } | { kind: "file"; file: ChangeFile };

type Viewport = { firstVisible: number; metrics: PanelMetrics };

export type TuiControllerState = {
  panelView: PanelView;
  activity: Viewport & { cursor: number };
  tasks: Viewport;
  changes: Viewport & { cursor: number };
  diff: Viewport & { target: DiffTarget };
  event: Viewport & { detailKey?: string };
};

export type TuiControllerAction =
  | { type: "tab" }
  | { type: "escape" }
  | { type: "enter" }
  | { type: "diff" }
  | { type: "scroll"; key: ScrollKey };

export type TuiControllerEffect =
  | { type: "paint" }
  | { type: "load_diff"; target: DiffTarget };

export type TuiControllerTransition = {
  state: TuiControllerState;
  effect?: TuiControllerEffect;
};

const EMPTY_METRICS: PanelMetrics = Object.freeze({ rows: 1, totalRows: 0 });

export function createTuiControllerState(): TuiControllerState {
  return {
    panelView: "activity",
    activity: { firstVisible: -1, cursor: 0, metrics: { ...EMPTY_METRICS } },
    tasks: { firstVisible: 0, metrics: { ...EMPTY_METRICS } },
    changes: { firstVisible: 0, cursor: 0, metrics: { ...EMPTY_METRICS } },
    diff: { firstVisible: 0, metrics: { ...EMPTY_METRICS }, target: { kind: "cumulative" } },
    event: { firstVisible: 0, metrics: { ...EMPTY_METRICS } },
  };
}

function paint(state: TuiControllerState): TuiControllerTransition {
  return { state, effect: { type: "paint" } };
}

function loadDiff(state: TuiControllerState, target: DiffTarget): TuiControllerTransition {
  return {
    state: {
      ...state,
      panelView: "diff",
      diff: { ...state.diff, firstVisible: 0, target },
    },
    effect: { type: "load_diff", target },
  };
}

function scrollActivity(state: TuiControllerState, key: ScrollKey): TuiControllerState {
  const { metrics } = state.activity;
  if (metrics.totalRows <= 0) return state;
  const page = Math.max(1, metrics.rows - 1);
  const delta = key === "up" ? -1 : key === "down" ? 1
    : key === "pageup" ? -page : key === "pagedown" ? page
    : key === "home" ? -Infinity : Infinity;
  const cursor = Math.max(0, Math.min(metrics.totalRows - 1, state.activity.cursor + delta));
  let firstVisible = state.activity.firstVisible;
  if (key === "pageup" || key === "pagedown" || key === "home" || key === "end") {
    firstVisible = cursor;
  } else {
    const first = Math.max(0, firstVisible);
    if (cursor < first) firstVisible = cursor;
    else if (cursor >= first + metrics.rows) firstVisible = cursor - metrics.rows + 1;
  }
  return { ...state, activity: { ...state.activity, cursor, firstVisible } };
}

function scrollChanges(state: TuiControllerState, key: ScrollKey, total: number): TuiControllerState {
  if (total <= 0) return state;
  const page = Math.max(1, state.changes.metrics.rows - 1);
  const delta = key === "up" ? -1 : key === "down" ? 1
    : key === "pageup" ? -page : key === "pagedown" ? page
    : key === "home" ? -Infinity : Infinity;
  const cursor = Math.max(0, Math.min(total - 1, state.changes.cursor + delta));
  let firstVisible = state.changes.firstVisible;
  if (key === "pageup" || key === "pagedown" || key === "home" || key === "end") {
    firstVisible = cursor;
  } else if (cursor < firstVisible) {
    firstVisible = cursor;
  } else if (cursor >= firstVisible + state.changes.metrics.rows) {
    firstVisible = cursor - state.changes.metrics.rows + 1;
  }
  return { ...state, changes: { ...state.changes, cursor, firstVisible } };
}

function scrollCurrent(state: TuiControllerState, key: ScrollKey, snapshot?: TuiSnapshot): TuiControllerState {
  if (state.panelView === "tasks") {
    return {
      ...state,
      tasks: {
        ...state.tasks,
        firstVisible: advanceScroll(key, state.tasks.firstVisible, state.tasks.metrics.totalRows, state.tasks.metrics.rows),
      },
    };
  }
  if (state.panelView === "changes") {
    const total = snapshot?.changes.status === "ready" ? (snapshot.changes.entries?.length ?? 0) : 0;
    return scrollChanges(state, key, total);
  }
  if (state.panelView === "diff") {
    return {
      ...state,
      diff: {
        ...state.diff,
        firstVisible: advanceScroll(key, state.diff.firstVisible, state.diff.metrics.totalRows, state.diff.metrics.rows),
      },
    };
  }
  if (state.panelView === "event") {
    return {
      ...state,
      event: {
        ...state.event,
        firstVisible: advanceScroll(key, state.event.firstVisible, state.event.metrics.totalRows, state.event.metrics.rows),
      },
    };
  }
  return scrollActivity(state, key);
}

export function reduceTuiController(
  state: TuiControllerState,
  action: TuiControllerAction,
  snapshot?: TuiSnapshot,
): TuiControllerTransition {
  if (action.type === "tab") {
    if (state.panelView === "diff" || state.panelView === "event") return paint(state);
    return paint({ ...state, panelView: nextPanelView(state.panelView) });
  }

  if (action.type === "diff") {
    if (state.panelView === "changes") return loadDiff(state, { kind: "cumulative" });
    if (state.panelView === "diff") return loadDiff(state, state.diff.target);
    return { state };
  }

  if (action.type === "enter") {
    if (state.panelView === "activity") {
      const selected = snapshot?.events[state.activity.cursor];
      if (selected === undefined) return { state };
      return paint({
        ...state,
        panelView: "event",
        event: { ...state.event, firstVisible: 0, detailKey: eventKeyOf(selected) },
      });
    }
    if (state.panelView === "changes") {
      const selected = snapshot?.changes.status === "ready"
        ? snapshot.changes.entries?.[state.changes.cursor]
        : undefined;
      return selected === undefined ? { state } : loadDiff(state, { kind: "file", file: selected });
    }
    return { state };
  }

  if (action.type === "escape") {
    if (state.panelView === "diff") return paint({ ...state, panelView: "changes" });
    if (state.panelView === "event") return paint({ ...state, panelView: "activity" });
    return paint(scrollCurrent(state, "home", snapshot));
  }

  return paint(scrollCurrent(state, action.key, snapshot));
}

/**
 * Reconcile navigation state with a newly built frame.
 * Only the visible view receives fresh metrics; hidden viewports keep their
 * independent offsets until they become visible again.
 */
export function syncTuiControllerFrame(
  state: TuiControllerState,
  previous: TuiSnapshot | undefined,
  next: TuiSnapshot,
  currentMetrics: PanelMetrics,
): TuiControllerState {
  let updated = state;

  // A historical activity selection follows event identity across prepends.
  // Cursor 0 intentionally follows the live head instead of an identity.
  if (state.activity.cursor > 0) {
    const previousEvent = previous?.events[state.activity.cursor];
    if (previousEvent !== undefined) {
      const key = eventKeyOf(previousEvent);
      const cursor = next.events.findIndex(event => eventKeyOf(event) === key);
      if (cursor >= 0) {
        const shift = cursor - state.activity.cursor;
        updated = {
          ...updated,
          activity: {
            ...updated.activity,
            cursor,
            firstVisible: updated.activity.firstVisible >= 0
              ? updated.activity.firstVisible + shift
              : updated.activity.firstVisible,
          },
        };
      }
    }
  }

  const activityCursor = Math.max(0, Math.min(updated.activity.cursor, Math.max(0, next.events.length - 1)));
  const changeEntries = next.changes.status === "ready" ? (next.changes.entries ?? []) : [];
  const changeCursor = Math.max(0, Math.min(updated.changes.cursor, Math.max(0, changeEntries.length - 1)));
  updated = {
    ...updated,
    activity: { ...updated.activity, cursor: activityCursor },
    changes: { ...updated.changes, cursor: changeCursor },
  };

  if (updated.panelView === "activity") {
    updated = {
      ...updated,
      activity: {
        ...updated.activity,
        metrics: currentMetrics,
        firstVisible: Math.min(updated.activity.firstVisible, maxFirstVisible(currentMetrics.totalRows, currentMetrics.rows)),
      },
    };
  } else if (updated.panelView === "tasks") {
    updated = {
      ...updated,
      tasks: {
        ...updated.tasks,
        metrics: currentMetrics,
        firstVisible: Math.min(updated.tasks.firstVisible, maxFirstVisible(currentMetrics.totalRows, currentMetrics.rows)),
      },
    };
  } else if (updated.panelView === "changes") {
    let firstVisible = Math.min(updated.changes.firstVisible, maxFirstVisible(currentMetrics.totalRows, currentMetrics.rows));
    if (changeCursor < firstVisible) firstVisible = changeCursor;
    else if (changeCursor >= firstVisible + currentMetrics.rows) firstVisible = changeCursor - currentMetrics.rows + 1;
    updated = {
      ...updated,
      changes: { ...updated.changes, metrics: currentMetrics, firstVisible },
    };
  } else if (updated.panelView === "diff") {
    updated = {
      ...updated,
      diff: {
        ...updated.diff,
        metrics: currentMetrics,
        firstVisible: Math.min(updated.diff.firstVisible, maxFirstVisible(currentMetrics.totalRows, currentMetrics.rows)),
      },
    };
  } else {
    updated = {
      ...updated,
      event: {
        ...updated.event,
        metrics: currentMetrics,
        firstVisible: Math.min(updated.event.firstVisible, maxFirstVisible(currentMetrics.totalRows, currentMetrics.rows)),
      },
    };
  }

  return updated;
}

export function controllerRenderOptions(state: TuiControllerState): {
  panelView: PanelView;
  firstVisible: number;
  taskFirstVisible: number;
  changeFirstVisible: number;
  diffFirstVisible: number;
  expandFirstVisible: number;
  activityCursor: number;
  changeCursor: number;
  eventDetailKey?: string;
} {
  return {
    panelView: state.panelView,
    firstVisible: state.activity.firstVisible,
    taskFirstVisible: state.tasks.firstVisible,
    changeFirstVisible: state.changes.firstVisible,
    diffFirstVisible: state.diff.firstVisible,
    expandFirstVisible: state.event.firstVisible,
    activityCursor: state.activity.cursor,
    changeCursor: state.changes.cursor,
    ...(state.event.detailKey !== undefined ? { eventDetailKey: state.event.detailKey } : {}),
  };
}
