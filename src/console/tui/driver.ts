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
import type { ReadStream } from "node:tty";
import { state } from "../../bridge/state.js";
import { buildSnapshot } from "./snapshot.js";
import { renderFrame, workbenchPanelRows, advanceScroll, type ScrollKey } from "./render.js";

export interface ConsoleTuiOptions {
  version: string;
  rootName: string;
  logPath: string;
}

const KEY_MAP: Record<string, ScrollKey> = {
  up: "up",
  down: "down",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
  escape: "end", // Esc snaps back to the newest events, like End
};

let timer: ReturnType<typeof setInterval> | undefined;
let resizeHandler: (() => void) | undefined;
let keyListener: ((ch: string, key: { name?: string; ctrl?: boolean }) => void) | undefined;
let frameIndex = 0;
let active = false;
/** Panel scroll position; larger than any event count = locked to the tail. */
let scrollFirst = Number.MAX_SAFE_INTEGER;
/** Event count of the last painted frame, so scroll steps clamp correctly. */
let lastEventCount = 0;

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
  // THIS process's start: 「运行」 must not read the persisted stats window
  // (a freshly restarted Bridge used to claim 50 hours of uptime).
  const launchedAt = Date.now();

  const write = (payload: string): void => {
    try { out.write(payload); } catch { /* a dead pipe must never crash the bridge */ }
  };
  const paint = (): void => {
    // The dashboard is an observer of the work, never part of it: any
    // rendering failure is swallowed and the next tick tries again.
    try {
      const snapshot = buildSnapshot(state, { ...options, launchedAt });
      lastEventCount = snapshot.events.length;
      const lines = renderFrame(snapshot, {
        width: out.columns ?? 80,
        height: out.rows ?? 24,
        spinnerFrame: frameIndex++,
        firstVisible: scrollFirst,
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
