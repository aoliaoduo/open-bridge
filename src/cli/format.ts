/**
 * Terminal column arithmetic, shared by every command that prints a table.
 *
 * Extracted from cli.ts so the command modules can align output without
 * importing each other. Pure string maths: no host, no config, no I/O.
 */

// --- console label alignment -------------------------------------------------
//
// Every padded label in this file goes through padLabel, never padEnd: CJK
// and fullwidth characters occupy two terminal columns but count as one in
// string length, so padding mixed labels by length drifts the value column.
// Only the ranges this CLI actually prints count as wide (CJK, kana and
// fullwidth forms); box-drawing, arrows and emoji in decorative positions are
// intentionally left at one column each.

const WIDE_CHAR = /[\u2E80-\u9FFF\uFF01-\uFF5E]/;

/**
 * Terminal columns a string occupies: CJK/fullwidth characters count as two.
 *
 * A second CJK width gauge lives in src/console/tui/text.ts (visualWidth).
 * The two diverge on purpose: this one exists to align CLI table LABELS, so
 * only the ranges this CLI actually prints count as wide and decorative
 * box-drawing/emoji stay one column; the TUI gauge must place text next to
 * its own frames and a spinner, so it knows wide emoji, locale-dependent
 * ambiguous punctuation and astral CJK. Do not merge them — each is correct
 * for the surface it measures.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += WIDE_CHAR.test(char) ? 2 : 1;
  }
  return width;
}

/**
 * Pad a label with spaces so mixed-script labels share one value column.
 * Never truncates: a label already wider than `width` is returned as-is.
 */
export function padLabel(label: string, width: number): string {
  return label + " ".repeat(Math.max(0, width - displayWidth(label)));
}

