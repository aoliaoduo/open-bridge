import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyPatch, patchTargetPaths } from "../src/mcp/patch.js";
import type { WorkspaceContext } from "../src/workspace/context.js";

/** Minimal unrestricted WorkspaceContext: behaves like the real anchor in unrestricted mode. */
function workspaceFor(root: string): WorkspaceContext {
  return {
    root: () => root,
    resolve: (input = ".") => path.resolve(root, input),
    resolveSecure: async (input = ".") => (path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input)),
    unrestricted: () => true,
    allowedRoots: () => [path.parse(root).root],
    assertAllowed: (full: string) => path.resolve(full),
  } as unknown as WorkspaceContext;
}

async function withSandbox(fn: (root: string, ws: WorkspaceContext) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "ob-patch-"));
  try {
    await fn(root, workspaceFor(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("update hunks with bare blank context lines apply (AI client regression)", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "notes.txt");
    await writeFile(file, "line one\n\nline three\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: notes.txt",
      "@@ -1,3 +1,4 @@",
      " line one",
      "",            // bare blank line — no leading space, as many AI clients emit
      "+inserted",
      " line three",
      "*** End Patch",
      "",
    ].join("\n");
    const { changed } = await applyPatch(patch, ws);
    assert.deepEqual(changed, ["notes.txt"]);
    assert.equal(await readFile(file, "utf8"), "line one\n\ninserted\nline three\n");
  }));

test("add file preserves blank added lines", () =>
  withSandbox(async (root, ws) => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+first",
      "+",
      "+third",
      "*** End Patch",
      "",
    ].join("\n");
    const { changed } = await applyPatch(patch, ws);
    assert.deepEqual(changed, ["new.txt"]);
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "first\n\nthird\n");
  }));

test("delete file removes the target", () =>
  withSandbox(async (root, ws) => {
    await writeFile(path.join(root, "gone.txt"), "x\n", "utf8");
    const patch = ["*** Begin Patch", "*** Delete File: gone.txt", "*** End Patch", ""].join("\n");
    const { changed } = await applyPatch(patch, ws);
    assert.deepEqual(changed, ["gone.txt"]);
    await assert.rejects(readFile(path.join(root, "gone.txt"), "utf8"));
  }));

test("classic unified diff with bare blank context lines applies", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "u.txt");
    await writeFile(file, "a\n\nb\n", "utf8");
    const patch = [
      "--- u.txt",
      "+++ u.txt",
      "@@ -1,3 +1,3 @@",
      " a",
      "",
      "-b",
      "+b2",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "a\n\nb2\n");
  }));

test("missing context still fails clearly", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "c.txt");
    await writeFile(file, "other content\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: c.txt",
      "@@ -1 +1 @@",
      "-never present",
      "+replacement",
      "*** End Patch",
      "",
    ].join("\n");
    await assert.rejects(applyPatch(patch, ws), /Patch context not found/);
  }));

test("hunk without @@ markers is rejected", () =>
  withSandbox(async (root, ws) => {
    await writeFile(path.join(root, "d.txt"), "x\n", "utf8");
    const patch = ["*** Begin Patch", "*** Update File: d.txt", "no hunks here", "*** End Patch", ""].join("\n");
    await assert.rejects(applyPatch(patch, ws), /no @@ hunk/);
  }));

test("invalid patch paths are rejected", () =>
  withSandbox(async (_root, ws) => {
    const patch = ["*** Begin Patch", "*** Add File: /dev/null", "+x", "*** End Patch", ""].join("\n");
    await assert.rejects(applyPatch(patch, ws), /invalid file path/);
  }));

test("update applies against a CRLF file using an LF patch (Windows regression)", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "win.txt");
    await writeFile(file, "line one\r\n\r\nline three\r\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: win.txt",
      "@@ -1,3 +1,4 @@",
      " line one",
      "",
      "+inserted",
      " line three",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    const result = await readFile(file, "utf8");
    // CRLF style is preserved on write.
    assert.equal(result, "line one\r\n\r\ninserted\r\nline three\r\n");
  }));

test("update preserves untouched lines byte-for-byte in a mixed-EOL file", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "mixed.txt");
    // CRLF-dominant file with two lone-LF lines; the patch only edits "three".
    await writeFile(file, "one\r\ntwo\nthree\r\nfour\nfive\r\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: mixed.txt",
      "@@",
      "-three",
      "+THREE",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    // Only the edited line changed (to the dominant CRLF); every untouched
    // line keeps its ORIGINAL ending. The old whole-file normalization rewrote
    // the lone-LF lines "two" and "four" to CRLF, producing phantom changes in
    // review diffs (apply_patch now matches edit_block's byte-preserving EOL
    // semantics).
    assert.equal(await readFile(file, "utf8"), "one\r\ntwo\nTHREE\r\nfour\nfive\r\n");
  }));

test("a no-op patch keeps a mixed-EOL file byte-identical", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "noop.txt");
    const raw = "a\r\nb\nc\r\n";
    await writeFile(file, raw, "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: noop.txt",
      "@@",
      "-b",
      "+b",
      "*** End Patch",
      "",
    ].join("\n");
    const { changes } = await applyPatch(patch, ws);
    // Nothing changed on disk (not even EOL normalization) and the reported
    // diff is empty — the old behavior rewrote every line to the dominant EOL.
    assert.equal(await readFile(file, "utf8"), raw);
    assert.equal(changes[0].additions, 0);
    assert.equal(changes[0].deletions, 0);
    assert.equal(changes[0].diff, "");
  }));

test("EOF deletion on a CRLF final line without trailing newline keeps the CRLF line", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "eofdel.txt");
    await writeFile(file, "a\r\nb", "utf8"); // final line has no terminator
    const patch = [
      "*** Begin Patch",
      "*** Update File: eofdel.txt",
      "@@ -2 +1 @@",
      "-b",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "a\r\n");
  }));

test("EOF insertion after a CRLF final line without trailing newline terminates it with CRLF", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "eofins.txt");
    await writeFile(file, "one\r\nlast", "utf8"); // final line has no terminator
    const patch = ["--- a/eofins.txt", "+++ b/eofins.txt", "@@ -2,0 +3,1 @@", "+appended", ""].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "one\r\nlast\r\nappended\r\n");
  }));

test("multiple Update blocks for the same file chain in memory (B-9 regression)", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "chain.txt");
    await writeFile(file, "aaa\nbbb\nccc\nddd\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: chain.txt",
      "@@",
      "-aaa",
      "+AAA",
      "*** Update File: chain.txt",
      "@@",
      "-ccc",
      "+CCC",
      "*** End Patch",
      "",
    ].join("\n");
    const { changed } = await applyPatch(patch, ws);
    assert.deepEqual(changed, ["chain.txt"]);
    assert.equal(await readFile(file, "utf8"), "AAA\nbbb\nCCC\nddd\n");
  }));

test("added lines keep $& and $' literally (String.replace $-sequence regression)", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "dollars.txt");
    await writeFile(file, "ctx\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: dollars.txt",
      "@@",
      " ctx",
      "+const sed = 's/a/$&/g';",
      "+const tpl = \"v: $'\";",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    // $& must not expand to the matched context block, $' must not splice in
    // the text after the match — the written lines are byte-for-byte literal.
    assert.equal(await readFile(file, "utf8"), "ctx\nconst sed = 's/a/$&/g';\nconst tpl = \"v: $'\";\n");
  }));

test("changes carry per-file additions/deletions and a display diff", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "report.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: report.txt",
      "@@",
      "-beta",
      "+BETA",
      "+delta",
      "*** End Patch",
      "",
    ].join("\n");
    const { changed, changes } = await applyPatch(patch, ws);
    assert.deepEqual(changed, ["report.txt"]);
    assert.equal(changes.length, 1);
    const change = changes[0];
    assert.equal(change.path, "report.txt");
    assert.equal(change.action, "update");
    assert.equal(change.additions, 2);
    assert.equal(change.deletions, 1);
    assert.match(change.diff, /^@@ -\d+,\d+ \+\d+,\d+ @@/);
    assert.ok(change.diff.includes("-beta"));
    assert.ok(change.diff.includes("+BETA"));
    assert.ok(change.diff.includes("+delta"));
    // The final file content matches the diff semantics.
    assert.equal(await readFile(file, "utf8"), "alpha\nBETA\ndelta\ngamma\n");
  }));

test("@@ coordinates pick the intended duplicate block instead of the first match", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "dup.txt");
    await writeFile(file, "AAA\nBBB\nAAA\nBBB\n", "utf8");
    // Two identical "AAA\\nBBB" blocks; the header targets the SECOND one.
    const patch = [
      "*** Begin Patch",
      "*** Update File: dup.txt",
      "@@ -3,2 +3,2 @@",
      " AAA",
      "-BBB",
      "+DDD",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    // The first block must stay untouched — the old parser ignored the
    // coordinates and silently edited the first occurrence.
    assert.equal(await readFile(file, "utf8"), "AAA\nBBB\nAAA\nDDD\n");
  }));

test("a duplicated block with no matching @@ target fails loudly instead of guessing", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "ambig.txt");
    await writeFile(file, "AAA\nBBB\nAAA\nBBB\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: ambig.txt",
      "@@ -9,2 +9,2 @@",
      " AAA",
      "-BBB",
      "+DDD",
      "*** End Patch",
      "",
    ].join("\n");
    await assert.rejects(applyPatch(patch, ws), /ambiguous/);
    // Nothing was written.
    assert.equal(await readFile(file, "utf8"), "AAA\nBBB\nAAA\nBBB\n");
  }));

test("context-free deletion hunk removes the whole line (no stray blank line)", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "del.txt");
    await writeFile(file, "a\nbbb\nc\n", "utf8");
    // The classic unified form of "delete this line" — no trailing context.
    const classic = ["--- a/del.txt", "+++ b/del.txt", "@@ -2 +2 @@", "-bbb", ""].join("\n");
    await applyPatch(classic, ws);
    assert.equal(await readFile(file, "utf8"), "a\nc\n");
  }));

test("context-free deletion of the final line keeps the file clean", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "tail.txt");
    await writeFile(file, "a\nb\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: tail.txt",
      "@@",
      "-b",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "a\n");
  }));

test("deletion hunk ending without context works in ShunCode form too", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "del2.txt");
    await writeFile(file, "a\nbbb\nc\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: del2.txt",
      "@@",
      "-bbb",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "a\nc\n");
  }));

test("pure insertion hunk does not fuse with the following line", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "ins.txt");
    await writeFile(file, "l1\nl2\nl3\n", "utf8");
    const patch = ["--- a/ins.txt", "+++ b/ins.txt", "@@ -1,0 +2,2 @@", "+NEW1", "+NEW2", ""].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "l1\nNEW1\nNEW2\nl2\nl3\n");
  }));

test("EOF insertion terminates the appended line (later appends stay whole)", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "eof.txt");
    await writeFile(file, "l1\nl2\n", "utf8");
    const patch = ["--- a/eof.txt", "+++ b/eof.txt", "@@ -2,0 +3,1 @@", "+l3", ""].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "l1\nl2\nl3\n");
    const again = ["--- a/eof.txt", "+++ b/eof.txt", "@@ -3,0 +4,1 @@", "+l4", ""].join("\n");
    await applyPatch(again, ws);
    assert.equal(await readFile(file, "utf8"), "l1\nl2\nl3\nl4\n");
  }));

test("two insertion hunks anchored at the same coordinate keep body order", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "same.txt");
    await writeFile(file, "x\n", "utf8");
    const patch = [
      "--- a/same.txt", "+++ b/same.txt",
      "@@ -1,0 +2,1 @@", "+A",
      "@@ -1,0 +3,1 @@", "+B",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "x\nA\nB\n");
  }));

test("two bare @@ insertion hunks append in body order (ShunCode EOF regression)", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "bare.txt");
    await writeFile(file, "keep\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: bare.txt",
      "@@",
      "+A",
      "@@",
      "+B",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "keep\nA\nB\n");
  }));

test("Add File over an existing file is rejected (no silent overwrite)", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "existing.txt");
    await writeFile(file, "precious content\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Add File: existing.txt",
      "+new stuff",
      "*** End Patch",
      "",
    ].join("\n");
    await assert.rejects(applyPatch(patch, ws), /already exists/);
    assert.equal(await readFile(file, "utf8"), "precious content\n");
  }));

test("Delete then Add in one patch recreates the file", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "swap.txt");
    await writeFile(file, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: swap.txt",
      "*** Add File: swap.txt",
      "+new",
      "*** End Patch",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "new\n");
  }));

// Ported from the throwaway `scripts/patch-check.mjs` probe: four shapes a real
// git diff produces that the unified-diff reader used to flatly reject.

test("a git no-newline marker diff applies on both sides", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "nonl.txt");
    await writeFile(file, "old", "utf8");
    const patch = [
      "--- a/nonl.txt",
      "+++ b/nonl.txt",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "new");
  }));

test("a unified diff deleting to /dev/null removes the file and keeps later sections", () =>
  withSandbox(async (root, ws) => {
    const gone = path.join(root, "gone.txt");
    const kept = path.join(root, "kept.txt");
    await writeFile(gone, "bye\n", "utf8");
    await writeFile(kept, "keep\nmore\n", "utf8");
    const patch = [
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "--- a/kept.txt",
      "+++ b/kept.txt",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-more",
      "+changed",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(existsSync(gone), false, "a deletion whose +++ is /dev/null must remove the file");
    assert.equal(await readFile(kept, "utf8"), "keep\nchanged\n");
  }));

test("an Add File section with no content creates an empty file", () =>
  withSandbox(async (root, ws) => {
    await applyPatch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch", ws);
    assert.equal((await stat(path.join(root, "empty.txt"))).size, 0);
  }));

test("a hunk body line starting with -- is content, not the next file header", () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "dashes.txt");
    await writeFile(file, "-- normal\n", "utf8");
    const patch = [
      "--- a/dashes.txt",
      "+++ b/dashes.txt",
      "@@ -1 +1 @@",
      "--- normal",
      "++ changed",
      "",
    ].join("\n");
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "+ changed\n");
  }));

test("block headers and applyPatch agree on b/-prefixed paths (lock key regression)", async () =>
  withSandbox(async (root, ws) => {
    // A repo that really has a b/ top-level directory. applyPatch edits
    // b/tools/x.ts (block mode never strips a/ or b/); patchTargetPaths used
    // to parse the same header in diff mode and lock tools/x.ts instead — the
    // write lock guarded the wrong file.
    const dir = path.join(root, "b", "tools");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "x.ts");
    await writeFile(file, "old\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: b/tools/x.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");
    const targets = await patchTargetPaths(patch, undefined, ws);
    assert.deepEqual(targets, [file], `the lock key must name the file applyPatch will edit: ${JSON.stringify(targets)}`);
    await applyPatch(patch, ws);
    assert.equal(await readFile(file, "utf8"), "new\n");
  }));

test("unified diff headers still strip a//b/ prefixes in the lock plan", async () =>
  withSandbox(async (root, ws) => {
    const file = path.join(root, "tools", "y.ts");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "old\n", "utf8");
    const patch = [
      "--- a/tools/y.ts",
      "+++ b/tools/y.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const targets = await patchTargetPaths(patch, undefined, ws);
    assert.deepEqual(targets, [file]);
  }));
