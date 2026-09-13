/**
 * Minimal unified-diff generation for display purposes ("what did this patch
 * change"). Not a minimal-edit diff engine: it trims the common prefix/suffix
 * and emits a single hunk, which is exact for the surgical edits AI clients
 * make and always renders correctly, just occasionally with extra context.
 * Pure module so it stays unit-testable without vscode.
 */

export interface LineDiffStats {
  additions: number;
  deletions: number;
}

export function unifiedDiff(before: string, after: string, contextLines = 3): string | undefined {
  if (before === after) return undefined;
  const a = before.split("\n");
  const b = after.split("\n");
  // `split("\n")` appends an empty element for text that ends with a newline.
  // That element is not a line of the file — it is the absence of one — and
  // including it as a context line emitted a phantom `" "` body line for every
  // newline-terminated file (the normal case). Dropping it changes nothing when
  // both sides have one, and fixes the count when only one side does.
  if (a.length > 1 && a[a.length - 1] === "" && b.length > 1 && b[b.length - 1] === "") {
    a.pop();
    b.pop();
  }
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
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const contextStart = Math.max(0, prefix - contextLines);
  const contextEnd = Math.min(a.length, a.length - suffix + contextLines);
  const lines: string[] = [];
  for (let index = contextStart; index < prefix; index += 1) lines.push(` ${a[index]}`);
  for (const line of removed) lines.push(`-${line}`);
  for (const line of added) lines.push(`+${line}`);
  for (let index = a.length - suffix; index < contextEnd; index += 1) lines.push(` ${a[index]}`);
  const oldCount = contextEnd - contextStart;
  const newCount = oldCount - removed.length + added.length;
  const header = `@@ -${contextStart + 1},${oldCount} +${contextStart + 1},${newCount} @@`;
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
