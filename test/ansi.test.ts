import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi, maybeStripAnsi } from "../src/process/ansi.js";

const ESC = "\u001B";
const BEL = "\u0007";

test("strips SGR color and style sequences", () => {
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m plain`), "red plain");
  assert.equal(stripAnsi(`${ESC}[1;32mbold green${ESC}[m`), "bold green");
});

test("strips cursor movement and erase sequences", () => {
  assert.equal(stripAnsi(`ab${ESC}[2Kcd`), "abcd");
  assert.equal(stripAnsi(`${ESC}[2;5Hpos${ESC}[1Aup`), "posup");
});

test("strips OSC hyperlinks terminated by BEL", () => {
  assert.equal(stripAnsi(`${ESC}]8;;http://example.com${BEL}link${ESC}]8;;${BEL}`), "link");
});

test("strips C1 CSI introducer as well", () => {
  assert.equal(stripAnsi("\u009B31mred\u009B0m"), "red");
});

test("keeps plain text, unicode and newlines untouched", () => {
  assert.equal(stripAnsi("plain text"), "plain text");
  assert.equal(stripAnsi("中文输出\n第二行\r\n"), "中文输出\n第二行\r\n");
  assert.equal(stripAnsi(""), "");
});

test("maybeStripAnsi honors strip_ansi default-true semantics", () => {
  const colored = `${ESC}[31mred${ESC}[0m`;
  assert.equal(maybeStripAnsi(colored, undefined), "red");
  assert.equal(maybeStripAnsi(colored, true), "red");
  assert.equal(maybeStripAnsi(colored, false), colored);
});
