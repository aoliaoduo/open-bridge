import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePatchSource } from "../src/mcp/patch.js";

test("inline patch only resolves to the inline content", () => {
  assert.deepEqual(resolvePatchSource("--- a\n+++ b\n", undefined), {
    kind: "inline",
    content: "--- a\n+++ b\n",
  });
});

test("patch_file only resolves to a trimmed workspace path", () => {
  assert.deepEqual(resolvePatchSource(undefined, " patches/x.diff "), {
    kind: "file",
    path: "patches/x.diff",
  });
});

test("both provided is rejected with the expected shapes in the message", () => {
  assert.throws(
    () => resolvePatchSource("--- a", "x.diff"),
    /exactly one of patch or patch_file.*expected 'patch': string or 'patch_file': string/s,
  );
});

test("neither provided is rejected with the same error", () => {
  assert.throws(() => resolvePatchSource(undefined, undefined), /exactly one of patch or patch_file/);
});

test("empty patch string counts as absent, so patch_file wins", () => {
  assert.deepEqual(resolvePatchSource("", "p.diff"), { kind: "file", path: "p.diff" });
});

test("blank patch_file counts as absent, so patch wins", () => {
  assert.deepEqual(resolvePatchSource("--- a", "   "), { kind: "inline", content: "--- a" });
});
