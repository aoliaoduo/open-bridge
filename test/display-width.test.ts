import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth, padLabel } from "../src/cli.js";

test("displayWidth counts ASCII as one column each", () => {
  assert.equal(displayWidth("Web MCP: 123"), 12);
  assert.equal(displayWidth(""), 0);
});

test("displayWidth counts CJK and fullwidth forms as two columns", () => {
  assert.equal(displayWidth("\u63a7\u5236\u53f0"), 6);
  assert.equal(displayWidth("\uff1a"), 2);
  assert.equal(displayWidth("\uff08\u4ec5\u672c\u673a\uff09"), 10);
});

test("displayWidth counts mixed labels by columns, not characters", () => {
  // "Web \u63a7\u5236\u53f0:" is 9 characters but 11 columns;
  // "\u672c\u5730 MCP URL:" is 11 characters but 13 columns.
  assert.equal(displayWidth("Web \u63a7\u5236\u53f0:"), 11);
  assert.equal(displayWidth("\u672c\u5730 MCP URL:"), 13);
  assert.equal(displayWidth("\u65e5\u5fd7:"), 5);
});

test("padLabel aligns mixed labels to the same display column", () => {
  const padded = ["Web \u63a7\u5236\u53f0:", "\u672c\u5730 MCP URL:", "\u516c\u7f51 MCP URL:", "\u65e5\u5fd7:"].map(label => padLabel(label, 14));
  for (const label of padded) assert.equal(displayWidth(label), 14);
  assert.equal(padLabel("\u672c\u5730 MCP URL:", 14), "\u672c\u5730 MCP URL: ");
  assert.equal(padLabel("\u72b6\u6001:", 9), "\u72b6\u6001:    ");
});

test("padLabel never truncates a label wider than the target", () => {
  assert.equal(padLabel("\u672c\u5730 MCP URL:", 9), "\u672c\u5730 MCP URL:");
});
