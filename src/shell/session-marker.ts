/**
 * Sentinel marker helpers for persistent shell sessions.
 *
 * A per-command marker line (`__OB_DONE_<hex>__=<exit code>`) is printed after
 * each command so the host can detect completion inside the shared stdout/stderr
 * stream. These helpers are pure string functions so the scan/strip logic stays
 * unit-testable without spawning a shell.
 *
 * The scan WINDOWING lives in the caller (shell-sessions.ts): completion is
 * detected by scanning FORWARD from a per-session cursor in bounded chunks, so
 * a marker buried under later output is still found. This module deliberately
 * holds no window constant any more — the old 64 KiB tail-window constant was
 * removed when detection moved to the forward cursor.
 */
import { randomBytes } from "node:crypto";

/** Create a unique completion marker for one command. */
export function createMarker(): string {
  return `__OB_DONE_${randomBytes(5).toString("hex")}__`;
}

function markerPattern(marker: string, global: boolean): RegExp {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}=(-?\\d+)`, global ? "g" : "");
}

/**
 * Return the exit code carried by the LAST complete marker line in `text`, or
 * null when the marker has not (fully) appeared yet. Matching from the end
 * tolerates shells that echo the submitted command line (which contains the
 * bare marker text without `=<code>`) before printing the real sentinel.
 */
export function scanMarkerExitCode(text: string, marker: string): number | null {
  const re = markerPattern(marker, true);
  let code: number | null = null;
  for (const m of text.matchAll(re)) code = Number(m[1]);
  return code;
}

/** Remove the sentinel line(s) for `marker` from captured output. */
export function stripMarkerLines(text: string, marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}=-?\\d+\\r?\\n?`), "");
}
