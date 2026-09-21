/**
 * Serve-console TUI driver (stage 3): alternate screen, 500 ms repaint, and
 * view-local scrolling with Tab as the only view-switching key.
 *
 * The TUI is a viewing surface by design (settings and background operations
 * live in the web console), so no command input exists. Scroll keys are read
 * through raw mode; inside raw mode Ctrl+C no longer raises SIGINT by itself,
 * so \x03 is translated into a real SIGINT against ourselves and the existing
 * graceful shutdown path runs unchanged (it calls stopConsoleTui, which
 * restores the alternate screen AND the raw stdin). Every terminal mode the
 * driver touches is restored on stop and once more on "exit" as a net for
 * paths that bypass the graceful stop.
 *
 * Without a real console (service, CI, redirect, --no-tui) startConsoleTui()
 * answers false and the plain output path is untouched.
 */

import * as readline from "node:readline";
import type { ReadStream } from "node:tty";
import { state } from "../../bridge/state.js";
import { collectReviewDiffPreview, collectWorkspaceChanges, type ChangeSummary, type ReviewDiffPreview } from "./changes.js";
import { todoFreshness } from "../../bridge/todo-store.js";
import { buildSnapshot } from "./snapshot.js";
import { renderFrame, panelScrollMetrics, maxFirstVisible, advanceScroll, nextPanelView, type PanelView, type ScrollKey } from "./render.js";

export interface ConsoleTuiOptions {
  version: string;
  rootName: string;
  /** Absolute workspace root — the git-change refresh runs against it. */
  rootPath: string;
  logPath: string;
}

const KEY_MAP: Record<string, ScrollKey> = {
  up: "up",
  down: "down",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
  escape: "home", // Esc snaps back to the newest events, like Home
};

let timer: ReturnType<typeof setInterval> | undefined;
let resizeHandler: (() => void) | undefined;
let keyListener: ((ch: string, key: { name?: string; ctrl?: boolean }) => void) | undefined;
let frameIndex = 0;
let active = false;
/** Panel scroll position; negative = locked to the head (the newest event). */
let scrollFirst = -1;
/** Which view owns the wide panel: activity, tasks, or the per-file 变更 list. */
let panelView: PanelView = "activity";
/** Task scroll is independent of the activity view and counts wrapped rows. */
let taskScrollFirst = 0;
/** Change-list scroll is independent of the other two views. */
let changeScrollFirst = 0;
let activityMetrics = { rows: 1, totalRows: 0 };
let taskMetrics = { rows: 1, totalRows: 0 };
let changeMetrics = { rows: 1, totalRows: 0 };
/** Workspace changes since the last commit; undefined = 非 git. */
let workspaceChanges: ChangeSummary | undefined;
let changesTimer: ReturnType<typeof setInterval> | undefined;
/** 累计 diff 预览（按 d 请求；只读，不推进审阅基线）。 */
let diffState: ReviewDiffPreview | undefined;
let diffLoading = false;
let diffScrollFirst = 0;
let diffMetrics = { rows: 1, totalRows: 0 };

export function consoleTuiActive(): boolean {
  return active;
}

function restoreStdin(): void {
  const stdin = process.stdin as ReadStream;
  if (keyListener !== undefined) {
    stdin.off("keypress", keyListener);
    keyListener = undefined;
  }
  try {
    if (stdin.isTTY === true && stdin.isRaw === true) {
      stdin.setRawMode(false);
      stdin.pause();
    }
  } catch { /* best effort */ }
}

export function startConsoleTui(options: ConsoleTuiOptions): boolean {
  const out = process.stdout;
  if (!out.isTTY) return false;
  if (active) return true;
  active = true;
  panelView = "activity";
  scrollFirst = -1;
  taskScrollFirst = 0;
  changeScrollFirst = 0;
  diffState = undefined;
  diffLoading = false;
  diffScrollFirst = 0;
  // THIS process's start: 「运行」 must not read the persisted stats window
  // (a freshly restarted Bridge used to claim 50 hours of uptime).
  const launchedAt = Date.now();

  // Workspace changes since the last commit — the dirty-tree summary,
  // dashboard style. It is IO (git + file reads), so it refreshes on its own
  // slow cadence; the 500ms render tick only reads the cached value.
  // Generation token: a slow probe must not overwrite a newer one.
  let changesGen = 0;
  const refreshChanges = (): void => {
    const gen = ++changesGen;
    void collectWorkspaceChanges(options.rootPath).then(summary => {
      if (gen !== changesGen) return;
      workspaceChanges = summary;
    }).catch(() => {
      if (gen !== changesGen) return;
      // A thrown probe is a failed read of *something* — never impersonate 非 git.
      workspaceChanges = { files: 0, insertions: 0, deletions: 0, unavailable: true };
    });
  };

  let diffGen = 0;
  const diffSnapshotInput = () => diffLoading
    ? { loading: true, ok: false, text: "", truncated: false, since: "", checkpoint: "", reason: "" }
    : diffState === undefined ? undefined
    : diffState.ok
      ? { loading: false, ok: true, text: diffState.text, truncated: diffState.truncated, since: diffState.since, checkpoint: diffState.checkpoint, reason: "" }
      : { loading: false, ok: false, text: "", truncated: false, since: "", checkpoint: "", reason: diffState.reason };
  // The diff is IO (git), fetched on demand with a generation token so a slow
  // read cannot overwrite a newer request — same contract as refreshChanges.
  const loadDiff = (): void => {
    const gen = ++diffGen;
    diffLoading = true;
    paint();
    void collectReviewDiffPreview().then(result => {
      if (gen !== diffGen) return;
      diffLoading = false;
      diffState = result;
      panelView = "diff";
      paint();
    }).catch(() => {
      if (gen !== diffGen) return;
      diffLoading = false;
      diffState = { ok: false, reason: "读取失败" };
      panelView = "diff";
      paint();
    });
  };

  const write = (payload: string): void => {
    try { out.write(payload); } catch { /* a dead pipe must never crash the bridge */ }
  };
  const paint = (): void => {
    // The dashboard is an observer of the work, never part of it: any
    // rendering failure is swallowed and the next tick tries again.
    try {
      const snapshot = buildSnapshot(state, { ...options, launchedAt, workspaceChanges, diff: diffSnapshotInput(), todosUpdatedAt: todoFreshness() });
      const dimensions = { width: out.columns ?? 80, height: out.rows ?? 24 };
      activityMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "activity" });
      taskMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "tasks" });
      changeMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "changes" });
      diffMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "diff" });
      // Clamp stored positions too: a list shrink must not leave a hidden stale
      // offset that reappears when tasks grow again. Keep the activity sentinel.
      scrollFirst = Math.min(scrollFirst, maxFirstVisible(activityMetrics.totalRows, activityMetrics.rows));
      taskScrollFirst = Math.min(taskScrollFirst, maxFirstVisible(taskMetrics.totalRows, taskMetrics.rows));
      changeScrollFirst = Math.min(changeScrollFirst, maxFirstVisible(changeMetrics.totalRows, changeMetrics.rows));
      diffScrollFirst = Math.min(diffScrollFirst, maxFirstVisible(diffMetrics.totalRows, diffMetrics.rows));
      const lines = renderFrame(snapshot, {
        ...dimensions,
        spinnerFrame: frameIndex++,
        firstVisible: scrollFirst,
        taskFirstVisible: taskScrollFirst,
        changeFirstVisible: changeScrollFirst,
        diffFirstVisible: diffScrollFirst,
        panelView,
      });
      // A full-width write leaves the cursor on the last cell (wrap pending).
      // Erasing there eats that cell — or the last half of a wide character.
      // Address and clear each row BEFORE drawing, with no LF/autowrap path
      // and no trailing erase that could remove newly painted content.
      write(lines.map((line, index) =>
        `${index === 0 ? "\x1b[H" : `\x1b[${index + 1};1H`}\x1b[2K${line}`,
      ).join(""));
    } catch { /* see above */ }
  };

  write("\x1b[?1049h\x1b[?25l"); // alternate screen + hidden cursor

  const stdin = process.stdin as ReadStream;
  if (stdin.isTTY === true) {
    try {
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      keyListener = (ch, key) => {
        try {
          if (ch === "\x03" || (key?.ctrl === true && key.name === "c")) {
            // Raw mode swallows the terminal's SIGINT; raise the real one so
            // the graceful shutdown path (and its cleanup) runs as before.
            process.kill(process.pid, "SIGINT");
            return;
          }
          if (ch === "\t" || key?.name === "tab") {
            // The one navigation key: cycle the wide panel views. Inside the
            // diff preview Tab is inert by contract — d opens the preview,
            // Esc is the one way out, and Tab must not fling the operator
            // elsewhere while they are reading the diff.
            if (panelView !== "diff") panelView = nextPanelView(panelView);
            paint();
            return;
          }
          if (panelView === "changes" && ch === "d") {
            // 累计 diff 预览：review_changes 的只读面。
            loadDiff();
            return;
          }
          if (panelView === "diff") {
            if (ch === "d") { loadDiff(); return; }
            // Esc 是预览的唯一出口（回到变更页）；滚动键仍归 KEY_MAP。
            if (key?.name === "escape") { panelView = "changes"; paint(); return; }
          }
          const mapped = KEY_MAP[key?.name ?? ""];
          if (mapped === undefined) return;
          if (panelView === "tasks") {
            taskScrollFirst = advanceScroll(mapped, taskScrollFirst, taskMetrics.totalRows, taskMetrics.rows);
          } else if (panelView === "changes") {
            changeScrollFirst = advanceScroll(mapped, changeScrollFirst, changeMetrics.totalRows, changeMetrics.rows);
          } else if (panelView === "diff") {
            diffScrollFirst = advanceScroll(mapped, diffScrollFirst, diffMetrics.totalRows, diffMetrics.rows);
          } else {
            scrollFirst = advanceScroll(mapped, scrollFirst, activityMetrics.totalRows, activityMetrics.rows);
          }
          paint();
        } catch { /* a key must never crash the bridge */ }
      };
      stdin.on("keypress", keyListener);
    } catch {
      /* No raw-mode stdin: the dashboard simply stays read-only, repaint only. */
    }
  }

  timer = setInterval(paint, 500);
  timer.unref();
  refreshChanges();
  changesTimer = setInterval(refreshChanges, 5000);
  changesTimer.unref();
  resizeHandler = paint;
  out.on("resize", paint);
  paint();
  return true;
}

export function stopConsoleTui(): void {
  if (!active) return;
  active = false;
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
  if (changesTimer !== undefined) {
    clearInterval(changesTimer);
    changesTimer = undefined;
  }
  if (resizeHandler !== undefined) {
    process.stdout.off("resize", resizeHandler);
    resizeHandler = undefined;
  }
  restoreStdin();
  try { process.stdout.write("\x1b[?25h\x1b[?1049l"); } catch { /* best effort */ }
}

// Last-resort restore: exits that bypass the graceful path (a hard deadline)
// would otherwise leave a hidden cursor behind — the kind of dirt operators
// remember. Synchronous writes on "exit" are allowed and tiny.
process.on("exit", () => {
  if (active) {
    active = false;
    restoreStdin();
    try { process.stdout.write("\x1b[?25h\x1b[?1049l"); } catch { /* best effort */ }
  }
});
