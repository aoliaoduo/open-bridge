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
