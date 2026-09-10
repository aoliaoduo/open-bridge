import assert from "node:assert/strict";
import test from "node:test";
import { isDeterministicNetworkFailure } from "../src/network/net-failure.js";
import {
  boundedHoverText, emitEnvelope, queryTokens, symbolKindName,
  warmupCandidateScore,
} from "../src/mcp/lsp-format.js";
import { boundedText, countDiffLines, unifiedDiff } from "../src/mcp/line-diff.js";

test("deterministic network failure detection walks the cause chain", () => {
  const direct = Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" });
  assert.equal(isDeterministicNetworkFailure(direct), true);

  const nested = new Error("request failed", {
    cause: Object.assign(new Error("dns issue"), { code: "ECONNREFUSED" }),
  });
  assert.equal(isDeterministicNetworkFailure(nested), true);

  const deep = new Error("a", { cause: new Error("b", { cause: Object.assign(new Error("tls"), { code: "CERT_HAS_EXPIRED" }) }) });
  assert.equal(isDeterministicNetworkFailure(deep), true);

  assert.equal(isDeterministicNetworkFailure(new Error("aborted")), false);
  assert.equal(isDeterministicNetworkFailure(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), false);
  assert.equal(isDeterministicNetworkFailure(undefined), false);
});

test("queryTokens splits camelCase and drops short noise", () => {
  assert.deepEqual(queryTokens("getUserSessionService"), ["get", "user", "session", "service"]);
  assert.deepEqual(queryTokens("session-manager cfg"), ["session", "manager", "cfg"]);
  assert.deepEqual(queryTokens("ab x"), []);
});

test("warmup scoring prefers basename hits over path hits", () => {
  const tokens = queryTokens("session");
  const basenameHit = warmupCandidateScore("src/a/session.ts", "session", tokens);
  const pathOnlyHit = warmupCandidateScore("src/session/manager.ts", "session", tokens);
  const noHit = warmupCandidateScore("src/utils/other.ts", "session", tokens);
  assert.equal(basenameHit > pathOnlyHit, true);
  assert.equal(pathOnlyHit > noHit, true);
  assert.equal(noHit, 0);
});

test("bounded hover text keeps head and tail", () => {
  const full = "A".repeat(10_000) + "MARKER" + "B".repeat(10_000);
  const { text, truncated } = boundedHoverText(full, 1_000);
  assert.equal(truncated, true);
  assert.ok(text.length <= 1_050);
  assert.ok(text.startsWith("A"));
  assert.ok(text.endsWith("B"));
  assert.ok(text.includes("...[truncated]..."));
  assert.deepEqual(boundedHoverText("short", 1_000), { text: "short", truncated: false });
});

test("emitEnvelope enforces block count and character budget", () => {
  const blocks = Array.from({ length: 5 }, (_, i) => `--- RESULT ${i + 1} ---\n${"x".repeat(50)}`);
  const capped = emitEnvelope(["operation: test"], blocks, 5, 3);
  assert.equal(capped.returned, 3);
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.includes("returned_results: 3"));

  const big = ["y".repeat(70_000)];
  const budgeted = emitEnvelope(["operation: test"], big, 1, 500, 64_000);
  assert.equal(budgeted.returned, 0);
  assert.equal(budgeted.truncated, true);
});

test("symbolKindName maps known kinds and falls back", () => {
  assert.equal(symbolKindName(12), "Function");
  assert.equal(symbolKindName(5), "Class");
  assert.equal(symbolKindName(999), "999");
});

test("unifiedDiff produces a single hunk with counts", () => {
  const before = "alpha\nbeta\ngamma\ndelta\n";
  const after = "alpha\nBETA\ngamma\ndelta\n";
  const diff = unifiedDiff(before, after);
  assert.ok(diff);
  assert.match(diff, /^@@ -\d+,\d+ \+\d+,\d+ @@/);
  assert.ok(diff.includes("-beta"));
  assert.ok(diff.includes("+BETA"));
  const stats = countDiffLines(diff);
  assert.deepEqual(stats, { additions: 1, deletions: 1 });
  assert.equal(unifiedDiff(before, before), undefined);
});

test("boundedText shares the head+tail semantics", () => {
  const long = "H".repeat(500) + "MIDDLE" + "T".repeat(500);
  const { text, truncated } = boundedText(long, 200);
  assert.equal(truncated, true);
  assert.ok(text.includes("...[truncated]..."));
  assert.equal(boundedText("ok", 10).truncated, false);
});


test("warmupCandidateScore pins the query and token contributions exactly", () => {
  // Query-substring scoring (+200 basename / +100 path) and per-token scoring
  // (+30 basename / +10 path) must both contribute; ordering-only assertions
  // could pass if the query tiers were deleted.
  const tokens = queryTokens("session");
  assert.equal(warmupCandidateScore("src/a/session.ts", "session", tokens), 330); // 200+100+30
  assert.equal(warmupCandidateScore("src/session/manager.ts", "session", tokens), 110); // 100+10
  assert.equal(warmupCandidateScore("src/utils/other.ts", "session", tokens), 0);
});
