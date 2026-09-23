import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgsSummary, ARGS_SUMMARY_MAX_CHARS } from "../src/bridge/tools/args-summary.js";

const identity = (s: string): string => s;

// redactor that simulates state.redactSensitiveText: secrets are scrubbed
const secretRedact = (s: string): string =>
  s.replace(/TOKEN[0-9]+/g, "<redacted>").replace(/https?:\/\/[^ ,}"]+/g, "<redacted-url>");

test("empty input yields undefined so record() can omit the field", () => {
  assert.equal(buildArgsSummary(undefined, identity), undefined);
  assert.equal(buildArgsSummary(null, identity), undefined);
  assert.equal(buildArgsSummary({}, identity), undefined);
});

test("scalar args serialize compactly", () => {
  assert.equal(
    buildArgsSummary({ path: "a.ts", max_results: 10, regex: false }, identity),
    `{path:"a.ts", max_results:10, regex:false}`,
  );
});

test("big payload keys become char-count placeholders", () => {
  const content = "x".repeat(1000);
  assert.equal(buildArgsSummary({ path: "x", content }, identity), `{path:"x", content:<len:1000 chars>}`);
  assert.equal(buildArgsSummary({ patch: "--- a\n+++ b\n" }, identity), `{patch:<len:12 chars>}`);
  assert.equal(buildArgsSummary({ old_text: "a", new_text: "b" }, identity), `{old_text:<len:1 chars>, new_text:<len:1 chars>}`);
  assert.equal(buildArgsSummary({ content_base64: "QQ==" }, identity), `{content_base64:<len:4 chars>}`);
});

test("long strings are truncated at 80 chars with an ellipsis", () => {
  const long = "a".repeat(81);
  const out = buildArgsSummary({ query: long }, identity)!;
  assert.match(out, /^\{query:"a{80}…"\}$/);
});

test("nested objects collapse beyond depth 2", () => {
  assert.equal(buildArgsSummary({ a: { b: { c: 1 } } }, identity), `{a:{b:{...}}}`);
});

test("arrays show items to depth 2, then a size marker; empty arrays stay []", () => {
  assert.equal(buildArgsSummary({ n: [1, 2, 3, 4, 5] }, identity), `{n:[1, 2, 3, 4, …]}`);
  assert.equal(buildArgsSummary({ edits: [{ old_text: "a", new_text: "b" }] }, identity), `{edits:[{...}]}`);
  assert.equal(buildArgsSummary({ empty: [] }, identity), `{empty:[]}`);
});

test("nested big payload keys are never echoed", () => {
  assert.equal(
    buildArgsSummary({ edits: [{ new_text: "secret-body" }] }, identity),
    `{edits:[{...}]}`,
  );
});

test("the injected redactor runs over the serialized summary", () => {
  const out = buildArgsSummary({ path: "x", url: "https://host/mcp/TOKEN42" }, secretRedact)!;
  assert.equal(out, `{path:"x", url:"<redacted-url>"}`);
  assert.ok(!out.includes("TOKEN42"));
  assert.ok(!out.includes("https://"));
});

test("redaction happens before truncation so caps never leak a secret prefix (T-1 live catch)", () => {
  const command = `echo https://host/mcp/TOKEN42 && echo ${'x'.repeat(60)}`;
  const out = buildArgsSummary({ command }, secretRedact)!;
  assert.ok(!out.includes("TOKEN42"), `leaked secret: ${out}`);
  assert.ok(!out.includes("https://"), `leaked url: ${out}`);
  assert.ok(out.includes("<redacted-url>"));
  // truncation happens inside the quoted string value, so the summary ends with the brace
  assert.match(out, /…"}$/);
  assert.ok(out.length < 100, `summary unexpectedly long: ${out}`);
});

test("the whole summary is capped at 300 chars with a trailing ellipsis", () => {
  const args: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) args[`key${i}`] = "v".repeat(60);
  const out = buildArgsSummary(args, identity)!;
  assert.ok(out.length <= ARGS_SUMMARY_MAX_CHARS + 1, `length ${out.length} > ${ARGS_SUMMARY_MAX_CHARS + 1}`);
  assert.ok(out.endsWith("…"));
});


test("depth-2 arrays collapse to the [N items] size marker", () => {
  const out = buildArgsSummary({ n: [[1], [2], [3], [4], [5]] }, identity);
  assert.ok(out, "summary produced");
  assert.match(out!, /\[1 items\]/);
  assert.ok(out!.includes("…"), `collapsed tail present: ${out}`);
});
