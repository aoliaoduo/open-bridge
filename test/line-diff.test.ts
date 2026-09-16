/**
 * `line-diff.ts`: the display diff every edit's result carries, and the
 * head+tail truncation used for it.
 *
 * Two defects lived here, neither covered by any test:
 *
 *  - `boundedText(text, 0)` returned the WHOLE text. `text.slice(-0)` is
 *    `text.slice(0)`, so the "tail" half of the head+tail truncation was the
 *    entire string. `review_changes{max_patch_bytes:0}` is documented as
 *    "include no patch text", and the only size cap on that field was inverted
 *    at exactly that value.
 *  - `unifiedDiff` treated the empty element that `split("\n")` appends for a
 *    newline-terminated string as a real line, so the ordinary case emitted a
 *    phantom `" "` context line and counts that did not match the body.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { boundedText, countDiffLines, unifiedDiff } from "../src/mcp/line-diff.js";

test("a zero budget returns nothing, not everything", () => {
  const long = "x".repeat(1_000);
  const zero = boundedText(long, 0);
  assert.equal(zero.text, "", "an explicit 'no text' request gets no text");
  assert.equal(zero.truncated, true);

  // Any budget too small to hold the marker behaves the same way rather than
  // falling through to the whole-string slice.
  for (const budget of [1, 5, 18]) {
    const tiny = boundedText(long, budget);
    assert.equal(tiny.text, "", `budget ${budget} leaves nothing`);
    assert.equal(tiny.truncated, true);
  }

  // Nothing to truncate still passes through unchanged.
  assert.deepEqual(boundedText("short", 100), { text: "short", truncated: false });
});

test("a real budget still keeps both ends and reports truncation", () => {
  const long = "HEAD" + "x".repeat(1_000) + "TAIL";
  const bounded = boundedText(long, 200);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.length <= 200, `bounded to the budget: ${bounded.text.length}`);
  assert.ok(bounded.text.startsWith("HEAD"), "the head survives");
  assert.ok(bounded.text.endsWith("TAIL"), "and so does the tail");
  assert.match(bounded.text, /\[truncated\]/);
});

test("removing the trailing newline renders the change, not a phantom empty line", () => {
  // One-sided termination: before ends with "\n", after does not. The file
  // never contained an empty last line — but split("\n") leaves a phantom ""
  // element on the terminated side only, which used to surface as a bare "-"
  // line and an invented deletion.
  const diff = unifiedDiff("a\n", "a");
  assert.ok(diff !== undefined);
  const body = diff.split("\n").slice(1);
  assert.equal(body.some(line => line === "-"), false, "no phantom empty removal");
  assert.equal(body.some(line => line === "+"), false, "no phantom empty addition");
  assert.ok(body.includes("-a") && body.includes("+a"), "the last line is shown as replaced");
  assert.match(diff, /^\\ No newline at end of file$/m, "the newline loss is named, like git names it");
  assert.deepEqual(countDiffLines(diff), { additions: 1, deletions: 1 }, "statistics describe the real replacement, not an invented deletion");
});

test("adding the trailing newline renders the change, not a phantom empty line", () => {
  const diff = unifiedDiff("a", "a\n");
  assert.ok(diff !== undefined);
  const body = diff.split("\n").slice(1);
  assert.equal(body.some(line => line === "-"), false);
  assert.equal(body.some(line => line === "+"), false);
  assert.match(diff, /^\\ No newline at end of file$/m);
  assert.deepEqual(countDiffLines(diff), { additions: 1, deletions: 1 });
});

test("a content edit in a newline-less file keeps both-side diffs marker-free", () => {
  const diff = unifiedDiff("a\nb\nc\n", "a\nc\n");
  assert.ok(diff !== undefined);
  assert.ok(!diff.includes("\\ No newline"), "no marker when termination never changed");
});

test("a newline-terminated file gets no phantom context line", () => {
  // The reported shape: one line removed from a file that ends with a newline.
  const diff = unifiedDiff("a\nb\nc\n", "a\nc\n");
  assert.ok(diff, "the change produces a diff");
  const lines = diff.split("\n");
  const body = lines.slice(1);
  assert.deepEqual(body, [" a", "-b", " c"], `body lines: ${JSON.stringify(body)}`);
  assert.equal(
    body.some(line => line === " "),
    false,
    "no empty-content context line is invented",
  );

  // And the header counts the lines actually present. Groups are
  // (oldStart, oldCount, newStart, newCount).
  const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[0]);
  assert.ok(header, `header shape: ${String(lines[0])}`);
  assert.equal(Number(header[2]), 3, "3 old lines in the hunk");
  assert.equal(Number(header[4]), 2, "2 new lines in the hunk");
});

test("an appended line is reported as an addition only", () => {
  // The case where only one side ends with a newline: the trailing empty element
  // used to be counted as a REMOVED line, so a pure append showed a deletion.
  const diff = unifiedDiff("a\n", "a\nb\n");
  assert.ok(diff);
  const body = diff.split("\n").slice(1);
  assert.deepEqual(body, [" a", "+b"], `body lines: ${JSON.stringify(body)}`);
  assert.deepEqual(countDiffLines(diff), { additions: 1, deletions: 0 });
});

test("a removed line is reported as a deletion only", () => {
  const diff = unifiedDiff("a\nb\n", "a\n");
  assert.ok(diff);
  const body = diff.split("\n").slice(1);
  assert.deepEqual(body, [" a", "-b"], `body lines: ${JSON.stringify(body)}`);
  assert.deepEqual(countDiffLines(diff), { additions: 0, deletions: 1 });
});

test("an unchanged pair has no diff at all", () => {
  assert.equal(unifiedDiff("same\n", "same\n"), undefined);
  assert.equal(unifiedDiff("", ""), undefined);
});

test("a diff of a file with no trailing newline keeps every real line", () => {
  const diff = unifiedDiff("a\nb", "a\nc");
  assert.ok(diff);
  assert.deepEqual(diff.split("\n").slice(1), [" a", "-b", "+c"]);
  assert.deepEqual(countDiffLines(diff), { additions: 1, deletions: 1 });
});
