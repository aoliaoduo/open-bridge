/**
 * Keep the console window's title ours.
 *
 * Windows keeps **one** title string per console and any process attached to that
 * console can overwrite it (`SetConsoleTitle`); nothing remembers the previous
 * value. Because serving children deliberately share our console — closing the
 * window must take the tunnel and the background services with it, see
 * child-console.ts — the commands we run write into our title as well:
 *
 *   - a `cmd.exe` that OWNS its console names it after its own image path
 *     (a `cmd /k` window, or a `.cmd`/`.bat` started through the shell
 *     association - e.g. the one-click launcher): the window reads
 *     `C:\Windows\system32\cmd.exe`. A `cmd /c ...` that merely shares an
 *     existing console leaves the title alone (measured);
 *   - npm sets `process.title` in its own JS (`npm/lib/cli/entry.js` sets "npm",
 *     `lib/npm.js` sets the command being run) — the "npm test"-looking title.
 *
 * Once such a child exits, the window keeps whatever it wrote. For an operator
 * looking at the launcher the window appears to rename itself at random, and the
 * name it settles on says nothing about what the window is running.
 *
 * So the title is claimed once at start and re-claimed whenever a child of ours
 * exits. Purely cosmetic, and skipped where there is no console (a service, CI, a
 * redirected stdout) because `SetConsoleTitle` means nothing there.
 */

import { processHasConsole } from "../../process/child-console.js";

export const TITLE_PREFIX = "Open Bridge";

/**
 * The launcher's title: what this window is, and which workspace it serves.
 * ASCII only on purpose — a console title is rendered in the console's codepage,
 * and a mojibake title is worse than a plain one.
 */
export function buildServeTitle(workspaceName: string, port: number): string {
  const name = workspaceName.trim() || "workspace";
  return port > 0 ? `${TITLE_PREFIX} - ${name} (:${port})` : `${TITLE_PREFIX} - ${name}`;
}

/** The title this instance wants the console to show; unset when it claims none. */
let pinnedTitle: string | undefined;

function defaultSetTitle(value: string): void {
  // On Windows, setting process.title goes through libuv to SetConsoleTitle, so
  // this is the console title and not merely the process name.
  process.title = value;
}

/**
 * Claim the console title for this instance. `hasConsole`/`set` are injectable so
 * the policy is testable without a real console.
 */
export function installServeConsoleTitle(
  title: string,
  options: { set?: (value: string) => void; hasConsole?: boolean } = {},
): boolean {
  const set = options.set ?? defaultSetTitle;
  const hasConsole = options.hasConsole ?? (process.platform === "win32" && processHasConsole());
  if (!hasConsole) {
    pinnedTitle = undefined;
    return false;
  }
  pinnedTitle = title;
  try {
    set(title);
  } catch {
    // A cosmetic write must never take the server down.
  }
  return true;
}

/**
 * Put the title back after something else overwrote it (a child's exit). A no-op
 * when this instance never claimed one.
 */
export function reassertServeConsoleTitle(set: (value: string) => void = defaultSetTitle): void {
  if (!pinnedTitle) return;
  try {
    set(pinnedTitle);
  } catch {
    // Same reasoning as above: the window title is not worth an exception.
  }
}

/** Forget the claim (instance stopping: the console is no longer ours to name). */
export function clearServeConsoleTitle(): void {
  pinnedTitle = undefined;
}
