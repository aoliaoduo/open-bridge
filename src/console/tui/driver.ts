/**
 * Stage-1 serve-console TUI driver: alternate screen, 500 ms repaint, no raw
 * mode.
 *
 * Deliberately raw-mode-free: Ctrl+C keeps its normal SIGINT meaning (the
 * existing graceful shutdown runs, which calls stopConsoleTui and restores the
 * original screen — startup banner included), and no key handling exists to
 * break. Writes are one buffered string per frame; a child that prints to the
 * shared console (rare — managed commands are piped) merely smears one frame,
 * and the next tick repaints it away.
 *
 * Without a real console (service, CI, redirect, --no-tui) startConsoleTui()
 * answers false and the plain output path is untouched.
 */

import { state } from "../../bridge/state.js";
import { buildSnapshot } from "./snapshot.js";
import { renderFrame } from "./render.js";

export interface ConsoleTuiOptions {
  version: string;
  rootName: string;
  logPath: string;
}

let timer: ReturnType<typeof setInterval> | undefined;
let resizeHandler: (() => void) | undefined;
let frameIndex = 0;
let active = false;

export function consoleTuiActive(): boolean {
  return active;
}

export function startConsoleTui(options: ConsoleTuiOptions): boolean {
  const out = process.stdout;
  if (!out.isTTY) return false;
  if (active) return true;
  active = true;

  const write = (payload: string): void => {
    try { out.write(payload); } catch { /* a dead pipe must never crash the bridge */ }
  };
  const paint = (): void => {
    // The dashboard is an observer of the work, never part of it: any
    // rendering failure is swallowed and the next tick tries again.
    try {
      const snapshot = buildSnapshot(state, options);
      const lines = renderFrame(snapshot, {
        width: out.columns ?? 80,
        height: out.rows ?? 24,
        spinnerFrame: frameIndex++,
      });
      write(`\x1b[H${lines.map(line => `${line}\x1b[K`).join("\n")}\x1b[J`);
    } catch { /* see above */ }
  };

  write("\x1b[?1049h\x1b[?25l"); // alternate screen + hidden cursor
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
  try { process.stdout.write("\x1b[?25h\x1b[?1049l"); } catch { /* best effort */ }
}

// Last-resort restore: exits that bypass the graceful path (a hard deadline)
// would otherwise leave a hidden cursor behind — the kind of dirt operators
// remember. Synchronous write on "exit" is allowed and tiny.
process.on("exit", () => {
  if (active) {
    try { process.stdout.write("\x1b[?25h\x1b[?1049l"); } catch { /* best effort */ }
  }
});
