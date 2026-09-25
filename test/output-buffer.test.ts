import assert from "node:assert/strict";
import test from "node:test";
import { ProcessOutputBuffer } from "../src/process/output-buffer.js";

test("retains only the configured trailing byte window", () => {
  const output = new ProcessOutputBuffer(6);

  output.append(Buffer.from("abc"));
  const state = output.append(Buffer.from("defghij"));

  assert.deepEqual(state, {
    capacityBytes: 6,
    totalBytes: 10,
    bufferStartOffset: 4,
    availableBytes: 6,
    droppedBytes: 4,
  });
  assert.throws(() => output.read(0, 1), /no longer available; the buffer starts at 4/);

  const retained = output.read(4, 20);
  assert.equal(retained.data.toString("utf8"), "efghij");
  assert.equal(retained.offset, 4);
  assert.equal(retained.endOffset, 10);
  assert.equal(retained.truncated, true);
});

test("tail reports truncation caused by its limit and by dropped output", () => {
  const output = new ProcessOutputBuffer(6);
  output.append(Buffer.from("abcdefghij"));

  const shortTail = output.tail(3);
  assert.equal(shortTail.data.toString("utf8"), "hij");
  assert.equal(shortTail.offset, 7);
  assert.equal(shortTail.endOffset, 10);
  assert.equal(shortTail.truncated, true);
  assert.equal(shortTail.droppedBytes, 4);

  const completeWindow = output.tail(20);
  assert.equal(completeWindow.data.toString("utf8"), "efghij");
  assert.equal(completeWindow.offset, 4);
  assert.equal(completeWindow.truncated, true);
});

test("uses UTF-8 byte offsets without decoding process output", () => {
  const output = new ProcessOutputBuffer(8);
  output.append(Buffer.from("A🙂", "utf8")); // 1 ASCII byte + 4 emoji bytes
  output.append(Buffer.from("中B", "utf8")); // 3 CJK bytes + 1 ASCII byte

  assert.deepEqual(output.state(), {
    capacityBytes: 8,
    totalBytes: 9,
    bufferStartOffset: 1,
    availableBytes: 8,
    droppedBytes: 1,
  });
  assert.throws(() => output.read(0, 1), /no longer available/);

  const emoji = output.read(1, 4);
  assert.deepEqual(emoji.data, Buffer.from("🙂", "utf8"));
  assert.equal(emoji.endOffset, 5);

  const cjk = output.read(5, 3);
  assert.deepEqual(cjk.data, Buffer.from("中", "utf8"));
  assert.equal(cjk.offset, 5);
  assert.equal(cjk.endOffset, 8);
});

test("validates byte offsets and read limits", () => {
  const output = new ProcessOutputBuffer(4);
  output.append(Buffer.from("test"));

  assert.throws(() => output.read(5, 1), /beyond the end/);
  assert.throws(() => output.read(0.5, 1), /non-negative safe integer/);
  assert.throws(() => output.tail(-1), /non-negative safe integer/);
});


test("reads crossing chunk seams and mid-trimmed chunks stay byte-exact", () => {
  const output = new ProcessOutputBuffer(15);
  output.append(Buffer.from("abcdefghij"));
  output.append(Buffer.from("0123456789")); // total 20 > 15 -> keeps bytes 5..19
  // First chunk is now partially trimmed (its start advanced to byte 5): a
  // read that starts INSIDE the trimmed chunk and crosses into the second
  // chunk must return the exact original bytes.
  const spanning = output.read(5, 15);
  assert.equal(spanning.data.toString("utf8"), "fghij0123456789");
  assert.equal(spanning.endOffset, 20);
  assert.equal(spanning.truncated, true);
  // Offsets strictly after the seam.
  assert.equal(output.read(10, 5).data.toString("utf8"), "01234");
  assert.equal(output.read(12, 20).data.toString("utf8"), "23456789");
});

test("empty appends are no-ops and zero-capacity buffers retain nothing", () => {
  const empty = new ProcessOutputBuffer(8);
  const st = empty.append(Buffer.alloc(0));
  assert.equal(st.totalBytes, 0);
  assert.equal(st.availableBytes, 0);
  empty.append(Buffer.from("hello"));
  assert.equal(empty.state().totalBytes, 5);

  const zero = new ProcessOutputBuffer(0);
  zero.append(Buffer.from("abcdef"));
  assert.deepEqual(zero.state(), {
    capacityBytes: 0,
    totalBytes: 6,
    bufferStartOffset: 6,
    availableBytes: 0,
    droppedBytes: 6,
  });
  // Everything is dropped, so no read can succeed past nothing.
  assert.throws(() => zero.read(5, 1), /beyond the end|no longer available/);
});

test("a read never ends inside an incomplete ANSI escape sequence", () => {
  // Strip runs per page; an escape split across the boundary left raw ESC
  // fragments on both pages. The read now stops BEFORE the escape and the
  // cursor rewinds to it, so the next page re-emits the sequence whole.
  const output = new ProcessOutputBuffer(64);
  output.append(Buffer.from("abc\x1B[38;5;196m"));

  const page = output.read(0, 6);
  assert.equal(page.data.toString("binary"), "abc", "the page ends before the escape");
  assert.equal(page.endOffset, 3, "the cursor rewinds to the escape start");

  const rest = output.read(page.endOffset, 64);
  assert.equal(rest.data.toString("binary"), "\x1B[38;5;196m", "the next page carries the sequence whole");
});

test("complete sequences and non-escape tails are left untouched", () => {
  const complete = new ProcessOutputBuffer(64);
  complete.append(Buffer.from("x\x1B[38;5;196m"));
  const full = complete.read(0, 64);
  assert.equal(full.data.toString("binary"), "x\x1B[38;5;196m", "a complete sequence is not trimmed");
  assert.equal(full.endOffset, 12, "x + a 10-byte CSI sequence");

  const plain = new ProcessOutputBuffer(64);
  plain.append(Buffer.from("no escapes at all"));
  const tail = plain.read(3, 64);
  assert.equal(tail.data.toString("utf8"), "escapes at all");
  assert.equal(tail.endOffset, 17);
});

test("an incomplete OSC header is trimmed, a complete one is not", () => {
  const torn = new ProcessOutputBuffer(64);
  torn.append(Buffer.from("a\x1B]8;;http://x"));
  const page = torn.read(0, 64);
  assert.equal(page.data.toString("binary"), "a", "OSC without BEL/ST is incomplete");

  const whole = new ProcessOutputBuffer(64);
  whole.append(Buffer.from("a\x1B]8;;http://x\x07"));
  const kept = whole.read(0, 64);
  assert.equal(kept.data.toString("binary"), "a\x1B]8;;http://x\x07", "BEL-terminated OSC stays");
});
