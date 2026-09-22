/**
 * Release-package guard.
 *
 * `npm pack --dry-run --json` is the authority for what npm would publish.
 * This module reads that JSON from stdin so package.json owns the cross-platform
 * `npm pack` invocation, while the validation stays deterministic and testable.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const requiredPackagePaths = [
  "docs/ARCHITECTURE.md",
  "docs/observability.md",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "bin/open-bridge.js",
  "dist/cli.js",
  "dist/ui/console.html",
  "docs/configuration.md",
  "docs/tools.md",
  "package.json",
  // The vendored ripgrep: package.json publishes vendor/ whole, but this is
  // the file search defaults depend on, so it is pinned by name.
  "vendor/rg.exe",
];

const forbiddenPackagePrefixes = [".github/", "src/", "test/"];

/** npm 10 emits an object keyed by package name; npm 11 emits an array. */
export function packageRecordFromJson(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (Array.isArray(parsed)) return parsed[0];
  if (parsed !== null && typeof parsed === "object") {
    return Object.values(parsed).find(value => value !== null
      && typeof value === "object"
      && Array.isArray(value.files));
  }
  return undefined;
}

export function packageManifestProblems(record) {
  if (record === undefined || record === null || !Array.isArray(record.files)) {
    return ["npm pack did not return a package record with a files array."];
  }

  const paths = new Set(record.files
    .map(file => file !== null && typeof file === "object" ? file.path : undefined)
    .filter(path => typeof path === "string"));
  const problems = requiredPackagePaths
    .filter(path => !paths.has(path))
    .map(path => `missing required published file: ${path}`);

  for (const path of paths) {
    const forbidden = forbiddenPackagePrefixes.find(prefix => path.startsWith(prefix));
    if (forbidden !== undefined) problems.push(`source-only file would be published: ${path}`);
  }
  return problems;
}

async function stdinText() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const text = await stdinText();
  let record;
  try {
    record = packageRecordFromJson(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`package preflight failed: npm pack did not emit valid JSON (${detail}).`);
    process.exitCode = 1;
    return;
  }

  const problems = packageManifestProblems(record);
  if (problems.length > 0) {
    console.error("package preflight failed:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }

  const fileCount = record.files.length;
  const id = typeof record.id === "string" ? record.id : "package";
  console.log(`package preflight passed: ${id} (${fileCount} published files).`);
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
