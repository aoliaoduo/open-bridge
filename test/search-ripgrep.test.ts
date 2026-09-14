import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildContext,
  normalizeRgPath,
  ripgrepAvailable,
  ripgrepPatternRejection,
  runRipgrep,
} from "../src/mcp/search-ripgrep.js";

/**
 * Repo root — the vendored ripgrep lives here, and this suite has to work on a
 * machine without `rg` on PATH. (test/*.ts sits outside tsconfig's include, so
 * nothing but the run itself would catch a typo'd name here.)
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ripgrepAvailable is false for a missing executable", async () => {
  assert.equal(await ripgrepAvailable(path.join(tmpdir(), "open-bridge-no-such-rg")), false);
});

test("runRipgrep rejects when the executable cannot be spawned", async () => {
  await assert.rejects(
    runRipgrep({ query: "x", cwd: tmpdir(), executable: path.join(tmpdir(), "open-bridge-no-such-rg") }),
  );
});

test("normalizeRgPath and buildContext are exact", () => {
  assert.equal(normalizeRgPath("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeRgPath(".\\src\\a.ts"), "src/a.ts");
  assert.deepEqual(buildContext(["a", "b", "HIT", "d", "e"], 2, 2), {
    context_before: [{ line: 1, text: "a" }, { line: 2, text: "b" }],
    context_after: [{ line: 4, text: "d" }, { line: 5, text: "e" }],
  });
  assert.deepEqual(buildContext(["only"], 0, 2).context_before, []);
});

test("runRipgrep parses matches, honors include globs and assembles context", async () => {
  if (!(await ripgrepAvailable("rg"))) {
    return; // environment without rg: the module-level path cannot run here
  }
  const dir = await mkdtemp(path.join(tmpdir(), "ob-rgmod-"));
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "a.ts"), "foo\nbar\nbaz\n", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "bar\n", "utf8");
    const result = await runRipgrep({
      query: "bar",
      cwd: dir,
      includeGlobs: ["**/*.ts"],
      regex: false,
      maxResults: 100,
      contextLines: 1,
      executable: "rg",
    });
    assert.equal(result.partial, false);
    assert.equal(result.matches.length, 1, JSON.stringify(result.matches));
    assert.equal(result.matches[0].path, "src/a.ts");
    assert.equal(result.matches[0].line, 2);
    assert.equal(result.matches[0].text, "bar");
    assert.deepEqual(result.matches[0].context_before, [{ line: 1, text: "foo" }]);
    assert.deepEqual(result.matches[0].context_after, [{ line: 3, text: "baz" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRipgrep stops early at maxResults instead of scanning everything", async () => {
  if (!(await ripgrepAvailable("rg"))) return;
  const dir = await mkdtemp(path.join(tmpdir(), "ob-rgcap-"));
  try {
    await writeFile(path.join(dir, "many.txt"), Array.from({ length: 600 }, () => "hit").join("\n") + "\n", "utf8");
    const result = await runRipgrep({ query: "hit", cwd: dir, maxResults: 10, executable: "rg" });
    assert.ok(result.matches.length <= 10, `capped at 10, got ${result.matches.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRipgrep throws loudly on an invalid pattern instead of answering empty", async () => {
  if (!(await ripgrepAvailable("rg"))) return;
  const dir = await mkdtemp(path.join(tmpdir(), "ob-rgbad-"));
  try {
    await writeFile(path.join(dir, "a.txt"), "hello\n", "utf8");
    await assert.rejects(
      runRipgrep({ query: "([", cwd: dir, regex: true, executable: "rg" }),
      /ripgrep failed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * ripgrepPatternRejection is the routing hint search_files uses to skip a spawn
 * that is guaranteed to exit 2. The two halves both matter: it must name what ripgrep
 * actually refuses (look-around, backreferences), and it must NOT flinch at constructs
 * ripgrep handles (alternation, named groups) — a false positive there quietly costs
 * the fast path on every ordinary search.
 */
test("ripgrepPatternRejection names the constructs ripgrep really refuses", async () => {
  const rg = await ripgrepAvailable("rg")
    ? "rg"
    : process.platform === "win32" ? path.join(root, "vendor", "rg.exe") : undefined;
  if (!rg) return; // no rg to disagree with: nothing to cross-check here

  const refused = ["alpha(?= beta)", "(?<=alpha )beta", "(a)\\1b"];
  const accepted = ["alp|gam", "(?<name>alpha)\\k<name>", "colou?r"];

  const dir = await mkdtemp(path.join(tmpdir(), "ob-rgdecl-"));
  try {
    await writeFile(path.join(dir, "a.txt"), "alpha alpha\n", "utf8");
    for (const query of refused) {
      assert.ok(ripgrepPatternRejection(query), `detector must decline: ${query}`);
      await assert.rejects(
        runRipgrep({ query, cwd: dir, regex: true, executable: rg }),
        /ripgrep failed/,
        `ripgrep must actually refuse: ${query}`,
      );
    }
    for (const query of accepted) {
      assert.equal(ripgrepPatternRejection(query), undefined, `detector must accept: ${query}`);
    }
    // Fixed-string searches never reach the engine at all, so nothing to decline.
    assert.ok((await runRipgrep({ query: "alpha(?= beta)", cwd: dir, regex: false, executable: rg })).matches.length === 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
