import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewFiles,
  parseNameStatus,
  parseNumstat,
  summarizeFiles,
} from "../src/mcp/review-parse.js";

// Real `git diff --numstat -z` output for one commit touching: added.txt (add
// 1/0), bin2.dat (binary add), del.txt (delete 0/1) and base.txt -> renamed.txt
// (rename with one added line). Captured from a scratch repository on Windows.
// bytes: "1\t0\tadded.txt" "-\t-\tbin2.dat" "0\t1\tdel.txt" "1\t0\t" "base.txt" "renamed.txt" — each record NUL-terminated.
const REAL_NUMSTAT = "1\x090\x09added.txt\x00-\x09-\x09bin2.dat\x000\x091\x09del.txt\x001\x090\x09\x00base.txt\x00renamed.txt\x00";
const REAL_NAME_STATUS = "A\x00added.txt\x00A\x00bin2.dat\x00D\x00del.txt\x00R060\x00base.txt\x00renamed.txt\x00";

test("parseNumstat reads plain change entries", () => {
  const files = parseNumstat("3\t1\tsrc/a.ts\0");
  assert.deepEqual(files, [{ path: "src/a.ts", additions: 3, deletions: 1 }]);
});

test("parseNumstat reads real rename entries (empty path slot then two path fields)", () => {
  const files = parseNumstat(REAL_NUMSTAT);
  assert.deepEqual(files, [
    { path: "added.txt", additions: 1, deletions: 0 },
    { path: "bin2.dat", additions: 0, deletions: 0 },
    { path: "del.txt", additions: 0, deletions: 1 },
    { path: "renamed.txt", previousPath: "base.txt", additions: 1, deletions: 0 },
  ]);
});

test("parseNumstat reads a pure rename (0/0 counts, empty path slot)", () => {
  const files = parseNumstat("0\t0\t\0old.ts\0new.ts\0");
  assert.deepEqual(files, [{ path: "new.ts", previousPath: "old.ts", additions: 0, deletions: 0 }]);
});

test("parseNumstat maps binary dashes to zero counts", () => {
  const files = parseNumstat("-\t-\timg.png\0");
  assert.deepEqual(files, [{ path: "img.png", additions: 0, deletions: 0 }]);
});

test("parseNameStatus reads A/M/D and rename (two path fields) records", () => {
  const entries = parseNameStatus(REAL_NAME_STATUS);
  assert.deepEqual(entries, [
    { status: "A", path: "added.txt" },
    { status: "A", path: "bin2.dat" },
    { status: "D", path: "del.txt" },
    { status: "R", path: "renamed.txt", previousPath: "base.txt" },
  ]);
});

test("buildReviewFiles classifies by git status, not by line counts", () => {
  // "modify that only adds lines" must be a change, not "new";
  // pure renames stay rename-pure.
  const files = buildReviewFiles(
    [
      { path: "base.txt", additions: 1, deletions: 0 },
      { path: "new.ts", previousPath: "old.ts", additions: 0, deletions: 0 },
    ],
    [
      { status: "M", path: "base.txt" },
      { status: "R", path: "new.ts", previousPath: "old.ts" },
    ],
  );
  assert.deepEqual(files, [
    { path: "base.txt", type: "change", additions: 1, deletions: 0 },
    { path: "new.ts", previousPath: "old.ts", type: "rename-pure", additions: 0, deletions: 0 },
  ]);
});

test("buildReviewFiles merges the real captured numstat + name-status output", () => {
  const files = buildReviewFiles(parseNumstat(REAL_NUMSTAT), parseNameStatus(REAL_NAME_STATUS));
  assert.deepEqual(files, [
    { path: "added.txt", type: "new", additions: 1, deletions: 0 },
    { path: "bin2.dat", type: "new", additions: 0, deletions: 0 },
    { path: "del.txt", type: "deleted", additions: 0, deletions: 1 },
    { path: "renamed.txt", previousPath: "base.txt", type: "rename-changed", additions: 1, deletions: 0 },
  ]);
});

test("without name-status data the parser falls back to change", () => {
  const files = buildReviewFiles([{ path: "x.ts", additions: 10, deletions: 0 }], []);
  assert.deepEqual(files, [{ path: "x.ts", type: "change", additions: 10, deletions: 0 }]);
});

test("summarizeFiles totals files/additions/deletions", () => {
  const summary = summarizeFiles([
    { path: "a", type: "change", additions: 2, deletions: 1 },
    { path: "b", type: "new", additions: 5, deletions: 0 },
  ]);
  assert.deepEqual(summary, { files: 2, additions: 7, deletions: 1 });
});



test("unknown name-status letters do not misalign the following records", () => {
  // A typechange "T" record must consume its own path token: the old parser
  // skipped the letter without advancing, and when that record''s path itself
  // began with a status letter ("Added.txt") the path was re-parsed as a
  // status and the NEXT record''s path was stolen. Neutral-looking paths
  // ("swapped") self-heal, so the input below is the discriminating case.
  const entries = parseNameStatus("T\u0000Added.txt\u0000M\u0000mod.txt\u0000");
  assert.deepEqual(entries, [
    { status: "M", path: "mod.txt" },
  ]);
});


test("parseNameStatus handles M (one path) and C copy (two path) records", () => {
  const entries = parseNameStatus("M\u0000mod.txt\u0000C060\u0000orig.txt\u0000copy.txt\u0000");
  assert.deepEqual(entries, [
    { status: "M", path: "mod.txt" },
    { status: "C", path: "copy.txt", previousPath: "orig.txt" },
  ]);
});
