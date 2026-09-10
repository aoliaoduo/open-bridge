import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matchLinesInWorker, SafeRegexError } from "../src/mcp/regex-worker.js";
import { searchFileStream, type BatchMatcher, type StreamSearchMatch } from "../src/mcp/stream-search.js";

function tmpFile(name: string, content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-search-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
}

const includesMatcher = (needle: string): BatchMatcher =>
  async (lines) => {
    const out: number[] = [];
    lines.forEach((line, i) => { if (line.includes(needle)) out.push(i); });
    return out;
  };

test("matchLinesInWorker returns matching indices", async () => {
  const indices = await matchLinesInWorker("^foo", ["bar", "foo x", "foobar", "xfoo"]);
  assert.deepEqual(indices, [1, 2]);
});

test("matchLinesInWorker rejects malformed patterns", async () => {
  await assert.rejects(matchLinesInWorker("([", ["x"]), SafeRegexError);
});

test("matchLinesInWorker stops catastrophic backtracking with a timeout", async () => {
  const evil = "a".repeat(33) + "b";
  const started = Date.now();
  await assert.rejects(
    matchLinesInWorker("(a+)+$", [evil], 300),
    /exceeded 300 ms/,
  );
  assert.ok(Date.now() - started < 3000, "worker must be terminated promptly");
});

test("stream search finds matches with line numbers, no whole-file read", async () => {
  const body = Array.from({ length: 5000 }, (_, i) => `line-${i + 1}`).join("\n") + "\nneedle here\n" + "tail\n";
  const f = tmpFile("big.txt", body);
  const matches: StreamSearchMatch[] = [];
  const count = await searchFileStream(f, includesMatcher("needle"), { limit: 10, contextLines: 0 }, m => { matches.push(m); });
  assert.equal(count, 1);
  assert.equal(matches[0].line, 5001);
  assert.equal(matches[0].text, "needle here");
});

test("stream search gathers before/after context incrementally", async () => {
  const f = tmpFile("ctx.txt", "a\nb\nMATCH\nc\nd\ne\n");
  const matches: StreamSearchMatch[] = [];
  await searchFileStream(f, includesMatcher("MATCH"), { limit: 5, contextLines: 2 }, m => { matches.push(m); });
  assert.deepEqual(matches[0].context_before, ["a", "b"]);
  assert.deepEqual(matches[0].context_after, ["c", "d"]);
});

test("context_after is truncated at EOF", async () => {
  const f = tmpFile("eof.txt", "x\nMATCH\nonly\n");
  const matches: StreamSearchMatch[] = [];
  await searchFileStream(f, includesMatcher("MATCH"), { limit: 5, contextLines: 3 }, m => { matches.push(m); });
  assert.deepEqual(matches[0].context_after, ["only"]);
});

test("limit stops collecting mid-stream and onMatch false stops early", async () => {
  // 1200 hits spread over 3+ matcher batches: an early stop must be honored
  // across batch boundaries, not only inside one 500-line batch.
  const f = tmpFile("many.txt", Array.from({ length: 1200 }, () => "hit").join("\n") + "\n");
  const matches: StreamSearchMatch[] = [];
  await searchFileStream(f, includesMatcher("hit"), { limit: 3, contextLines: 0 }, m => { matches.push(m); });
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(m => m.line), [1, 2, 3], "only the first hits are returned");

  const two: StreamSearchMatch[] = [];
  await searchFileStream(f, includesMatcher("hit"), { limit: 100, contextLines: 0 }, m => { two.push(m); return two.length < 2; });
  assert.equal(two.length, 2);
});

test("context_after is gathered across a matcher batch boundary", async () => {
  // The default batch is 500 lines: a match on the LAST line of batch 1 can
  // only fill its context_after from the following batch.
  const lines = Array.from({ length: 600 }, (_, i) => `f${i + 1}`);
  lines[499] = "MATCH"; // line 500
  const f = tmpFile("cross.txt", lines.join("\n") + "\n");
  const matches: StreamSearchMatch[] = [];
  await searchFileStream(f, includesMatcher("MATCH"), { limit: 5, contextLines: 2 }, m => { matches.push(m); });
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].context_before, ["f498", "f499"]);
  assert.deepEqual(matches[0].context_after, ["f501", "f502"]);
});

test("context_before survives a batch boundary", async () => {
  const lines = Array.from({ length: 600 }, (_, i) => `f${i + 1}`);
  lines[501] = "MATCH"; // line 502, inside batch 2
  const f = tmpFile("before.txt", lines.join("\n") + "\n");
  const matches: StreamSearchMatch[] = [];
  await searchFileStream(f, includesMatcher("MATCH"), { limit: 5, contextLines: 2 }, m => { matches.push(m); });
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0].context_before, ["f500", "f501"], "before-context from the previous batch");
});

test("binary files are skipped the way ripgrep skips them", async () => {
  // A NUL anywhere in the first 64 KiB means "not text": the old scanner fed
  // such files to readline, which buffered megabytes between two stray \n bytes.
  const f = tmpFile("blob.bin", "head\0needle\0tail");
  const matches: StreamSearchMatch[] = [];
  const count = await searchFileStream(f, includesMatcher("needle"), { limit: 5, contextLines: 0 }, m => { matches.push(m); });
  assert.equal(count, 0);
  assert.equal(matches.length, 0);
});

test("a newline-less file is capped instead of buffered whole", async () => {
  // 4 MiB on ONE line: readline materialized all of it in the scanner and
  // handed a copy to the matcher worker. The cap keeps it bounded and lets the
  // following lines keep their real numbers.
  const f = tmpFile("minified.txt", "x".repeat(4 * 1024 * 1024));
  const matches: StreamSearchMatch[] = [];
  const count = await searchFileStream(f, includesMatcher("needle"), { limit: 5, contextLines: 0 }, m => { matches.push(m); });
  assert.equal(count, 0);

  const g = tmpFile("mixed.txt", `${"y".repeat(2 * 1024 * 1024)}\nneedle here\n`);
  const after: StreamSearchMatch[] = [];
  await searchFileStream(g, includesMatcher("needle"), { limit: 5, contextLines: 0 }, m => { after.push(m); });
  assert.equal(after.length, 1);
  assert.equal(after[0].line, 2, "the over-long line still counts as exactly one line");
});

test("CRLF and missing trailing newline keep readline's line semantics", async () => {
  const crlf = tmpFile("crlf.txt", "a\r\nMATCH\r\nb\r\n");
  const matches: StreamSearchMatch[] = [];
  await searchFileStream(crlf, includesMatcher("MATCH"), { limit: 5, contextLines: 0 }, m => { matches.push(m); });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 2);
  assert.equal(matches[0].text, "MATCH", "no stray CR at the end of the line");

  const noEol = tmpFile("noeol.txt", "a\nMATCH");
  const tail: StreamSearchMatch[] = [];
  await searchFileStream(noEol, includesMatcher("MATCH"), { limit: 5, contextLines: 0 }, m => { tail.push(m); });
  assert.equal(tail.length, 1);
  assert.equal(tail[0].line, 2, "a final line without a terminator is still scanned");
});

test("worker-backed matcher composes with the stream scanner", async () => {
  const f = tmpFile("re.txt", "foo 123\nbar\nfoo 456\n");
  const matches: StreamSearchMatch[] = [];
  await searchFileStream(
    f,
    (lines) => matchLinesInWorker("^foo \\d+$", lines),
    { limit: 5, contextLines: 1 },
    m => { matches.push(m); },
  );
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0].context_after, ["bar"]);
});
