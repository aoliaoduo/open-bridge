import test from "node:test";
import assert from "node:assert/strict";
import { publishArgs } from "../scripts/release-publish.mjs";

test("release publish arguments keep title, prerelease and latest decisions explicit", () => {
  assert.deepEqual(
    publishArgs({ tag: "v1.4.5", repo: "aoliaoduo/open-bridge", exists: false, latest: true }),
    [
      "release", "create", "v1.4.5", "--verify-tag",
      "--repo", "aoliaoduo/open-bridge",
      "--title", "Open Bridge v1.4.5",
      "--notes-file", "-",
      "--prerelease=false",
      "--latest=true",
    ],
  );
  const prerelease = publishArgs({
    tag: "v2.0.0-rc.1",
    repo: "aoliaoduo/open-bridge",
    exists: true,
    latest: false,
  });
  assert.ok(prerelease.includes("--prerelease=true"));
  assert.ok(prerelease.includes("--latest=false"));
});
