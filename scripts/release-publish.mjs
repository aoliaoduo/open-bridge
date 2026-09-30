import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  isPrereleaseTag,
  normalizeVersion,
  releaseNotesForVersion,
  releaseTitle,
  repositorySlug,
} from "./release-notes.mjs";
import { highestStableTag } from "./release-audit.mjs";

function run(file, args) {
  return execFileSync(file, args, { encoding: "utf8", windowsHide: true }).trim();
}

function runGh(args, input) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "gh failed").trim());
  }
  return result.stdout.trim();
}

export function publishArgs({ tag, repo, exists, latest }) {
  const common = [
    "--repo", repo,
    "--title", releaseTitle(tag),
    "--notes-file", "-",
    `--prerelease=${isPrereleaseTag(tag)}`,
    `--latest=${latest}`,
  ];
  return exists
    ? ["release", "edit", tag, "--draft=false", ...common]
    : ["release", "create", tag, "--verify-tag", ...common];
}

function main() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const repo = repositorySlug(pkg);
  const all = process.argv.includes("--all");
  const dryRun = process.argv.includes("--dry-run");
  const requested = process.argv.slice(2).find(arg => !arg.startsWith("--"));
  const dirty = run("git", ["status", "--porcelain"]);
  if (dirty && !dryRun) {
    throw new Error("Refusing to publish from a dirty working tree. Commit or stash changes first; use --dry-run to preview.");
  }
  const tags = run("git", ["tag", "--list"])
    .split(/\r?\n/)
    .filter(tag => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag));
  const targetTags = all ? tags : [`v${normalizeVersion(requested ?? pkg.version)}`];
  const releasePages = JSON.parse(run("gh", [
    "api", "--paginate", "--slurp", `repos/${repo}/releases?per_page=100`,
  ]));
  const existing = new Set(releasePages.flat().map(row => row.tag_name));
  const latestTag = highestStableTag(tags);

  for (const tag of targetTags) {
    if (!tags.includes(tag)) throw new Error(`Local tag does not exist: ${tag}`);
    const notes = releaseNotesForVersion(changelog, tag, repo) + "\n";
    const args = publishArgs({
      tag,
      repo,
      exists: existing.has(tag),
      latest: tag === latestTag,
    });
    if (dryRun) {
      console.log(`would ${existing.has(tag) ? "update" : "create"} ${tag}: ${releaseTitle(tag)}`);
      continue;
    }
    const output = runGh(args, notes);
    console.log(`${existing.has(tag) ? "updated" : "created"} ${tag}${output ? `: ${output}` : ""}`);
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
