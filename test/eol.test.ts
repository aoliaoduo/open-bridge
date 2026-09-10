import assert from "node:assert/strict";
import test from "node:test";
import { detectEol, toLf, applyEol } from "../src/workspace/eol.js";

test("detect CRLF vs LF", () => {
  assert.equal(detectEol("a\r\nb\r\n"), "\r\n");
  assert.equal(detectEol("a\nb\n"), "\n");
  assert.equal(detectEol("mixed\r\nhere\nbut\nmore\nlf"), "\n"); // more LF
  assert.equal(detectEol("no newlines"), "\n");
});

test("toLf strips CR", () => {
  assert.equal(toLf("a\r\nb\r\n"), "a\nb\n");
  assert.equal(toLf("a\nb"), "a\nb");
});

test("applyEol restores target style", () => {
  assert.equal(applyEol("a\nb\n", "\r\n"), "a\r\nb\r\n");
  assert.equal(applyEol("a\r\nb\r\n", "\n"), "a\nb\n");
});
