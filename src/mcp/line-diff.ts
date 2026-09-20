/**
 * Minimal unified-diff generation for display purposes ("what did this patch
 * change"). Not a minimal-edit diff engine: it trims the common prefix/suffix
 * and emits a single hunk, which is exact for the surgical edits AI clients
 * make and always renders correctly, just occasionally with extra context.
 * Pure module so it stays unit-testable in plain node.
 */

export interface LineDiffStats {
  additions: number;
  deletions: number;
}

export function unifiedDiff(before: string, after: string, contextLines = 3): string | undefined {
  if (before === after) return undefined;
  // A side that is the empty string has ZERO lines, not one empty line:
  // "".split("\n") yields [""], which rendered a phantom "-"/"+" body line and
  // an invented deletion/addition for every created or deleted file — the same
  // class of bug as the trailing-newline phantom below, on the empty boundary.
  const aEmpty = before === "";
  const bEmpty = after === "";
  const a = aEmpty ? [] : before.split("\n");
  const b = bEmpty ? [] : after.split("\n");
  // `split("\n")` appends an empty element for text that ends with a newline.
  // That element is not a line of the file — it is the absence of one — and
  // including it emitted a phantom `" "` body line for every newline-terminated
  // file. Each side drops its own phantom INDEPENDENTLY: popping only when
  // both sides had one left the ONE-SIDED case broken — a trailing-newline
  // change ("a\n" → "a") rendered a phantom "-" empty line and counted an
  // invented deletion, while the real change (the last line's terminator)
  // stayed invisible. The marker below names it the way git does.
  const aHadTerminator = a.length > 1 && a[a.length - 1] === "";
  const bHadTerminator = b.length > 1 && b[b.length - 1] === "";
  if (aHadTerminator) a.pop();
  if (bHadTerminator) b.pop();
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  // Terminator asymmetry is only a change when BOTH sides have a last line;
  // on create/delete the empty side has nothing whose terminator could differ.
  const bothSides = !aEmpty && !bEmpty;
  if (bothSides && aHadTerminator !== bHadTerminator) {
    // The last content line is NOT identical across sides even when its text
    // matches (its terminator differs), so it may not be trimmed into the
    // common region: back one shared pair out of it so the change renders as
    // -/+ plus the marker, not as untouched context. When both prefix and
    // suffix are zero the pair is already inside the change region.
    if (suffix > 0) suffix -= 1;
    else if (prefix > 0) prefix -= 1;
  }
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const contextStart = Math.max(0, prefix - contextLines);
  const contextEnd = Math.min(a.length, a.length - suffix + contextLines);
  const lines: string[] = [];
  for (let index = contextStart; index < prefix; index += 1) lines.push(` ${a[index]}`);
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  for (let index = a.length - suffix; index < contextEnd; index += 1) lines.push(` ${a[index]}`);
  // The marker is banner text, never counted in the header's old/new tallies.
  // With content on both sides, terminator asymmetry names the change (git's
  // rule). On create/delete only the present side speaks: the marker appears
  // exactly when ITS last line lacks a newline; the empty side never asks.
  const needsMarker = bothSides
    ? aHadTerminator !== bHadTerminator
    : aEmpty
      ? b.length > 0 && !bHadTerminator
      : a.length > 0 && !aHadTerminator;
  if (needsMarker) lines.push("\\ No newline at end of file");
  const oldCount = contextEnd - contextStart;
  const newCount = oldCount - removed.length + added.length;
  // An empty side starts at line 0, the way git writes a creation/deletion
  // hunk ("@@ -0,0 +1,N @@"); a non-empty side keeps its 1-based start.
  const oldStart = a.length === 0 ? 0 : contextStart + 1;
  const newStart = b.length === 0 ? 0 : contextStart + 1;
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  return [header, ...lines].join("\n");
}

export function countDiffLines(diff: string): LineDiffStats {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

/** Head+tail truncation that keeps both ends readable (40% head / 60% tail). */
export function boundedText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const marker = "\n...[truncated]...\n";
  const budget = Math.max(0, maxChars - marker.length);
  // A budget of zero (or one too small to hold the marker) has nothing to spend.
  // `text.slice(-0)` is `text.slice(0)` — the WHOLE string — so the tail slice
  // used to return everything: `review_changes{max_patch_bytes:0}`, documented as
  // "include no patch text", served the full diff, and git output is buffered up
  // to 50 MiB. The only size cap on that field was inverted at zero.
  if (budget <= 0) return { text: "", truncated: true };
  const head = Math.floor(budget * 0.4);
  return { text: `${text.slice(0, head)}${marker}${text.slice(-(budget - head))}`, truncated: true };
}
