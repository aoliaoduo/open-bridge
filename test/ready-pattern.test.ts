import assert from "node:assert/strict";
import test from "node:test";
import { ReadyPatternError, testReadyPattern, validateReadyPattern } from "../src/mcp/regex-worker.js";

test("matches valid readiness patterns in an isolated worker", async () => {
  await validateReadyPattern("ready\\s+on\\s+\\d+");
  await assert.doesNotReject(testReadyPattern("ready\\s+on\\s+\\d+", "ready on 3000", 500));
  assert.equal(await testReadyPattern("ready\\s+on\\s+\\d+", "starting", 500), false);
});

test("rejects malformed readiness patterns before a process is started", async () => {
  await assert.rejects(validateReadyPattern("["), ReadyPatternError);
});

test("times out a catastrophic readiness pattern without blocking the host", { timeout: 3_000 }, async () => {
  await assert.rejects(
    testReadyPattern("(a+)+$", `${"a".repeat(8_192)}!`, 100),
    /evaluation exceeded 100 ms/,
  );
});
