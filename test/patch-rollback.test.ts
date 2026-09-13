/**
 * `apply_patch` rollback when a patch fails partway through.
 *
 * Two bookkeeping defects lived here and neither had any test:
 *
 *  1. The rollback iterated only the files it had WRITTEN, so a file the patch
 *     had already DELETED was never restored — even though its pre-patch bytes
 *     were sitting in `originalContent` — while the thrown message claimed the
 *     files it had "already written" were restored. Silent, permanent data loss
 *     from a patch that reported an abort.
 *  2. "Did this file exist before?" was keyed on the file's LAST operation. The
 *     block grammar allows `*** Add File: x` followed by `*** Update File: x`,
 *     so collapapsing to one final action per file made that chain look like an
 *     update and the rollback wrote "" into a file the patch itself had created,
 *     leaving an empty file as the "restored" state.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyPatch } from "../src/mcp/patch.js";
import type { WorkspaceContext } from "../src/workspace/context.js";

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
  const root = await mkdtemp(path.join(tmpdir(), "ob-patch-rollback-"));
  try {
    await fn(root, workspaceFor(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Reports whether the path exists at all (not merely whether it is readable). */
async function exists(file: string): Promise<boolean> {
  return await stat(file).then(() => true, () => false);
}

test("a patch that fails after a delete puts the deleted file back", () =>
  withSandbox(async (root, ws) => {
    const doomed = path.join(root, "doomed.txt");
    const later = path.join(root, "later.txt");
    const DOOMED_BODY = "precious\ncontents\n";
    await writeFile(doomed, DOOMED_BODY, "utf8");
    await writeFile(later, "a\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Delete File: doomed.txt",
      "*** Update File: later.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "*** End Patch",
      "",
    ].join("\n");

    // The update of later.txt fails the way a locked file or a full disk does.
    // finalActions keeps first-seen order, so the unlink has already landed.
    await assert.rejects(
      applyPatch(patch, ws, {}, async file => {
        if (file === later) throw new Error("EBUSY: resource busy or locked");
        await writeFile(file, "unreachable", "utf8");
      }),
      /aborted partway/,
    );

    assert.equal(await exists(doomed), true, "the deleted file is back on disk");
    assert.equal(await readFile(doomed, "utf8"), DOOMED_BODY, "with its pre-patch bytes, not an empty file");
  }));

test("a patch that fails after a write restores the pre-patch bytes", () =>
  withSandbox(async (root, ws) => {
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    await writeFile(first, "original\n", "utf8");
    await writeFile(second, "untouched\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: first.txt",
      "@@ -1 +1 @@",
      "-original",
      "+rewritten",
      "*** Update File: second.txt",
      "@@ -1 +1 @@",
      "-untouched",
      "+changed",
      "*** End Patch",
      "",
    ].join("\n");

    await assert.rejects(
      applyPatch(patch, ws, {}, async file => {
        if (file === second) throw new Error("ENOSPC: no space left on device");
        await writeFile(file, (await readFile(file, "utf8")).replace("original", "rewritten"), "utf8");
      }),
      /aborted partway/,
    );

    assert.equal(await readFile(first, "utf8"), "original\n", "the first write was rolled back");
  }));

test("a block header path is literal, so a top-level b/ directory is reachable", () =>
  withSandbox(async (root, ws) => {
    // The block grammar adds no prefix, so `b/notes.txt` names that file. It used
    // to lose its first segment — the prefix strip meant for classic diffs — and
    // the patch silently rewrote the sibling `notes.txt` instead. A repo with a
    // top-level `a/` or `b/` directory (very common) was enough to hit this, and
    // for a Delete block it destroyed the wrong file.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "b"), { recursive: true });
    await writeFile(path.join(root, "notes.txt"), "top\n", "utf8");
    const nested = path.join(root, "b", "notes.txt");
    await writeFile(nested, "nested\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Update File: b/notes.txt",
      "@@ -1 +1 @@",
      "-nested",
      "+patched",
      "*** End Patch",
      "",
    ].join("\n");

    await applyPatch(patch, ws);

    assert.equal(await readFile(nested, "utf8"), "patched\n", "b/notes.txt is the file that changed");
    assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), "top\n", "notes.txt was left alone");
  }));

test("a classic diff strips exactly one a//b/ prefix", () =>
  withSandbox(async (root, ws) => {
    // `--- a/b/notes.txt` is the diff spelling of the repo path `b/notes.txt`.
    // Stripping twice reached `notes.txt`. `a/` here is diff metadata; the `b/`
    // after it is a real directory.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "b"), { recursive: true });
    await writeFile(path.join(root, "notes.txt"), "top\n", "utf8");
    const nested = path.join(root, "b", "notes.txt");
    await writeFile(nested, "nested\n", "utf8");

    const patch = ["--- a/b/notes.txt", "+++ b/b/notes.txt", "@@ -1 +1 @@", "-nested", "+patched", ""].join("\n");

    await applyPatch(patch, ws);

    assert.equal(await readFile(nested, "utf8"), "patched\n", "b/notes.txt is the file that changed");
    assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), "top\n", "notes.txt was left alone");
  }));

test("a block Delete names the file it spells", () =>
  withSandbox(async (root, ws) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "b"), { recursive: true });
    await writeFile(path.join(root, "b", "gone.txt"), "bye\n", "utf8");
    await writeFile(path.join(root, "gone.txt"), "keep me\n", "utf8");

    const patch = ["*** Begin Patch", "*** Delete File: b/gone.txt", "*** End Patch", ""].join("\n");

    await applyPatch(patch, ws);

    assert.equal(await exists(path.join(root, "b", "gone.txt")), false, "b/gone.txt was deleted");
    assert.equal(await exists(path.join(root, "gone.txt")), true, "the sibling gone.txt survived");
    assert.equal(await readFile(path.join(root, "gone.txt"), "utf8"), "keep me\n");
  }));

test("an Add-then-Update chain that fails leaves no empty file behind", () =>
  withSandbox(async (root, ws) => {
    const created = path.join(root, "brand-new.txt");
    const trigger = path.join(root, "trigger.txt");
    await writeFile(trigger, "x\n", "utf8");

    const patch = [
      "*** Begin Patch",
      "*** Add File: brand-new.txt",
      "+hello",
      "*** Update File: brand-new.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+goodbye",
      "*** Update File: trigger.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "*** End Patch",
      "",
    ].join("\n");

    await assert.rejects(
      applyPatch(patch, ws, {}, async file => {
        if (file === trigger) throw new Error("EBUSY: resource busy or locked");
        const previous = await readFile(file, "utf8").catch(() => "");
        await writeFile(file, previous === "hello\n" ? "goodbye\n" : "hello\n", "utf8");
      }),
      /aborted partway/,
    );

    assert.equal(
      await exists(created),
      false,
      "the file the patch itself created is removed, not left behind empty",
    );
  }));
