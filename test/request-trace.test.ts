import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ERROR_SUMMARY_CHARS,
  TRACED_METHODS,
  errorFingerprint,
  errorSummary,
  exchangeLine,
  isNoteworthy,
  traceId,
  tracedFormat,
  tracedMethod,
} from "../src/bridge/request-trace.js";
import type { ExchangeOutcome } from "../src/bridge/request-trace.js";

const base: ExchangeOutcome = {
  method: "tools/call",
  era: "modern",
  httpStatus: 200,
  durationMs: 12,
  aborted: false,
  format: "json",
};

test("only allow-listed methods survive; everything else is 'other'", () => {
  for (const method of TRACED_METHODS) {
    assert.equal(tracedMethod(method), method);
  }
  // A client cannot use the method string as a channel into the log.
  assert.equal(tracedMethod("tools/call\nINJECTED: pretend line"), "other");
  assert.equal(tracedMethod("acme/secret-method"), "other");
  assert.equal(tracedMethod(""), "other");
  assert.equal(tracedMethod(undefined), "other");
  assert.equal(tracedMethod(42), "other");
  assert.equal(tracedMethod({ toString: () => "tools/list" }), "other");
});

test("ids are hashed, stable, and never the input", () => {
  const session = "3f2a91c4d5e6b7a89900112233445566";
  const hashed = traceId(session);
  assert.ok(hashed, "a value hashes");
  assert.equal(hashed.length, 12);
  assert.equal(traceId(session), hashed, "stable across calls");
  assert.notEqual(hashed, session, "the id itself is not recoverable");
  assert.equal(session.includes(hashed), false);
  // Distinct inputs basically never collide at this width, and the same input
  // always maps the same way.
  assert.notEqual(traceId("session-a"), traceId("session-b"));
  // Absent rather than empty: an empty string would look like a real value.
  assert.equal(traceId(undefined), undefined);
  assert.equal(traceId(""), undefined);
  assert.equal(traceId(123), undefined);
});

test("session and tool are hashed in the rendered line, not printed raw", () => {
  const sessionId = "AAAAbbbbCCCCdddd";
  const toolName = "read_files";
  const line = exchangeLine({ ...base, sessionHash: traceId(sessionId), toolHash: traceId(toolName) });
  assert.equal(line.includes(sessionId), false, "the session id never appears");
  assert.equal(line.includes(toolName), false, "the tool name never appears");
  assert.match(line, /modern\/tools\/call/);
  assert.match(line, /HTTP 200/);
  assert.match(line, /json/);
  assert.match(line, /session [0-9a-f]{12}/);
  assert.match(line, /tool [0-9a-f]{12}/);
});

test("error text is fingerprinted and bounded, never dumped", () => {
  const secretPath = "C:\\Users\\someone\\private-project\\secrets.env";
  const error = new Error(`ENOENT: no such file or directory, open '${secretPath}'`);

  const summary = errorSummary(error);
  const fingerprint = errorFingerprint(error);
  const line = exchangeLine({ ...base, errorSummary: summary, errorFingerprint: fingerprint });

  assert.match(fingerprint, /^[0-9a-f]{16}$/, "the fingerprint is opaque and fixed-width");
  // The bounded summary keeps the message (an operator needs to know what
  // failed) but the exchange stays one short line: no stack, no cause chain,
  // no repeated context.
  assert.ok(line.length < 400, "one exchange is one bounded line");
  assert.equal(line.includes("at "), false, "no stack frames");
  assert.equal(line.split("\n").length, 1, "exactly one line");
});

test("a very long error message is capped even though it may name a path", () => {
  // The cap is what stops an error carrying an entire file body or a stack into
  // the activity log; the fingerprint is what lets an operator group repeats.
  const huge = new Error(`EACCES ${"x".repeat(5000)}`);
  const summary = errorSummary(huge)!;
  assert.equal(summary.length, MAX_ERROR_SUMMARY_CHARS + 1);
  assert.equal(errorSummary(huge), errorSummary(new Error(`EACCES ${"x".repeat(5000)}`)), "stable");
});

test("a multi-line error cannot forge extra log lines", () => {
  const error = new Error("first line\nsecond line\nthird line");
  const summary = errorSummary(error);
  assert.equal(summary, "first line second line third line");
  assert.equal(summary.includes("\n"), false, "newlines collapse");
  assert.equal(summary.includes("\r"), false);
});

test("the error summary is bounded and marked when truncated", () => {
  const long = new Error("x".repeat(MAX_ERROR_SUMMARY_CHARS * 3));
  const summary = errorSummary(long);
  assert.equal(summary.length, MAX_ERROR_SUMMARY_CHARS + 1, "truncated to the cap plus the ellipsis");
  assert.ok(summary.endsWith("…"), "truncation is visible");
  assert.equal(errorSummary(new Error("   ")), undefined, "an empty message yields no field");
  assert.equal(errorSummary(undefined), undefined);
  assert.equal(errorFingerprint(undefined), undefined);
  assert.equal(errorFingerprint(new Error("boo")), errorFingerprint(new Error("boo")), "stable for grouping");
});

test("response format is derived from the content type, defaulting to none", () => {
  assert.equal(tracedFormat("application/json; charset=utf-8"), "json");
  assert.equal(tracedFormat("text/event-stream"), "sse");
  assert.equal(tracedFormat("TEXT/EVENT-STREAM"), "sse");
  assert.equal(tracedFormat("text/html"), "none");
  assert.equal(tracedFormat(undefined), "none");
  assert.equal(tracedFormat(123), "none");
});

test("ordinary chatter is not logged, but failures and aborts always are", () => {
  assert.equal(isNoteworthy({ ...base, method: "ping" }), false, "a successful ping is noise");
  assert.equal(isNoteworthy({ ...base, method: "notifications/initialized" }), false);
  assert.equal(isNoteworthy({ ...base, method: "tools/list" }), true);
  assert.equal(isNoteworthy({ ...base, method: "tools/call" }), true);

  // A ping that failed, or one the client abandoned, is exactly what an operator
  // needs to see — the "ignore ping" rule must not swallow it.
  assert.equal(isNoteworthy({ ...base, method: "ping", httpStatus: 500 }), true);
  assert.equal(isNoteworthy({ ...base, method: "ping", aborted: true }), true);
  assert.equal(isNoteworthy({ ...base, method: "ping", errorFingerprint: "abc" }), true);
  assert.equal(isNoteworthy({ ...base, method: "notifications/initialized", httpStatus: 401 }), true);
});

test("the rendered line omits fields that are absent rather than printing placeholders", () => {
  const line = exchangeLine({ ...base, method: "tools/list", format: "none" });
  assert.match(line, /no-body/);
  // Match the field labels, not bare substrings: "tools/list" legitimately
  // contains "tool".
  assert.equal(/\bsession [0-9a-f]/.test(line), false, "no session on the stateless era");
  assert.equal(/\btool [0-9a-f]/.test(line), false, "tools/list names no tool");
  assert.equal(line.includes("client-aborted"), false);
  assert.equal(line.includes("undefined"), false);
  assert.equal(line.includes("null"), false);
});

test("an aborted exchange is labelled", () => {
  const line = exchangeLine({ ...base, aborted: true });
  assert.match(line, /client-aborted/);
});
