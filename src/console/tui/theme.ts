/**
 * Colour theme for the serve-console TUI.
 *
 * Ported from ainovel-cli's internal/entry/tui/theme.go (dark variants): the
 * warm "bookish" palette, the status/icon vocabulary, and — most importantly —
 * the health gradient thresholds. Same roles, same numbers, so the two tools
 * read the same way to the same operator:
 *
 *      < 70 %  green  — healthy headroom
 *     70–84 %  amber  — approaching the ceiling
 *    ≥ 85 %   red    — at or past the limit
 *
 * Truecolor SGR is emitted unconditionally: every mainstream terminal accepts
 * it, and a terminal that does not simply shows the uncoloured text — colour
 * is never the only carrier of information (icons and words carry it too).
 */

export const PALETTE = {
  text: "#e8e0d0",
  dim: "#8a8175",
  muted: "#b8b09c",
  accent: "#e5b449",
  accent2: "#5fb8a3",
  running: "#b5d075",
  success: "#7ec488",
  error: "#e07060",
  review: "#e09b5a",
  context: "#a890d8",
  tool: "#7ec5d8",
} as const;

export type ColorName = keyof typeof PALETTE;

const TRUECOLOR = /^#([0-9a-f]{6})$/i;

const sgrCache = new Map<ColorName, string>();

function sgr(name: ColorName): string {
  const cached = sgrCache.get(name);
  if (cached !== undefined) return cached;
  const hex = PALETTE[name].match(TRUECOLOR)?.[1] ?? "e8e0d0";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const code = `\x1b[38;2;${r};${g};${b}m`;
  sgrCache.set(name, code);
  return code;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/** Paint `text` in one theme colour; optionally bold. */
export function paint(name: ColorName, text: string, options: { bold?: boolean } = {}): string {
  if (text === "") return "";
  return `${options.bold === true ? BOLD : ""}${sgr(name)}${text}${RESET}`;
}

/**
 * The health gradient ainovel-cli applies to context usage, ported unchanged
 * (thresholds AND meaning): the percent is a fill ratio against a hard cap.
 */
export function healthColor(percent: number): ColorName {
  if (percent >= 85) return "error";
  if (percent >= 70) return "review";
  return "success";
}

/** Spinner frames — the same braille cycle bubbles.Spinner.Dot draws. */
export const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;

export function spinnerFrame(index: number): string {
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]!;
}
