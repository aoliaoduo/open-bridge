import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const HEADING_MAP = new Map([
  ["Added", "新增"],
  ["Changed", "改进"],
  ["Fixed", "修复"],
  ["Removed", "移除"],
  ["Security", "安全"],
  ["Deprecated", "弃用"],
]);

export function normalizeVersion(input) {
  const value = String(input ?? "").trim();
  return value.startsWith("v") ? value.slice(1) : value;
}

export function releaseTitle(tag) {
  return `Open Bridge ${tag.startsWith("v") ? tag : `v${tag}`}`;
}

export function isPrereleaseTag(tag) {
  return normalizeVersion(tag).includes("-");
}

export function changelogVersions(text) {
  return text
    .split(/\r?\n/)
    .map(line => /^## \[([^\]]+)\]/.exec(line)?.[1])
    .filter(version => version && version !== "Unreleased");
}

export function changelogSection(text, requestedVersion) {
  const version = normalizeVersion(requestedVersion);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}.`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## \[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

export function repositorySlug(packageJson) {
  const raw = typeof packageJson?.repository === "string"
    ? packageJson.repository
    : packageJson?.repository?.url;
  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/.exec(String(raw ?? ""));
  if (!match) throw new Error("package.json repository must point to a GitHub OWNER/REPO repository.");
  return `${match[1]}/${match[2]}`;
}

export function releaseNotesForVersion(changelogText, requestedVersion, repo) {
  const section = changelogSection(changelogText, requestedVersion);
  const safeSection = section.split(String.fromCharCode(27)).join("^[");
  const normalized = safeSection
    .split("\n")
    .map(line => {
      const heading = /^### (.+)$/.exec(line);
      if (!heading) return line;
      const label = HEADING_MAP.get(heading[1]) ?? heading[1];
      return `## ${label}`;
    })
    .join("\n")
    .trim();
  return `${normalized}\n\n完整变更见 [CHANGELOG.md](https://github.com/${repo}/blob/main/CHANGELOG.md)。`;
}

function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const version = normalizeVersion(process.argv[2] ?? pkg.version);
  const repo = repositorySlug(pkg);
  process.stdout.write(releaseNotesForVersion(changelog, version, repo) + "\n");
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
