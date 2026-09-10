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
