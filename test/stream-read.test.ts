import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  streamReadLines,
  truncateToUtf8Bytes,
  utf8SafePrefix,
  resolveLineRange,
  BinaryFileError,
} from "../src/mcp/stream-read.js";

function tmpFile(name: string, content: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ob-stream-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, content);
  return f;
}

test("ranged read stops early: content is exact, whole-file hash still reported", async () => {
  const body = "l1\nl2\nl3\nl4\nl5\n";
  const f = tmpFile("a.txt", body);
  const r = await streamReadLines(f, { startLine: 2, endLine: 4, maxBytes: 1 << 20 }, Buffer.byteLength(body));
  assert.equal(r.content, "l2\nl3\nl4\n");
  assert.equal(r.lines_returned, 3);
  assert.equal(r.start_line, 2);
  assert.equal(r.end_line, 4);
  // Small remainder: the stream runs on to EOF so the schema's promise holds
  // (whole-file sha256 for optimistic writes) while content stays the range.
  assert.equal(r.lines_total, 5);
  assert.equal(r.sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(r.binary, false);
});

test("full read (no range) reaches EOF: lines_total and sha256 populated", async () => {
  const body = "l1\nl2\nl3\nl4\nl5\n";
  const f = tmpFile("full.txt", body);
  const r = await streamReadLines(f, { maxBytes: 1 << 20 }, Buffer.byteLength(body));
  assert.equal(r.content, body);
  assert.equal(r.lines_total, 5);
  assert.equal(r.lines_returned, 5);
  assert.equal(r.sha256, createHash("sha256").update(body).digest("hex"));
});

test("preserves CRLF byte-for-byte on ranged reads", async () => {
  const body = "a\r\nb\r\nc\r\nd\r\n";
  const f = tmpFile("crlf.txt", body);
  const r = await streamReadLines(f, { startLine: 1, endLine: 2, maxBytes: 1 << 20 }, Buffer.byteLength(body));
  assert.equal(r.content, "a\r\nb\r\n");
  // end_line reached: content stops at line 2, but the stream continues to
  // EOF (small remainder) so the WHOLE-file sha256 is still reported for
  // optimistic writes.
  assert.equal(r.lines_total, 4);
  assert.equal(r.sha256, createHash("sha256").update(body).digest("hex"));
});

test("large file: only requested lines are materialized (early stop, O(range))", async () => {
  // ~50k lines, ~2 MB; ask only for lines 1000-1002. The remainder is small,
  // so the stream continues to EOF for the whole-file hash (collection stops
  // at line 1002 — memory stays O(range)); content is unaffected either way.
  const lines: string[] = [];
  for (let i = 1; i <= 50000; i++) lines.push(`line-number-${i}`);
  const body = lines.join("\n") + "\n";
  const f = tmpFile("big.txt", body);
  const size = Buffer.byteLength(body);
  const r = await streamReadLines(f, { startLine: 1000, endLine: 1002, maxBytes: 1 << 20 }, size);
  assert.equal(r.content, "line-number-1000\nline-number-1001\nline-number-1002\n");
  assert.equal(r.lines_returned, 3);
  assert.equal(r.lines_total, 50000); // small remainder: streamed to EOF
  assert.equal(r.sha256, createHash("sha256").update(body).digest("hex"));
});

test("deep range into a huge file keeps the early stop (no whole-file scan for the hash)", async () => {
  // 40 MiB of lines; asking for the first 3 lines leaves a remainder far
  // beyond the hash-tail budget, so the stream must destroy early.
  const line = "x".repeat(1000) + "\n";
  const body = line.repeat(40 * 1024);
  const f = tmpFile("huge.txt", body);
  const size = Buffer.byteLength(body);
  const r = await streamReadLines(f, { startLine: 1, endLine: 3, maxBytes: 1 << 20 }, size);
  assert.equal(r.lines_returned, 3);
  assert.equal(r.lines_total, null); // stopped at end_line, never saw EOF
  assert.equal(r.sha256, null);
});

test("byte budget truncation is UTF-8 safe (never splits a multibyte char)", () => {
  // Each Chinese char is 3 UTF-8 bytes; "中" x 10 = 30 bytes.
  const s = "中".repeat(10);
  const out = truncateToUtf8Bytes(s, 11);
  assert.ok(Buffer.byteLength(out, "utf8") <= 11);
  assert.equal(Buffer.byteLength(out, "utf8"), 9); // 3 whole chars, not a split char
  assert.ok(!out.includes("\uFFFD"));
  // emoji (4 bytes)
  const e = "😀".repeat(5);
  const oe = truncateToUtf8Bytes(e, 10);
  assert.equal(Buffer.byteLength(oe, "utf8"), 8); // 2 whole emoji
  assert.ok(!oe.includes("\uFFFD"));
});

test("byte budget stops collection during a ranged read", async () => {
  const body = "x".repeat(1000) + "\n" + "y".repeat(1000) + "\n" + "z".repeat(1000) + "\n";
  const f = tmpFile("bud.txt", body);
  const r = await streamReadLines(f, { maxBytes: 1500 }, Buffer.byteLength(body));
  // First line (1001 bytes) fits; adding the second (2002) overshoots -> stop.
  assert.ok(r.content.startsWith("x".repeat(1000) + "\n"));
  assert.ok(!r.content.includes("y"));
  assert.equal(r.byte_truncated, true);
});

test("binary file (NUL byte) throws BinaryFileError", async () => {
  const f = tmpFile("bin.dat", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
  await assert.rejects(streamReadLines(f, { maxBytes: 1 << 20 }, 7), BinaryFileError);
});

test("non-UTF-8 file without NUL bytes is reported binary (no silent mojibake)", async () => {
  // "l1\n\xE9\n" — the lone 0xE9 is a legacy single-byte (GBK/Latin-1 style)
  // character, not a NUL, so the old NUL-only test never caught it.
  const f = tmpFile("legacy.txt", Buffer.from([0x6c, 0x31, 0x0a, 0xe9, 0x0a]));
  await assert.rejects(streamReadLines(f, { maxBytes: 1 << 20 }, 5), BinaryFileError);
});

test("utf8SafePrefix never splits a multibyte character at the cut", () => {
  const buf = Buffer.from("a€b"); // 61 E2 82 AC 62
  assert.equal(utf8SafePrefix(buf, 3).toString("utf8"), "a");
  assert.equal(utf8SafePrefix(buf, 4).toString("utf8"), "a€");
  assert.equal(utf8SafePrefix(buf, 100).toString("utf8"), "a€b");
  assert.equal(utf8SafePrefix(Buffer.from("abc"), 2).toString("utf8"), "ab");
  assert.equal(utf8SafePrefix(Buffer.from("abc"), 0).byteLength, 0);
});

test("resolveLineRange validates input", () => {
  assert.deepEqual(resolveLineRange(2, 5), { start: 2, end: 5 });
  assert.deepEqual(resolveLineRange(3), { start: 3, end: null });
  assert.throws(() => resolveLineRange(0), /start_line/);
  assert.throws(() => resolveLineRange(5, 2), /end_line/);
});


test("a line spanning an internal read chunk is split and reassembled correctly", async () => {
  // The reader consumes the file in ~64 KiB chunks; a single line far longer
  // than that forces line assembly across chunk boundaries, including a
  // multibyte character placed right at the chunk seam. Any corruption shows
  // up as a split character or a broken line.
  const bigLine = "x".repeat(70 * 1024) + "中".repeat(200);
  const body = bigLine + "\n" + "tail line\n";
  const f = tmpFile("seam.txt", body);
  const r = await streamReadLines(f, { maxBytes: 1 << 22 }, Buffer.byteLength(body));
  assert.equal(r.lines_total, 2);
  assert.equal(r.lines_returned, 2);
  assert.equal(r.content, body);
  assert.ok(!r.content.includes("\uFFFD"), "no replacement characters from a split multibyte char");
});

test("a huge line with no newline is bounded, not buffered whole", async () => {
  // The budget and utf8SafePrefix only ran from inside handleLine, which only
  // ran once a WHOLE line had been delimited — so a line with no terminator was
  // accumulated in full before being truncated. Measured on the buggy code: a
  // 64 MiB single-line file read with max_bytes=1024 returned the right 1024
  // bytes but grew RSS by ~137 MiB and took 14.5 s. With the shipped 512 KiB
  // default, a 500 MiB minified bundle or one giant JSONL record cost 500 MiB
  // per path in `paths`.
  const MIB = 1024 * 1024;
  const total = 24 * MIB;
  const f = tmpFile("one-giant-line.txt", Buffer.alloc(total, 0x41));
  const budget = 2 * MIB;

  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const started = Date.now();
  const r = await streamReadLines(f, { maxBytes: budget }, total);
  const elapsed = Date.now() - started;
  const grew = process.memoryUsage().heapUsed - before;

  assert.equal(r.content.length, budget, "the answer is still exactly the byte budget");
  assert.equal(r.byte_truncated, true);
  assert.ok(
    grew < total / 2,
    `heap grew ${(grew / MIB).toFixed(1)} MiB for a ${total / MIB} MiB single line — it is being buffered whole`,
  );
  assert.ok(elapsed < 2_000, `reading stopped early instead of scanning the file (${elapsed} ms)`);
});

test("an over-long line is skipped by line number when the range starts later", async () => {
  // The range does not overlap the giant line, so no bytes from it may be
  // returned — and it must not be decoded to find that out.
  const MIB = 1024 * 1024;
  const giant = Buffer.alloc(8 * MIB, 0x41);
  const body = Buffer.concat([giant, Buffer.from("\nsecond line\nthird line\n", "utf8")]);
  const f = tmpFile("giant-then-lines.txt", body);

  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  const r = await streamReadLines(f, { startLine: 3, endLine: 3, maxBytes: 1 << 20 }, body.length);
  const grew = process.memoryUsage().heapUsed - before;

  assert.equal(r.content, "third line\n", "only the requested line comes back");
  assert.ok(grew < body.length / 2, `the skipped line was not buffered (${(grew / MIB).toFixed(1)} MiB)`);
});

test("a file without a trailing newline is read whole with correct totals", async () => {
  const body = "l1\nl2\nl3"; // unterminated final line
  const f = tmpFile("nonl.txt", body);
  const r = await streamReadLines(f, { maxBytes: 1 << 20 }, body.length);
  assert.equal(r.reached_eof, true);
  assert.equal(r.content, body);
  assert.equal(r.lines_total, 3);
  assert.equal(r.end_line, 3);
  assert.equal(r.sha256, createHash("sha256").update(body).digest("hex"));
  assert.equal(r.binary, false);
});

test("end_line + no trailing newline: the unterminated last line is still counted", async () => {
  // stoppedByEndLine keeps the stream running to EOF for the whole-file hash,
  // but finalize used to skip the pending unterminated tail (guarded by
  // `!stoppedEarly`), so lineNo never counted the final line and lines_total
  // came back one short.
  const body = "l1\nl2\nl3\nl4\nl5"; // 5 lines, no trailing newline
  const f = tmpFile("nonl-range.txt", body);
  const r = await streamReadLines(f, { startLine: 1, endLine: 2, maxBytes: 1 << 20 }, Buffer.byteLength(body));
  assert.equal(r.content, "l1\nl2\n");
  assert.equal(r.lines_total, 5, "EOF was reached, so the count must include the unterminated last line");
  assert.equal(r.sha256, createHash("sha256").update(body).digest("hex"));
});

test("empty file (0 bytes) returns empty content and zero counts with sha256", async () => {
  const f = tmpFile("empty.txt", "");
  const r = await streamReadLines(f, { maxBytes: 1 << 20 }, 0);
  assert.equal(r.content, "");
  assert.equal(r.lines_total, 0);
  assert.equal(r.lines_returned, 0);
  assert.equal(r.start_line, 1);
  assert.equal(r.sha256, createHash("sha256").update("").digest("hex"));
  assert.equal(r.reached_eof, true);
  assert.equal(r.binary, false);
});

test("startLine past EOF returns empty content but still reports lines_total and hash", async () => {
  const body = "line 1\nline 2\n";
  const f = tmpFile("past-eof.txt", body);
  const r = await streamReadLines(f, { startLine: 10, maxBytes: 1 << 20 }, Buffer.byteLength(body));
  assert.equal(r.content, "");
  assert.equal(r.lines_returned, 0);
  assert.equal(r.lines_total, 2);
  assert.equal(r.reached_eof, true);
  assert.equal(r.sha256, createHash("sha256").update(body).digest("hex"));
});

test("file with consecutive blank lines preserves line counts", async () => {
  const body = "\n\n\n";
  const f = tmpFile("blank-lines.txt", body);
  const r = await streamReadLines(f, { maxBytes: 1 << 20 }, Buffer.byteLength(body));
  assert.equal(r.content, "\n\n\n");
  assert.equal(r.lines_total, 3);
  assert.equal(r.lines_returned, 3);
  assert.equal(r.reached_eof, true);
});
