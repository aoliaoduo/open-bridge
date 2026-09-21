/**
 * Serve-console TUI driver (stage 3): alternate screen, 500 ms repaint, and
 * exactly one interaction — scrolling the activity panel.
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
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ReadStream } from "node:tty";
import { state } from "../../bridge/state.js";
import { buildSnapshot } from "./snapshot.js";
import { renderFrame, workbenchPanelRows, advanceScroll, type ScrollKey } from "./render.js";

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
/** Which view owns the wide panel: the activity stream or the full task list. */
let panelView: "activity" | "tasks" = "activity";
/** Event count of the last painted frame, so scroll steps clamp correctly. */
let lastEventCount = 0;
/** Workspace changes since the last commit; undefined = clean or no repo. */
let workspaceChanges: { files: number; insertions: number; deletions: number } | undefined;
let changesTimer: ReturnType<typeof setInterval> | undefined;

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
  // THIS process's start: 「运行」 must not read the persisted stats window
  // (a freshly restarted Bridge used to claim 50 hours of uptime).
  const launchedAt = Date.now();

  // Workspace changes since the last commit — the dirty-tree summary,
  // dashboard style. It is IO (git + file reads), so it refreshes on its own
  // slow cadence; the 500ms render tick only reads the cached value.
  const refreshChanges = (): void => {
    execFile("git", ["-C", options.rootPath, "-c", "core.quotepath=off", "status", "--porcelain"], { timeout: 5000 }, (err, statusOut) => {
      if (err || typeof statusOut !== "string") {
        workspaceChanges = undefined; // no git, not a repository, or a timeout
        return;
      }
      const entries = statusOut.split(/\r?\n/).filter(line => line.length > 0);
      const untracked = entries
        .filter(line => line.startsWith("??"))
        .map(line => line.slice(3).trim().replace(/^"(.*)"$/, "$1"));
      void (async () => {
        let insertions = 0;
        let deletions = 0;
        await new Promise<void>(resolve => {
          execFile("git", ["-C", options.rootPath, "diff", "--numstat", "HEAD"], { timeout: 5000 }, (numstatErr, numstat) => {
            // No HEAD yet (zero commits): the status output above already
            // carries everything as untracked.
            if (!numstatErr && typeof numstat === "string") {
              for (const line of numstat.split(/\r?\n/)) {
                const [added, removed] = line.split("\t");
                const add = Number(added);
                const del = Number(removed);
                if (Number.isFinite(add) && Number.isFinite(del)) {
                  insertions += add;
                  deletions += del;
                }
              }
            }
            resolve();
          });
        });
        // Untracked files count as whole-file additions (bounded work).
        for (const rel of untracked.slice(0, 64)) {
          try {
            const buf = await fs.readFile(path.join(options.rootPath, rel));
            if (buf.byteLength <= 512 * 1024) insertions += Math.max(1, buf.toString("utf8").split("\n").length);
          } catch { /* deleted between status and read */ }
        }
        workspaceChanges = entries.length > 0 ? { files: entries.length, insertions, deletions } : undefined;
      })().catch(() => {
        workspaceChanges = undefined;
      });
    });
  };

  const write = (payload: string): void => {
    try { out.write(payload); } catch { /* a dead pipe must never crash the bridge */ }
  };
  const paint = (): void => {
    // The dashboard is an observer of the work, never part of it: any
    // rendering failure is swallowed and the next tick tries again.
    try {
      const snapshot = buildSnapshot(state, { ...options, launchedAt, workspaceChanges });
      lastEventCount = snapshot.events.length;
      const lines = renderFrame(snapshot, {
        width: out.columns ?? 80,
        height: out.rows ?? 24,
        spinnerFrame: frameIndex++,
        firstVisible: scrollFirst,
        panelView,
      });
      write(`\x1b[H${lines.map(line => `${line}\x1b[K`).join("\n")}\x1b[J`);
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
            // The one extra navigation: swap the wide panel between the
            // activity stream and the full-width task view.
            panelView = panelView === "tasks" ? "activity" : "tasks";
            return;
          }
          if (panelView === "tasks" && key?.name === "escape") {
            panelView = "activity"; // Esc closes the task view
            return;
          }
          const mapped = KEY_MAP[key?.name ?? ""];
          if (mapped === undefined) return;
          const rows = workbenchPanelRows(out.columns ?? 80, out.rows ?? 24);
          scrollFirst = advanceScroll(mapped, scrollFirst, lastEventCount, rows);
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
