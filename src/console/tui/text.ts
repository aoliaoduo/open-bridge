/**
 * Visual-width text utilities for the serve-console TUI.
 *
 * The renderer must place CJK-heavy strings ("会话 12/64 · 活跃 2") next to box
 * drawing into an exact number of terminal columns. String.length cannot do
 * that: it counts UTF-16 units, so one Chinese character counts as 1 (renders
 * as 2 columns). Every width decision in the TUI goes through the functions
 * here — the same discipline ainovel-cli's TUI enforces with lipgloss.Width
 * (中文算 2 列), ported without the dependency.
 *
 * ANSI escape sequences (the colour codes the theme emits) are invisible and
 * are stripped before measuring; padding is appended after, so a painted line
 * keeps its colour but still fills the row exactly.
 */

// Built through the constructor because the escape byte itself comes from
// fromCharCode: a literal \x1b inside a regex is exactly what eslint's
// no-control-regex exists to catch, and a rule waiver would outlive this file.
const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

/** Remove SGR/cursor escape sequences so only printable cells remain. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * East-Asian wide ranges: every code point inside renders two columns in a
 * mainstream terminal. Braille (the spinner) is deliberately absent — the
 * common terminals render it single-width, matching ainovel-cli's spinner.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, symbols and punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, CJK compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi syllables
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji presented wide by mainstream terminals
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], // CJK Extension B and beyond
  [0x30000, 0x3fffd],
];

function charWidth(code: number): 0 | 1 | 2 {
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0; // control characters
  for (const [lo, hi] of WIDE_RANGES) {
    if (code >= lo && code <= hi) return 2;
  }
  return 1;
}

/** Printable columns `text` occupies on screen (ANSI stripped, CJK = 2). */
export function visualWidth(text: string): number {
  let total = 0;
  for (const ch of stripAnsi(text)) {
    total += charWidth(ch.codePointAt(0) ?? 0);
  }
  return total;
}

function hardCut(text: string, max: number): string {
  let result = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > max) break;
    result += ch;
    used += w;
  }
  return result;
}

/**
 * Truncate to `max` visual columns with a "..." suffix (the same contract as
 * ainovel-cli's truncate: never split a wide character, never exceed max).
 * Input must be plain text — paint AFTER truncating, not before, because the
 * cut here does not know how to carry escape sequences across the seam.
 */
export function truncateVisual(text: string, max: number): string {
  if (max <= 0) return "";
  if (visualWidth(text) <= max) return text;
  if (max < 4) return hardCut(text, max);
  return `${hardCut(text, max - 3)}...`;
}

/** Pad with trailing spaces to exactly `width` columns (no-op when over). */
export function padEndVisual(text: string, width: number): string {
  const missing = width - visualWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** Pad with leading spaces (right alignment), same rules as padEndVisual. */
export function padStartVisual(text: string, width: number): string {
  const missing = width - visualWidth(text);
  return missing > 0 ? " ".repeat(missing) + text : text;
}

/**
 * The character occupying visual column `column` (0-based), "" when past the
 * end or when a wide character straddles the column. String indexing cannot
 * answer this on CJK-containing lines: one code unit can be two columns wide.
 */
export function charAtColumn(text: string, column: number): string {
  let col = 0;
  for (const ch of stripAnsi(text)) {
    const code = ch.codePointAt(0) ?? 0;
    const w = (code >= 0x1100 && (
      code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
      || (code >= 0xff00 && code <= 0xff60) || (code >= 0x1f300 && code <= 0x1f64f)
      || (code >= 0x20000 && code <= 0x3fffd)
    )) ? 2 : (code < 32 ? 0 : 1);
    if (col === column && w > 0) return ch;
    if (w > 0) col += w;
    if (col > column) return "";
  }
  return "";
}
