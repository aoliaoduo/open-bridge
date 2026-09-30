import test from "node:test";
import assert from "node:assert/strict";
import { auditReleaseSnapshot, highestStableTag } from "../scripts/release-audit.mjs";
import { releaseNotesForVersion } from "../scripts/release-notes.mjs";

const changelog = `# Changelog

## [Unreleased]

## [1.2.0] — 2026-09-30

### Fixed

- 稳定版修复。

## [1.2.0-rc.1] — 2026-09-29

### Added

- 候选功能。
`;
const repo = "owner/repo";
const tags = ["v1.2.0", "v1.2.0-rc.1"];
const releases = [
  {
    tag_name: "v1.2.0",
    name: "Open Bridge v1.2.0",
    draft: false,
    prerelease: false,
    body: releaseNotesForVersion(changelog, "v1.2.0", repo),
  },
  {
    tag_name: "v1.2.0-rc.1",
    name: "Open Bridge v1.2.0-rc.1",
    draft: false,
    prerelease: true,
    body: releaseNotesForVersion(changelog, "v1.2.0-rc.1", repo),
  },
];

test("a coherent release snapshot passes", () => {
  assert.deepEqual(auditReleaseSnapshot({
    packageVersion: "1.2.0",
    lockVersion: "1.2.0",
    lockRootVersion: "1.2.0",
    changelogText: changelog,
    repo,
    tags,
    releases,
    latestTag: "v1.2.0",
  }), []);
});

test("audit reports the release inconsistencies that caused the historical drift", () => {
  const broken = structuredClone(releases);
  broken[0].name = "v1.2.0";
  broken[0].body = "hand-written notes";
  broken[1].prerelease = false;
  const problems = auditReleaseSnapshot({
    packageVersion: "1.2.0",
    lockVersion: "1.1.9",
    lockRootVersion: "1.2.0",
    changelogText: changelog,
    repo,
    trackedText: "README: https://github.com/owner/" + "open-bridge-app",
    tags,
    releases: broken,
    latestTag: "v1.2.0-rc.1",
  });
  assert.ok(problems.some(problem => problem.includes("package-lock version")));
  assert.ok(problems.some(problem => problem.includes("retired GitHub repository URL")));
  assert.ok(problems.some(problem => problem.includes("title must be")));
  assert.ok(problems.some(problem => problem.includes("release body")));
  assert.ok(problems.some(problem => problem.includes("prerelease flag")));
  assert.ok(problems.some(problem => problem.includes("latest Release")));
});

test("highest stable tag ignores prereleases", () => {
  assert.equal(highestStableTag(["v1.9.9", "v2.0.0-rc.1", "v1.10.0"]), "v1.10.0");
});
