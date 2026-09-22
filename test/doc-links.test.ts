/**
 * Relative links in repository documentation must resolve.
 *
 * The case that prompted this: the bug template lives in
 * `.github/ISSUE_TEMPLATE/` and pointed at `../SECURITY.md`, which resolves
 * to `.github/SECURITY.md` — a file that does not exist. It needed `../../`.
 *
 * That flavour of mistake is invisible while writing (the path looks right
 * from the repository root, which is where you are thinking from) and lands
 * on exactly the page where a contributor is being told to go read something
 * before filing. Depth-sensitive links are worth a machine check rather than
 * an eye.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** Repository Markdown, including new docs but not ignored private notes/builds. */
function markdownFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"], {
    cwd: root, encoding: "utf8",
  }).split(String.fromCharCode(0))
    // Bundled/vendor documentation is not this repository's reference contract.
    .filter(file => file && !file.startsWith("vendor/") && !file.startsWith("参考/"))
    .map(file => path.join(root, file))
    .filter(file => existsSync(file)); // git still lists a deletion until it is staged.
}

test("relative links in markdown point at files that exist", () => {
  const root = process.cwd();
  const broken: string[] = [];

  for (const file of markdownFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = match[1] ?? "";
      // Only local paths: external URLs and pure anchors are out of scope.
      if (/^[a-z]+:/i.test(href) || href.startsWith("#")) continue;
      const target = (href.split("#")[0] ?? "").trim();
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!existsSync(resolved)) {
        broken.push(`${path.relative(root, file)} -> ${href}`);
      }
    }
  }

  assert.deepEqual(broken, [], `broken relative links:\n  ${broken.join("\n  ")}`);
});

// Inline implementation pointers go stale when modules move just as ordinary
// Markdown links do. Examples with globs/placeholders are deliberately excluded.
test("inline repository source references point at existing files", () => {
  const root = process.cwd();
  const broken: string[] = [];
  for (const file of markdownFiles(root)) {
    const source = readFileSync(file, "utf8");
    const references = source.matchAll(/`((?:src|ui\/src|test|scripts|bin)\/[A-Za-z0-9_./-]+\.(?:tsx?|mjs|js|css|html))`/g);
    for (const match of references) {
      const target = match[1];
      if (target && !existsSync(path.join(root, target))) {
        broken.push(`${path.relative(root, file)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(broken, [], `stale source references:\n  ${broken.join("\n  ")}`);
});

// Credential checks live in credential-hygiene.test.mjs and cover all source files.

// A copied policy with an unfinished reporting channel cannot be used safely.
test("the conduct policy has a usable reporting contact, not a template placeholder", () => {
  const policy = readFileSync(path.join(process.cwd(), "CODE_OF_CONDUCT.md"), "utf8");
  const reporting = policy.match(/## Enforcement\r?\n([\s\S]*?)\r?\n## /)?.[1];
  assert.ok(reporting, "missing reporting section");
  assert.doesNotMatch(reporting, /\b(?:TODO|TBD|INSERT CONTACT)\b/i);
  assert.match(reporting, /\]\((?:mailto:|https:\/\/)[^)]+\)/, "publish an actionable reporting channel");
});
