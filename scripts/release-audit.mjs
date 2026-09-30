import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  changelogSection,
  changelogVersions,
  isPrereleaseTag,
  normalizeVersion,
  releaseNotesForVersion,
  releaseTitle,
  repositorySlug,
} from "./release-notes.mjs";

function normalizedMarkdown(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

export function stableVersionTuple(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag));
  return match ? match.slice(1).map(Number) : null;
}

export function highestStableTag(tags) {
  return tags
    .map(tag => ({ tag, tuple: stableVersionTuple(tag) }))
    .filter(item => item.tuple)
    .sort((a, b) => {
      for (let i = 0; i < 3; i += 1) {
        const delta = b.tuple[i] - a.tuple[i];
        if (delta !== 0) return delta;
      }
      return 0;
    })[0]?.tag;
}

export function auditReleaseSnapshot({
  packageVersion,
  lockVersion,
  lockRootVersion,
  changelogText,
  repo,
  trackedText = "",
  tags,
  releases,
  latestTag,
}) {
  const problems = [];
  if (packageVersion !== lockVersion) {
    problems.push(`package-lock version ${lockVersion} != package version ${packageVersion}`);
  }
  if (packageVersion !== lockRootVersion) {
    problems.push(`package-lock root version ${lockRootVersion} != package version ${packageVersion}`);
  }
  try {
    changelogSection(changelogText, packageVersion);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const firstReleasedVersion = changelogVersions(changelogText)[0];
  if (firstReleasedVersion !== normalizeVersion(packageVersion)) {
    problems.push(`latest CHANGELOG version ${firstReleasedVersion ?? "none"} != package version ${packageVersion}`);
  }
  if (String(trackedText).trim()) {
    problems.push("tracked files still reference the retired GitHub repository URL");
  }

  if (!tags || !releases) return problems;

  const tagSet = new Set(tags);
  const releaseMap = new Map(releases.map(release => [release.tag_name, release]));
  const versionTags = tags.filter(tag => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag));
  const currentTag = `v${normalizeVersion(packageVersion)}`;
  if (!tagSet.has(currentTag)) problems.push(`current package tag is missing: ${currentTag}`);

  for (const tag of versionTags) {
    const release = releaseMap.get(tag);
    if (!release) {
      problems.push(`tag has no GitHub Release: ${tag}`);
      continue;
    }
    try {
      changelogSection(changelogText, tag);
    } catch {
      problems.push(`tag has no CHANGELOG section: ${tag}`);
    }
    const expectedTitle = releaseTitle(tag);
    if (release.name !== expectedTitle) problems.push(`${tag}: title must be "${expectedTitle}"`);
    if (release.draft) problems.push(`${tag}: release must not be a draft`);
    if (release.prerelease !== isPrereleaseTag(tag)) {
      problems.push(`${tag}: prerelease flag does not match the tag`);
    }
    try {
      const expectedBody = releaseNotesForVersion(changelogText, tag, repo);
      if (normalizedMarkdown(release.body) !== normalizedMarkdown(expectedBody)) {
        problems.push(`${tag}: release body does not match generated CHANGELOG notes`);
      }
    } catch {
      // Missing CHANGELOG section is reported above.
    }
  }

  for (const release of releases) {
    if (/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name) && !tagSet.has(release.tag_name)) {
      problems.push(`GitHub Release has no local tag: ${release.tag_name}`);
    }
  }

  const expectedLatest = highestStableTag(versionTags);
  if (expectedLatest && latestTag !== expectedLatest) {
    problems.push(`latest Release must be ${expectedLatest}, got ${latestTag ?? "none"}`);
  }
  return problems;
}

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", windowsHide: true }).trim();
}

function trackedRepositoryText() {
  const retiredUrl = "https://github.com/aoliaoduo/" + "open-bridge-app";
  try {
    return run("git", ["grep", "--untracked", "-n", "-I", "-F", retiredUrl, "--", "."]);
  } catch {
    return "";
  }
}

function main() {
  const localOnly = process.argv.includes("--local");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const changelogText = readFileSync("CHANGELOG.md", "utf8");
  const repo = repositorySlug(pkg);
  const snapshot = {
    packageVersion: pkg.version,
    lockVersion: lock.version,
    lockRootVersion: lock.packages?.[""]?.version,
    changelogText,
    repo,
    trackedText: trackedRepositoryText(),
  };

  if (!localOnly) {
    snapshot.tags = run("git", ["tag", "--list"]).split(/\r?\n/).filter(Boolean);
    const releasePages = JSON.parse(run("gh", [
      "api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`,
    ]));
    snapshot.releases = releasePages.flat();
    try {
      snapshot.latestTag = JSON.parse(run("gh", ["api", `repos/${repo}/releases/latest`])).tag_name;
    } catch {
      snapshot.latestTag = undefined;
    }
  }

  const problems = auditReleaseSnapshot(snapshot);
  if (problems.length) {
    console.error(`release audit failed (${problems.length}):`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(localOnly
    ? `release audit passed locally: open-bridge@${pkg.version}`
    : `release audit passed: open-bridge@${pkg.version}, ${snapshot.releases.length} GitHub Releases`);
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
