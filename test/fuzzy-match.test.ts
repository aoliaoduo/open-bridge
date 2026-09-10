import assert from "node:assert/strict";
import test from "node:test";
import { findFuzzyMatch, formatFuzzyDiagnostics } from "../src/mcp/fuzzy-match.js";

test("finds an exact-duplicate window with full similarity", () => {
  const content = "alpha\nbeta\ngamma\n";
  const match = findFuzzyMatch(content, "beta\ngamma");
  assert.ok(match);
  assert.equal(match.similarity, 1);
  assert.equal(match.startLine, 2);
  assert.equal(match.endLine, 3);
});

test("flags whitespace-only drift (indentation/trailing) as the likely cause", () => {
  const content = "function a() {\n  return 1;\n}\n";
  const match = findFuzzyMatch(content, "function a() {\n    return 1;\n}");
  assert.ok(match);
  assert.ok(match.similarity >= 0.9, `similarity ${match.similarity}`);
  assert.ok(match.hints[0].includes("whitespace"), `hints: ${match.hints.join("; ")}`);
});

test("flags case-only drift", () => {
  const content = "const Config = 1;\n";
  const match = findFuzzyMatch(content, "const config = 1;");
  assert.ok(match);
  assert.ok(match.hints[0].includes("case"));
});

test("below the similarity bar returns undefined (plain error is fine)", () => {
  const content = "one\ntwo\nthree\n";
  assert.equal(findFuzzyMatch(content, "completely different text"), undefined);
});

test("oversized content is skipped", () => {
  const big = "x\n".repeat(2 * 1024 * 1024);
  assert.equal(findFuzzyMatch(big, "x"), undefined);
});

test("formatFuzzyDiagnostics mentions lines, percent and cause", () => {
  const match = findFuzzyMatch("alpha\nbeta\n", "alpha\nbeta")!;
  assert.ok(match);
  const text = formatFuzzyDiagnostics(match, "demo.txt");
  assert.match(text, /lines 1-2/);
  assert.match(text, /100% similar/);
  assert.match(text, /Likely cause:/);
  assert.match(text, /\| alpha/);
});

test("a needle longer than the file still yields a closest-match diagnostic", () => {
  const content = "alpha\nbeta\n";
  const match = findFuzzyMatch(content, "alpha\nbeta\ngamma");
  assert.ok(match);
  assert.equal(match.startLine, 1);
  assert.equal(match.endLine, 2);
});
