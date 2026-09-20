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

/**
 * East-Asian AMBIGUOUS characters (middle dot, ellipsis, box drawing, blocks,
 * geometric shapes, check/cross marks) render TWO columns in CJK-context
 * terminals: the first live dashboard measured one column past the edge per
 * painted line and the terminal ate the trailing character ("● 运行" lost its
 * 中, "./open-bridge" lost its e). Under a zh/ja/ko locale they count as two.
 * The opposite error (counting wide what renders narrow) only under-fills a
 * line, which the driver's per-line erase masks — over-counting is safe,
 * under-counting smears. The flag is settable so both regimes stay testable.
 */
const AMBIGUOUS_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00b7, 0x00b7], // middle dot — the separator used everywhere
  [0x2026, 0x2026], // ellipsis
  [0x2500, 0x259f], // box drawing + block elements
  [0x25a0, 0x25ff], // geometric shapes (● ◆ ○)
  [0x26a0, 0x26a1], // ⚠
  [0x2713, 0x2718], // ✓ ✕ and neighbours
];
let ambiguousWide = /^(zh|ja|ko)/i.test(`${process.env.LANG ?? ""}${process.env.LC_ALL ?? ""}`);

/** Test seam: pin the ambiguous-width regime explicitly. */
export function setAmbiguousWideForTests(value: boolean): void {
  ambiguousWide = value;
}

function charWidth(code: number): 0 | 1 | 2 {
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0; // control characters
  for (const [lo, hi] of WIDE_RANGES) {
    if (code >= lo && code <= hi) return 2;
  }
  if (ambiguousWide) {
    for (const [lo, hi] of AMBIGUOUS_RANGES) {
      if (code >= lo && code <= hi) return 2;
    }
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
 * Fill exactly `width` columns by repeating `ch`. A 2-column rule cannot split
 * the last cell, so the remainder is padded with spaces — "─".repeat(width)
 * is only correct when every repetition renders one column, which stops being
 * true the moment a CJK-terminal regime doubles the box-drawing characters.
 */
export function fillVisualWidth(ch: string, width: number): string {
  const w = visualWidth(ch);
  if (w <= 0 || width <= 0) return "";
  const full = Math.floor(width / w);
  return ch.repeat(full) + " ".repeat(width - full * w);
}

/**
 * The character occupying visual column `column` (0-based), "" when past the
 * end or when a wide character straddles the column. String indexing cannot
 * answer this on CJK-containing lines: one code unit can be two columns wide.
 */
export function charAtColumn(text: string, column: number): string {
  let col = 0;
  for (const ch of stripAnsi(text)) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (w === 0) continue;
    if (col === column) return ch;
    col += w;
    if (col > column) return "";
  }
  return "";
}
