/**
 * Closest-match diagnostics for edit_block zero-match failures (Desktop
 * Commander-inspired, diagnostics-only): when old_text is not found, locate
 * the most similar line window in the file and explain the likely drift, so
 * the client can self-correct instead of blind-retrying. Pure module.
 *
 * Semantics stay strict: this never substitutes content — it only enriches
 * the error message.
 */

export interface FuzzyMatchResult {
  /** The closest window found in the file (LF-normalized lines joined by \n). */
  found: string;
  /** 0..1 similarity ratio between needle and found window. */
  similarity: number;
  /** 1-based first/last line of the window in the file. */
  startLine: number;
  endLine: number;
  /** Likely-drift explanations, most probable first. */
  hints: string[];
}

const LEVENSHTEIN_MAX_LENGTH = 4_096; // per-string cap; longer comparisons are skipped
const MAX_TOTAL_WINDOWS = 60_000;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;

/** Bounded Levenshtein distance with an early bailout row minimum. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > LEVENSHTEIN_MAX_LENGTH || b.length > LEVENSHTEIN_MAX_LENGTH) return Number.POSITIVE_INFINITY;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > LEVENSHTEIN_MAX_LENGTH) return Number.POSITIVE_INFINITY; // beyond any useful similarity
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[b.length];
}

function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const distance = levenshtein(a, b);
  if (!Number.isFinite(distance)) return 0;
  return 1 - distance / maxLen;
}

const stripTrailingWs = (line: string): string => line.replace(/[ \t]+$/, "");

function detectHints(needle: string, found: string): string[] {
  const hints: string[] = [];
  const spacing = (text: string): string => text.split("\n").map(l => l.trim()).join("\n");
  const invisible = (text: string): string => text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  if (spacing(needle) === spacing(found)) hints.push("whitespace differences (indentation or trailing spaces)");
  if (invisible(needle) === invisible(found)) hints.push("invisible characters (zero-width or BOM)");
  if (needle.toLowerCase() === found.toLowerCase()) hints.push("case differences only");
  if (!hints.length) hints.push("content drifted since it was last read — re-read with read_files and copy old_text exactly");
  return hints;
}

/**
 * Find the most similar line window to `needle` within `content`.
 * Returns undefined when the content is too large to scan or nothing reaches
 * a minimal similarity bar (in which case the plain error is fine).
 */
export function findFuzzyMatch(
  content: string,
  needle: string,
  options: { minSimilarity?: number; maxContentBytes?: number } = {},
): FuzzyMatchResult | undefined {
  const minSimilarity = options.minSimilarity ?? 0.5;
  const maxContentBytes = options.maxContentBytes ?? MAX_CONTENT_BYTES;
  if (!needle.trim() || Buffer.byteLength(content, "utf8") > maxContentBytes) return undefined;

  const contentLines = content.split("\n");
  const needleLines = needle.split("\n");
  const windowSize = needleLines.length;
  const needleText = needleLines.join("\n");
  const lenBudget = Math.ceil(needleText.length / Math.max(1, minSimilarity));

  let best: FuzzyMatchResult | undefined;
  let bestScore = minSimilarity;
  let windows = 0;
  // A needle longer than the file must still get one window (the whole
  // content) so the closest-match diagnostic fires instead of nothing; the old
  // loop condition made that case dead and dropped diagnostics entirely.
  const maxStart = Math.max(0, contentLines.length - windowSize);
  for (let start = 0; start <= maxStart; start += 1) {
    if (windows >= MAX_TOTAL_WINDOWS) break;
    windows += 1;
    const windowLines = contentLines.slice(start, start + windowSize);
    const windowText = windowLines.join("\n");
    // Cheap length pre-filter: below-threshold similarity needs proportional lengths.
    if (Math.abs(windowText.length - needleText.length) > lenBudget) continue;
    const score = similarityRatio(needleText, windowText);
    if (score > bestScore) {
      bestScore = score;
      // The final "" element produced by a trailing newline is not a real line:
      // exclude it from the reported endLine.
      const realWindowLines = windowLines[windowLines.length - 1] === "" ? windowLines.length - 1 : windowLines.length;
      best = {
        found: windowText,
        similarity: score,
        startLine: start + 1,
        endLine: start + Math.max(realWindowLines, 1),
        hints: [],
      };
      if (score === 1) break;
    }
  }
  if (best) best.hints = detectHints(needleText, best.found);
  return best;
}

/** Format a diagnostic block for an edit_block zero-match error message. */
export function formatFuzzyDiagnostics(match: FuzzyMatchResult, label: string): string {
  const preview = match.found.split("\n").slice(0, 3).map(l => `  | ${stripTrailingWs(l)}`).join("\n");
  const more = match.found.split("\n").length > 3 ? `\n  | … (+${match.found.split("\n").length - 3} lines)` : "";
  return (
    `Closest match in ${label}: lines ${match.startLine}-${match.endLine} (${Math.round(match.similarity * 100)}% similar):\n` +
    `${preview}${more}\n` +
    `Likely cause: ${match.hints.join("; ")}.`
  );
}
