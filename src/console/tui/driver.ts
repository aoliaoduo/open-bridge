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
import { collectFileDiffPreview, collectReviewDiffPreview, collectWorkspaceChanges, type ChangeFile, type ChangeSummary, type FileDiffPreview, type ReviewDiffPreview } from "./changes.js";
import { todoFreshness } from "../../bridge/todo-store.js";
import { buildSnapshot } from "./snapshot.js";
import { renderFrame, panelScrollMetrics, maxFirstVisible, advanceScroll, nextPanelView, eventKeyOf, type PanelView, type ScrollKey } from "./render.js";

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
/** Invalidates async Git work that outlives a stopped/restarted TUI session. */
let sessionGeneration = 0;
/** Panel scroll position; negative = locked to the head (the newest event). */
let scrollFirst = -1;
/** Which view owns the wide panel: activity, tasks, or the per-file 变更 list. */
let panelView: PanelView = "activity";
/** Task scroll is independent of the activity view and counts wrapped rows. */
let taskScrollFirst = 0;
/** Change-list scroll is independent of the other two views. */
let changeScrollFirst = 0;
/** 变更光标：一个下标对应一个文件；Enter 打开该文件的工作树 diff。 */
let changeCursor = 0;
let activityMetrics = { rows: 1, totalRows: 0 };
let taskMetrics = { rows: 1, totalRows: 0 };
let changeMetrics = { rows: 1, totalRows: 0 };
/** Workspace changes since the last commit; undefined = 非 git. */
let workspaceChanges: ChangeSummary | undefined;
let changesTimer: ReturnType<typeof setInterval> | undefined;
type DiffTarget = { kind: "cumulative" } | { kind: "file"; file: ChangeFile };
type LoadedDiff =
  | { kind: "cumulative"; result: ReviewDiffPreview }
  | { kind: "file"; result: FileDiffPreview };
/** d 打开累计 review diff；Enter 打开当前文件的工作树 diff。 */
let diffTarget: DiffTarget = { kind: "cumulative" };
let diffState: LoadedDiff | undefined;
let diffLoading = false;
let diffScrollFirst = 0;
let diffMetrics = { rows: 1, totalRows: 0 };
/** 活动光标：单行模式下事件下标 == 行下标；↑↓ 移动，Enter 展开。 */
let activityCursor = 0;
/** Enter 打开的事件（at|tool 键）；滚出环形日志后详情页显示占位。 */
let eventDetailKey: string | undefined;
let expandScrollFirst = 0;
let expandMetrics = { rows: 1, totalRows: 0 };
/** 最近一帧快照：按键处理要从里面取光标行的事件。 */
let lastSnapshot: ReturnType<typeof buildSnapshot> | undefined;

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
  const session = ++sessionGeneration;
  active = true;
  panelView = "activity";
  scrollFirst = -1;
  taskScrollFirst = 0;
  changeScrollFirst = 0;
  changeCursor = 0;
  workspaceChanges = undefined;
  diffTarget = { kind: "cumulative" };
  diffState = undefined;
  diffLoading = false;
  diffScrollFirst = 0;
  activityCursor = 0;
  eventDetailKey = undefined;
  expandScrollFirst = 0;
  // 上一次会话的帧快照与量度不能带进新会话：回车取的是「当前帧的光标行」，
  // 旧快照会让 Enter 打开一条早已不存在的事件（键撞上同时刻新事件时更隐蔽）。
  lastSnapshot = undefined;
  activityMetrics = { rows: 1, totalRows: 0 };
  taskMetrics = { rows: 1, totalRows: 0 };
  changeMetrics = { rows: 1, totalRows: 0 };
  diffMetrics = { rows: 1, totalRows: 0 };
  expandMetrics = { rows: 1, totalRows: 0 };
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
      if (session !== sessionGeneration || gen !== changesGen) return;
      workspaceChanges = summary;
    }).catch(() => {
      if (session !== sessionGeneration || gen !== changesGen) return;
      // A thrown probe is a failed read of *something* — never impersonate 非 git.
      workspaceChanges = { files: 0, insertions: 0, deletions: 0, unavailable: true };
    });
  };

  let diffGen = 0;
  const diffSnapshotInput = () => {
    const target = diffTarget.kind === "file"
      ? { kind: "file" as const, path: diffTarget.file.path }
      : { kind: "cumulative" as const };
    if (diffLoading) return { ...target, loading: true, ok: false, text: "", truncated: false, since: "", checkpoint: "", reason: "" };
    if (diffState === undefined) return undefined;
    if (diffState.kind === "cumulative") {
      const result = diffState.result;
      if (!result.ok) return { ...target, loading: false, ok: false, text: "", truncated: false, since: "", checkpoint: "", reason: result.reason };
      return { ...target, loading: false, ok: true, text: result.text, truncated: result.truncated, since: result.since, checkpoint: result.checkpoint, reason: "" };
    }
    const result = diffState.result;
    if (!result.ok) return { ...target, loading: false, ok: false, text: "", truncated: false, since: "", checkpoint: "", reason: result.reason };
    return { ...target, loading: false, ok: true, text: result.text, truncated: result.truncated, since: "", checkpoint: "", reason: "" };
  };
  // The diff is IO (git), fetched on demand with a generation token so a slow
  // read cannot overwrite a newer request — same contract as refreshChanges.
  const loadDiff = (target: DiffTarget): void => {
    const gen = ++diffGen;
    diffTarget = target;
    diffState = undefined;
    diffLoading = true;
    diffScrollFirst = 0;
    panelView = "diff";
    paint();
    const finish = (loaded: LoadedDiff): void => {
      if (session !== sessionGeneration || gen !== diffGen) return;
      diffLoading = false;
      diffState = loaded;
      paint();
    };
    const fail = (): void => finish(target.kind === "file"
      ? { kind: "file", result: { ok: false, path: target.file.path, reason: "读取失败" } }
      : { kind: "cumulative", result: { ok: false, reason: "读取失败" } });
    if (target.kind === "file") {
      void collectFileDiffPreview(options.rootPath, target.file)
        .then(result => finish({ kind: "file", result }))
        .catch(fail);
    } else {
      void collectReviewDiffPreview()
        .then(result => finish({ kind: "cumulative", result }))
        .catch(fail);
    }
  };

  const write = (payload: string): void => {
    try { out.write(payload); } catch { /* a dead pipe must never crash the bridge */ }
  };
  const paint = (): void => {
    // The dashboard is an observer of the work, never part of it: any
    // rendering failure is swallowed and the next tick tries again.
    try {
      // Once the operator moves off the live head, anchor the cursor by event
      // identity. New rows are prepended; retaining only the array index would
      // silently move Enter to a different call on every repaint.
      const selectedEventKey = activityCursor > 0
        ? lastSnapshot?.events[activityCursor] && eventKeyOf(lastSnapshot.events[activityCursor]!)
        : undefined;
      const snapshot = buildSnapshot(state, { ...options, launchedAt, workspaceChanges, diff: diffSnapshotInput(), todosUpdatedAt: todoFreshness() });
      if (selectedEventKey !== undefined) {
        const nextCursor = snapshot.events.findIndex(event => eventKeyOf(event) === selectedEventKey);
        if (nextCursor >= 0) {
          const shift = nextCursor - activityCursor;
          activityCursor = nextCursor;
          if (scrollFirst >= 0) scrollFirst += shift;
        }
      }
      lastSnapshot = snapshot;
      const dimensions = { width: out.columns ?? 80, height: out.rows ?? 24 };
      activityMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "activity" });
      taskMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "tasks" });
      changeMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "changes" });
      diffMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "diff" });
      expandMetrics = panelScrollMetrics(snapshot, { ...dimensions, panelView: "event", eventDetailKey });
      // Clamp stored positions too: a list shrink must not leave a hidden stale
      // offset that reappears when tasks grow again. Keep the activity sentinel.
      scrollFirst = Math.min(scrollFirst, maxFirstVisible(activityMetrics.totalRows, activityMetrics.rows));
      taskScrollFirst = Math.min(taskScrollFirst, maxFirstVisible(taskMetrics.totalRows, taskMetrics.rows));
      changeScrollFirst = Math.min(changeScrollFirst, maxFirstVisible(changeMetrics.totalRows, changeMetrics.rows));
      diffScrollFirst = Math.min(diffScrollFirst, maxFirstVisible(diffMetrics.totalRows, diffMetrics.rows));
      expandScrollFirst = Math.min(expandScrollFirst, maxFirstVisible(expandMetrics.totalRows, expandMetrics.rows));
      activityCursor = Math.max(0, Math.min(activityCursor, Math.max(0, activityMetrics.totalRows - 1)));
      changeCursor = Math.max(0, Math.min(changeCursor, Math.max(0, (snapshot.changes?.entries?.length ?? 0) - 1)));
      if (changeCursor < changeScrollFirst) changeScrollFirst = changeCursor;
      else if (changeCursor >= changeScrollFirst + changeMetrics.rows) changeScrollFirst = changeCursor - changeMetrics.rows + 1;
      const lines = renderFrame(snapshot, {
        ...dimensions,
        spinnerFrame: frameIndex++,
        firstVisible: scrollFirst,
        taskFirstVisible: taskScrollFirst,
        changeFirstVisible: changeScrollFirst,
        diffFirstVisible: diffScrollFirst,
        expandFirstVisible: expandScrollFirst,
        activityCursor,
        changeCursor,
        eventDetailKey,
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
            // 详情页与 diff 预览同一契约：Tab 失效，Esc 是唯一出口。
            if (panelView !== "diff" && panelView !== "event") panelView = nextPanelView(panelView);
            paint();
            return;
          }
          if (panelView === "changes" && ch === "d") {
            // 累计 diff 预览：review_changes 的只读面。
            loadDiff({ kind: "cumulative" });
            return;
          }
          if (panelView === "diff") {
            if (ch === "d") { loadDiff(diffTarget); return; }
            // Esc 是预览的唯一出口（回到变更页）；滚动键仍归 KEY_MAP。
            if (key?.name === "escape") { panelView = "changes"; paint(); return; }
          }
          if (panelView === "event") {
            // Esc 是详情的唯一出口（回到活动页）；滚动键仍归 KEY_MAP。
            if (key?.name === "escape") { panelView = "activity"; paint(); return; }
          }
          if (panelView === "activity" && (key?.name === "return" || key?.name === "enter")) {
            // 光标行展开全文：详情页自带滚动，Esc 返回。首帧靠定时器，开屏
            // 立刻回车时还没有任何快照 —— 先同步画一帧再取事件，别静默失效。
            if (lastSnapshot === undefined) paint();
            const selected = lastSnapshot?.events[activityCursor];
            if (selected !== undefined) {
              eventDetailKey = eventKeyOf(selected);
              expandScrollFirst = 0;
              panelView = "event";
              paint();
            }
            return;
          }
          if (panelView === "changes" && (key?.name === "return" || key?.name === "enter")) {
            if (lastSnapshot === undefined) paint();
            const selected = lastSnapshot?.changes?.entries?.[changeCursor];
            if (selected !== undefined) loadDiff({ kind: "file", file: selected });
            return;
          }
          const mapped = KEY_MAP[key?.name ?? ""];
          if (mapped === undefined) return;
          if (panelView === "tasks") {
            taskScrollFirst = advanceScroll(mapped, taskScrollFirst, taskMetrics.totalRows, taskMetrics.rows);
          } else if (panelView === "changes") {
            const total = lastSnapshot?.changes?.entries?.length ?? 0;
            if (total > 0) {
              const page = Math.max(1, changeMetrics.rows - 1);
              const delta = mapped === "up" ? -1 : mapped === "down" ? 1
                : mapped === "pageup" ? -page : mapped === "pagedown" ? page
                : mapped === "home" ? -Infinity : Infinity;
              changeCursor = Math.max(0, Math.min(total - 1, changeCursor + delta));
              if (mapped === "pageup" || mapped === "pagedown" || mapped === "home" || mapped === "end") {
                changeScrollFirst = changeCursor;
              } else if (changeCursor < changeScrollFirst) {
                changeScrollFirst = changeCursor;
              } else if (changeCursor >= changeScrollFirst + changeMetrics.rows) {
                changeScrollFirst = changeCursor - changeMetrics.rows + 1;
              }
            }
          } else if (panelView === "diff") {
            diffScrollFirst = advanceScroll(mapped, diffScrollFirst, diffMetrics.totalRows, diffMetrics.rows);
          } else if (panelView === "event") {
            // 详情页自带滚动：内容超过面板时翻页看全，Esc 返回；此视图里
            // 绝不动活动光标 —— 隐藏视图的位置不能被顺手改掉。
            expandScrollFirst = advanceScroll(mapped, expandScrollFirst, expandMetrics.totalRows, expandMetrics.rows);
          } else {
            // 单行活动列表：滚动键移动光标，视口跟随光标。翻页键让光标锚定
            // 新窗口顶部（与旧的整页滚动窗口一致），单步键做最小跟随。
            const total = activityMetrics.totalRows;
            if (total > 0) {
              const page = Math.max(1, activityMetrics.rows - 1); // 与旧整页滚动同窗
              const delta = mapped === "up" ? -1 : mapped === "down" ? 1
                : mapped === "pageup" ? -page : mapped === "pagedown" ? page
                : mapped === "home" ? -Infinity : Infinity; // end
              activityCursor = Math.max(0, Math.min(total - 1, activityCursor + delta));
              if (mapped === "pageup" || mapped === "pagedown" || mapped === "home" || mapped === "end") {
                scrollFirst = activityCursor;
              } else {
                const first = Math.max(0, scrollFirst);
                if (activityCursor < first) scrollFirst = activityCursor;
                else if (activityCursor >= first + activityMetrics.rows) scrollFirst = activityCursor - activityMetrics.rows + 1;
              }
            }
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
  sessionGeneration += 1;
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
