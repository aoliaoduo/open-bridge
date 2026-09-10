import assert from "node:assert/strict";
import test from "node:test";
import { assertExpectedHash, sha256 } from "../src/workspace/file-version.js";

test("file hash allows the version just read", () => {
  const content = "first version\n";
  assert.doesNotThrow(() => assertExpectedHash(content, sha256(content), "example.txt"));
});

test("file hash rejects a stale write", () => {
  const expected = sha256("first version\n");
  assert.throws(() => assertExpectedHash("changed by another editor\n", expected, "example.txt"), /File changed since it was read/);
});

test("file hash rejects malformed input", () => {
  assert.throws(() => assertExpectedHash("content", "not-a-hash", "example.txt"), /expected_sha256/);
});
