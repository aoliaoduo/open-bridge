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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Every tracked markdown file, excluding dependency and build output. */
function markdownFiles(dir: string, out: string[] = []): string[] {
  const skip = new Set(["node_modules", "dist", ".git", "coverage", "vendor", "参考"]);
  // 参考/ 是拷来研读的第三方项目，其内部文档链接不作为本仓库的链接健康承诺。
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) markdownFiles(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
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
