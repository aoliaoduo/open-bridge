/**
 * Serve-console TUI driver (stage 3): alternate screen, 500 ms repaint,
 * view-local scrolling, and a small set of global operator shortcuts.
 *
 * The TUI does not mutate Bridge settings or run commands: its only direct
 * actions are safe local clipboard copies. Scroll keys are read
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
import { collectFileDiffPreview, collectReviewDiffPreview, collectWorkspaceChanges, type FileDiffPreview, type ReviewDiffPreview, type WorkspaceChangeState } from "./changes.js";
import { todoFreshness, todoProgress } from "../../bridge/todo-store.js";
import { copyTextToClipboard } from "./clipboard.js";
import { buildSnapshot } from "./snapshot.js";
import { renderFrame, panelScrollMetrics, type ScrollKey } from "./render.js";
import {
  controllerRenderOptions,
  createTuiControllerState,
  reduceTuiController,
  syncTuiControllerFrame,
  type DiffTarget,
  type TuiControllerAction,
} from "./controller.js";

export interface ConsoleTuiOptions {
  version: string;
  rootName: string;
  /** Absolute workspace root — the git-change refresh runs against it. */
  rootPath: string;
  logPath: string;
  /** Read live bearer-gate state without giving the TUI access to token material. */
  authEnabled?: () => boolean;
  /** Current endpoint text for the local clipboard shortcut. */
  mcpUrl?: () => string;
  /** Ready-made onboarding prompt for the local clipboard shortcut. */
  onboardingPrompt?: () => string;
  /** Injectable clipboard writer; defaults to the system clipboard adapter. */
  copyText?: (text: string) => Promise<void>;
}

const KEY_MAP: Record<string, ScrollKey> = {
  up: "up",
  down: "down",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
};

let timer: ReturnType<typeof setInterval> | undefined;
let resizeHandler: (() => void) | undefined;
let keyListener: ((ch: string, key: { name?: string; ctrl?: boolean }) => void) | undefined;
let frameIndex = 0;
let active = false;
/** Invalidates async Git work that outlives a stopped/restarted TUI session. */
let sessionGeneration = 0;
/** All panel/cursor/scroll state lives behind one pure controller. */
let controller = createTuiControllerState();
/** Cached workspace-change probe; loading is explicit until the first Git result. */
let workspaceChanges: WorkspaceChangeState = { status: "loading" };
let changesTimer: ReturnType<typeof setInterval> | undefined;
type LoadedDiff =
  | { kind: "cumulative"; result: ReviewDiffPreview }
  | { kind: "file"; result: FileDiffPreview };
let diffState: LoadedDiff | undefined;
let diffLoading = false;
/** 最近一帧快照：controller 的 Enter/reanchor 只依赖这一份只读事实。 */
let lastSnapshot: ReturnType<typeof buildSnapshot> | undefined;
type ActionNotice = { text: string; tone: "success" | "error" };
let actionNotice: ActionNotice | undefined;
let actionNoticeTimer: ReturnType<typeof setTimeout> | undefined;
const ACTION_NOTICE_MS = 2200;

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
  controller = createTuiControllerState();
  workspaceChanges = { status: "loading" };
  diffState = undefined;
  diffLoading = false;
  actionNotice = undefined;
  if (actionNoticeTimer !== undefined) {
    clearTimeout(actionNoticeTimer);
    actionNoticeTimer = undefined;
  }
  // 上一次会话的帧快照不能带进新会话：Enter 与历史事件 reanchor
  // 都必须基于这一轮真实画过的帧。
  lastSnapshot = undefined;
  // THIS process's start: 「运行」 must not read the persisted stats window
  // (a freshly restarted Bridge used to claim 50 hours of uptime).
  const launchedAt = Date.now();

  // Workspace changes since the last commit — the dirty-tree summary,
  // dashboard style. Git/file IO refreshes on a slow cadence; the 500ms paint
  // tick only reads the cache. One probe at a time: if a 5s tick arrives while
  // Git is still busy, coalesce it into exactly one follow-up instead of
  // stacking more child processes behind the slow repository.
  let changesRefreshing = false;
  let changesQueued = false;
  const refreshChanges = (): void => {
    if (changesRefreshing) {
      changesQueued = true;
      return;
    }
    changesRefreshing = true;
    void collectWorkspaceChanges(options.rootPath)
      .then(summary => {
        if (session !== sessionGeneration) return;
        workspaceChanges = summary;
        paint();
      })
      .catch(() => {
        if (session !== sessionGeneration) return;
        workspaceChanges = { status: "unavailable" };
        paint();
      })
      .finally(() => {
        changesRefreshing = false;
        if (session !== sessionGeneration || !changesQueued) return;
        changesQueued = false;
        refreshChanges();
      });
  };

  let diffGen = 0;
  const diffSnapshotInput = () => {
    const target = controller.diff.target.kind === "file"
      ? { kind: "file" as const, path: controller.diff.target.file.path }
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
  // read cannot overwrite a newer request. Navigation already moved to diff;
  // this effect only owns loading/result state.
  const loadDiff = (target: DiffTarget): void => {
    const gen = ++diffGen;
    diffState = undefined;
    diffLoading = true;
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
      let authEnabled = false;
      try { authEnabled = options.authEnabled?.() === true; } catch { /* unreadable config degrades to the safer warning state */ }
      const snapshot = buildSnapshot(state, {
        ...options,
        authEnabled,
        launchedAt,
        workspaceChanges,
        diff: diffSnapshotInput(),
        todosUpdatedAt: todoFreshness(),
        todoProgress: todoProgress(),
      });
      const dimensions = { width: out.columns ?? 80, height: out.rows ?? 24 };
      // Only materialize rows for the visible panel. The controller reconciles
      // cursor identity, shrinking lists and that view's independent viewport.
      const currentMetrics = panelScrollMetrics(snapshot, {
        ...dimensions,
        panelView: controller.panelView,
        eventDetailKey: controller.event.detailKey,
      });
      controller = syncTuiControllerFrame(controller, lastSnapshot, snapshot, currentMetrics);
      lastSnapshot = snapshot;
      const lines = renderFrame(snapshot, {
        ...dimensions,
        spinnerFrame: frameIndex++,
        actionNotice,
        ...controllerRenderOptions(controller),
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
      const showNotice = (notice: ActionNotice): void => {
        actionNotice = notice;
        if (actionNoticeTimer !== undefined) clearTimeout(actionNoticeTimer);
        actionNoticeTimer = setTimeout(() => {
          if (session !== sessionGeneration) return;
          actionNotice = undefined;
          actionNoticeTimer = undefined;
          paint();
        }, ACTION_NOTICE_MS);
        actionNoticeTimer.unref();
        paint();
      };
      const copyShortcut = (kind: "url" | "prompt"): void => {
        let text = "";
        try {
          text = kind === "url" ? (options.mcpUrl?.() ?? "") : (options.onboardingPrompt?.() ?? "");
        } catch {
          showNotice({ text: kind === "url" ? "✕ MCP URL 不可用" : "✕ 接入提示词不可用", tone: "error" });
          return;
        }
        if (text === "") {
          showNotice({ text: kind === "url" ? "✕ MCP URL 不可用" : "✕ 接入提示词不可用", tone: "error" });
          return;
        }
        const writer = options.copyText ?? copyTextToClipboard;
        void writer(text)
          .then(() => {
            if (session !== sessionGeneration) return;
            showNotice({
              text: kind === "url" ? "✓ 已复制 MCP URL" : "✓ 已复制接入提示词",
              tone: "success",
            });
          })
          .catch(() => {
            if (session !== sessionGeneration) return;
            showNotice({
              text: kind === "url" ? "✕ 复制 MCP URL 失败" : "✕ 复制接入提示词失败",
              tone: "error",
            });
          });
      };
      keyListener = (ch, key) => {
        try {
          if (ch === "\x03" || (key?.ctrl === true && key.name === "c")) {
            // Raw mode swallows the terminal's SIGINT; raise the real one so
            // the graceful shutdown path (and its cleanup) runs as before.
            process.kill(process.pid, "SIGINT");
            return;
          }
          if (key?.ctrl !== true && key?.name === "u") {
            copyShortcut("url");
            return;
          }
          if (key?.ctrl !== true && key?.name === "p") {
            copyShortcut("prompt");
            return;
          }
          let action: TuiControllerAction | undefined;
          if (ch === "\t" || key?.name === "tab") action = { type: "tab" };
          else if (ch === "d" && (controller.panelView === "changes" || controller.panelView === "diff")) action = { type: "diff" };
          else if (key?.name === "return" || key?.name === "enter") action = { type: "enter" };
          else if (key?.name === "escape") action = { type: "escape" };
          else {
            const mapped = KEY_MAP[key?.name ?? ""];
            if (mapped !== undefined) action = { type: "scroll", key: mapped };
          }
          if (action === undefined) return;

          // Enter on the first instant after startup needs a real frame to
          // select from; all later transitions consume the last painted snapshot.
          if (action.type === "enter" && lastSnapshot === undefined) paint();
          const transition = reduceTuiController(controller, action, lastSnapshot);
          controller = transition.state;
          if (transition.effect?.type === "load_diff") loadDiff(transition.effect.target);
          else if (transition.effect?.type === "paint") paint();
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
  if (actionNoticeTimer !== undefined) {
    clearTimeout(actionNoticeTimer);
    actionNoticeTimer = undefined;
  }
  actionNotice = undefined;
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
