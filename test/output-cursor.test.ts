import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessOutputBuffer } from "../src/process/output-buffer.js";
import { hasUnreadOutput, resolveReadOffset } from "../src/process/output-cursor.js";

test("a caught-up caller has nothing unread, however much the buffer retains", () => {
  // THE REGRESSION. The long-poll used to ask the buffer whether it held any
  // bytes (availableBytes), which is permanently true once a process has
  // printed anything. A caller that has read all of it is nonetheless caught
  // up and must be allowed to wait for NEW output.
  const buffer = new ProcessOutputBuffer(1024 * 1024);
  buffer.append(Buffer.from("FIRST_LINE\n"));
  const state = buffer.state();

  assert.equal(state.availableBytes, 11, "the buffer does retain the line");
  assert.equal(hasUnreadOutput(11, state), false,
    "a caller at offset 11 has read everything and must block, not return instantly");
});

test("a caller behind the stream has unread output and must not block", () => {
  const buffer = new ProcessOutputBuffer(1024 * 1024);
  buffer.append(Buffer.from("FIRST_LINE\n"));
  assert.equal(hasUnreadOutput(0, buffer.state()), true);
  assert.equal(hasUnreadOutput(10, buffer.state()), true);
});

test("new output makes a previously caught-up caller ready again", () => {
  const buffer = new ProcessOutputBuffer(1024 * 1024);
  buffer.append(Buffer.from("one\n"));
  assert.equal(hasUnreadOutput(4, buffer.state()), false);
  buffer.append(Buffer.from("two\n"));
  assert.equal(hasUnreadOutput(4, buffer.state()), true);
});

test("a silent process leaves every caller caught up", () => {
  const buffer = new ProcessOutputBuffer(1024 * 1024);
  const state = buffer.state();
  assert.equal(hasUnreadOutput(0, state), false);
  assert.equal(resolveReadOffset(undefined, state), 0);
});

test("an offset past the end counts as caught up", () => {
  const buffer = new ProcessOutputBuffer(1024 * 1024);
  buffer.append(Buffer.from("abc"));
  assert.equal(hasUnreadOutput(99, buffer.state()), false);
});

test("an omitted offset resolves to the retained window start", () => {
  const buffer = new ProcessOutputBuffer(8);
  // Overflow the capacity so the window no longer starts at 0.
  buffer.append(Buffer.from("0123456789abcdef"));
  const state = buffer.state();
  assert.equal(state.bufferStartOffset, 8);
  assert.equal(resolveReadOffset(undefined, state), 8);
  // Dropped output still counts as unread for a caller starting at the window.
  assert.equal(hasUnreadOutput(8, state), true);
});

test("a malformed offset falls back to the window start rather than guessing", () => {
  const buffer = new ProcessOutputBuffer(1024 * 1024);
  buffer.append(Buffer.from("data\n"));
  const state = buffer.state();
  for (const bad of ["abc", null, -1, 1.5, Number.NaN, {}]) {
    assert.equal(resolveReadOffset(bad, state), state.bufferStartOffset,
      `malformed offset ${String(bad)} must not be trusted; outputRead rejects it`);
  }
});

test("a numeric-string offset is honored", () => {
  const buffer = new ProcessOutputBuffer(1024 * 1024);
  buffer.append(Buffer.from("hello\n"));
  assert.equal(resolveReadOffset("6", buffer.state()), 6);
  assert.equal(hasUnreadOutput(resolveReadOffset("6", buffer.state()), buffer.state()), false);
});
