/**
 * Actionable error-message helpers.
 *
 * Not-found errors ("Unknown command id", "Unknown service", …) should tell the
 * caller what DOES exist, so an AI client can self-correct and retry instead of
 * guessing. Pure string helpers, no bridge state access.
 */

/** Format an "available values" suffix listing current valid choices. */
export function availableHint(label: string, values: Iterable<string>, max = 12): string {
  const list = [...values];
  if (list.length === 0) return ` ${label}: none.`;
  const shown = list.slice(0, max);
  const more = list.length > shown.length ? `, … (+${list.length - shown.length} more)` : "";
  return ` ${label}: ${shown.join(", ")}${more}.`;
}

/**
 * Damerau-Levenshtein distance (optimal string alignment) between two strings,
 * capped at `cap + 1` so far-away names are rejected cheaply.
 */
function editDistance(a: string, b: string, cap = 2): number {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > cap) return cap + 1;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2 = Array.from({ length: m + 1 }, (_, j) => j);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0);
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

/**
 * Suggest up to `max` candidate names similar to `input` (exact > prefix >
 * substring > close edit distance), for typo recovery in "unknown name"
 * errors. The edit-distance tier only fires when the name tiers miss, so
 * misspelled names still get a suggestion instead of a generic error.
 */
export function suggestNames(input: string, candidates: Iterable<string>, max = 3): string[] {
  const lower = input.toLowerCase();
  if (!lower) return [];
  return [...candidates]
    .map(candidate => {
      const cl = candidate.toLowerCase();
      let score = 0;
      if (cl === lower) score = 100;
      else if (cl.startsWith(lower) || lower.startsWith(cl)) score = 60;
      else if (cl.includes(lower) || lower.includes(cl)) score = 30;
      else if (editDistance(cl, lower) <= 2) score = 15;
      return { candidate, score };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, max)
    .map(entry => entry.candidate);
}

/** Format a "Did you mean" suffix from suggestNames, or empty string. */
export function suggestionHint(input: string, candidates: Iterable<string>, max = 3): string {
  const suggestions = suggestNames(input, candidates, max);
  return suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
}

/**
 * Wrap raw node fs errors (ENOENT/ENOTDIR/EISDIR) with actionable guidance so AI
 * clients can self-correct instead of retry-blind. The original message prefix is kept.
 */
export function enrichFsError(error: unknown): unknown {
  if (!(error instanceof Error) || !error.message) return error;
  const msg = error.message;
  if (msg.startsWith("ENOENT:")) return new Error(`${msg} (path does not exist; verify with list_directory or find_files before retrying)`);
  if (msg.startsWith("ENOTDIR:")) return new Error(`${msg} (a path component is a file, not a directory; search_files on a single file: pass the file path directly or use include)`);
  if (msg.startsWith("EISDIR:")) return new Error(`${msg} (path is a directory; this tool expects a file)`);
  return error;
}
