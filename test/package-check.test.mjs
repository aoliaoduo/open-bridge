import assert from "node:assert/strict";
import test from "node:test";
import {
  packageManifestProblems,
  packageRecordFromJson,
  requiredPackagePaths,
} from "../scripts/package-check.mjs";

function completeRecord() {
  return {
    id: "open-bridge@0.0.0-test",
    files: requiredPackagePaths.map(path => ({ path })),
  };
}

test("package preflight accepts a complete publish manifest", () => {
  assert.deepEqual(packageManifestProblems(completeRecord()), []);
});

test("package preflight names a required file missing from the tarball", () => {
  const record = completeRecord();
  record.files = record.files.filter(file => file.path !== "dist/cli.js");
  assert.deepEqual(packageManifestProblems(record), [
    "missing required published file: dist/cli.js",
  ]);
});

test("package preflight refuses source and test files in a release tarball", () => {
  const record = completeRecord();
  record.files.push({ path: "src/cli.ts" }, { path: "test/cli.test.mjs" });
  assert.deepEqual(packageManifestProblems(record), [
    "source-only file would be published: src/cli.ts",
    "source-only file would be published: test/cli.test.mjs",
  ]);
});

test("package preflight understands npm's keyed and array JSON shapes", () => {
  const record = completeRecord();
  assert.deepEqual(packageRecordFromJson(JSON.stringify([record])), record);
  assert.deepEqual(packageRecordFromJson(JSON.stringify({ "open-bridge": record })), record);
  assert.equal(packageRecordFromJson("null"), undefined);
});
