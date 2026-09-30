import test from "node:test";
import assert from "node:assert/strict";
import {
  changelogSection,
  releaseNotesForVersion,
  releaseTitle,
  repositorySlug,
} from "../scripts/release-notes.mjs";

const changelog = `# Changelog

## [Unreleased]

## [1.2.3] — 2026-09-30

### Added

- 新能力。

### Fixed

- 修复问题。

## [1.2.2] — 2026-09-29

### Changed

- 调整行为。
`;

test("release notes are generated from exactly one changelog section with canonical headings", () => {
  assert.equal(changelogSection(changelog, "v1.2.3").includes("1.2.2"), false);
  assert.equal(
    releaseNotesForVersion(changelog, "v1.2.3", "owner/repo"),
    "## 新增\n\n- 新能力。\n\n## 修复\n\n- 修复问题。\n\n完整变更见 [CHANGELOG.md](https://github.com/owner/repo/blob/main/CHANGELOG.md)。",
  );
});

test("release naming and repository parsing stay canonical", () => {
  assert.equal(releaseTitle("v1.2.3-beta.1"), "Open Bridge v1.2.3-beta.1");
  assert.equal(
    repositorySlug({ repository: { url: "git+https://github.com/aoliaoduo/open-bridge.git" } }),
    "aoliaoduo/open-bridge",
  );
  assert.throws(() => repositorySlug({ repository: "https://example.com/nope" }), /GitHub/);
});

test("release notes render terminal control bytes as visible text", () => {
  const withAnsi = "## [1.0.0] — 2026-09-30\n\n### Fixed\n\n- saw `\u001b[31mred`.\n";
  const notes = releaseNotesForVersion(withAnsi, "1.0.0", "owner/repo");
  assert.equal(notes.includes("\u001b"), false);
  assert.match(notes, /\^\[\[31mred/);
});
