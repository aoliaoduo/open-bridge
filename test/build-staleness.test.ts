import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStaleness, evaluateBuildStaleness, newestJsMtimeMs, staleBuildAdvice } from "../src/bridge/build-staleness.js";

/** Whole seconds, so the assertion does not depend on filesystem precision. */
const stamp = (path: string, seconds: number): void => utimesSync(path, seconds, seconds);

test("newestJsMtimeMs walks subdirectories and looks only at .js files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ob-build-"));
  try {
    mkdirSync(join(dir, "bridge"));
    const entry = join(dir, "cli.js");
    const nested = join(dir, "bridge", "lifecycle.js");
    // Same directory as the winner, newer than it, but not compiled code.
    const map = join(dir, "bridge", "lifecycle.js.map");
    const sheet = join(dir, "layout.css");
    for (const file of [entry, nested, map, sheet]) writeFileSync(file, "x");
    stamp(entry, 1_600_000_000);
    stamp(nested, 1_600_000_100);
    stamp(map, 1_700_000_000); // newest file of all — must still be ignored
    stamp(sheet, 1_700_000_000);

    assert.equal(Math.round(newestJsMtimeMs(dir) / 1000), 1_600_000_100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("newestJsMtimeMs is 0 when there is nothing to read", () => {
  const empty = mkdtempSync(join(tmpdir(), "ob-build-empty-"));
  try {
    assert.equal(newestJsMtimeMs(empty), 0, "an empty build directory is not an error");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  assert.equal(newestJsMtimeMs(join(tmpdir(), "ob-build-does-not-exist")), 0,
    "a missing build directory is not an error either");
});

test("evaluateBuildStaleness is strict: equal timestamps are fresh", () => {
  assert.equal(evaluateBuildStaleness(1_000, 1_001).stale, true, "a newer build on disk is stale");
  assert.equal(evaluateBuildStaleness(1_000, 1_000).stale, false, "the build we loaded is fresh");
  assert.equal(evaluateBuildStaleness(1_000, 999).stale, false, "an older build on disk is not stale");
  assert.deepEqual(evaluateBuildStaleness(7, 9), { stale: true, loaded_ms: 7, disk_ms: 9 });
});

test("no signal at all when running from source (there is no build to compare with)", () => {
  // This test runs through tsx against `src/`, which is exactly the dev case:
  // reporting "stale" there would be noise, so the answer must be `undefined`.
  assert.equal(buildStaleness(), undefined);
});

test("staleBuildAdvice speaks only when there is staleness to report", () => {
  // The notice rides on a tool result, so the silence cases matter as much as
  // the speaking one: dev mode has no build to compare with, and a fresh build
  // is the normal case. Both must cost the caller nothing.
  assert.equal(staleBuildAdvice(undefined), undefined, "no build to compare with (dev mode) says nothing");
  assert.equal(staleBuildAdvice(false), undefined, "a freshly loaded build says nothing");
  const advice = staleBuildAdvice(true);
  assert.ok(advice, "a stale build says something");
  assert.match(advice!, /restart/i, "it names the one action that fixes it");
  assert.match(advice!, /build_stale/, "and where the same fact is reported for a machine reader");
});
