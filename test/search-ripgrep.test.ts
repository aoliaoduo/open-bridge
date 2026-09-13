import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildContext,
  normalizeRgPath,
  ripgrepAvailable,
  runRipgrep,
} from "../src/mcp/search-ripgrep.js";

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
