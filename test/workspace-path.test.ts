import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveFromWorkspace, isWithinAllowedRoots, resolveSecurePath, rejectSymlinkChain } from "../src/workspace/workspace-path.js";

// Platform-aware fixtures: `C:/...` is only absolute on Windows. On POSIX CI
// runners the same scenarios must use `/...` paths, otherwise "absolute"
// inputs silently degrade to workspace-relative ones and the tests fail for
// the wrong reason (ENOENT instead of the policy behavior under test).
const IS_WINDOWS = process.platform === "win32";
const WORKSPACE = IS_WINDOWS ? "C:/projects/current" : "/projects/current";
const SIBLING_DIR = IS_WINDOWS ? "C:/projects/currently" : "/projects/currently";
const OTHER_ABS = IS_WINDOWS ? "C:/other/data.txt" : "/other/data.txt";

test("relative paths remain anchored to the open workspace", () => {
  const workspace = path.resolve(WORKSPACE);
  assert.equal(resolveFromWorkspace(workspace, "src/index.ts"), path.join(workspace, "src", "index.ts"));
});

test("explicit absolute paths do not change the workspace anchor", () => {
  const workspace = path.resolve(WORKSPACE);
  assert.equal(resolveFromWorkspace(workspace, OTHER_ABS), path.resolve(OTHER_ABS));
  assert.equal(resolveFromWorkspace(workspace), workspace);
});

test("allowed root checks use path boundaries", () => {
  const root = path.resolve(WORKSPACE);
  assert.equal(isWithinAllowedRoots(path.join(root, "src"), [root]), true);
  assert.equal(isWithinAllowedRoots(path.resolve(SIBLING_DIR), [root]), false);
});

test("unrestricted secure resolution preserves explicit absolute paths", async () => {
  const workspace = path.resolve(WORKSPACE);
  assert.equal(await resolveSecurePath(workspace, OTHER_ABS, { unrestricted: true, allowedRoots: [workspace] }), path.resolve(OTHER_ABS));
});

test("restricted secure resolution rejects paths outside configured roots", async () => {
  const workspace = path.resolve(WORKSPACE);
  await assert.rejects(
    resolveSecurePath(workspace, OTHER_ABS, { unrestricted: false, allowedRoots: [workspace] }),
    /outside configured allowed directories/,
  );
});

/**
 * Create a directory link without elevation. Windows uses a junction (needs no
 * admin rights, unlike a real symlink); POSIX uses a plain dir symlink. Returns
 * false when the platform refuses, so callers can skip instead of failing.
 */
async function linkDir(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, IS_WINDOWS ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

test("rejectSymlinkChain rejects a symlink anywhere on the path", async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ob-symlink-"));
  try {
    const root = path.join(tmp, "root");
    const outside = path.join(tmp, "outside");
    await fs.mkdir(path.join(outside, "inner"), { recursive: true });
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    if (!(await linkDir(outside, path.join(root, "link")))) return t.skip("platform cannot create directory links");

    await assert.rejects(
      rejectSymlinkChain(path.join(root, "link", "inner", "file.txt"), {
        workspaceRoot: root, allowedRoots: [root], allowMissing: true,
      }),
      /Symbolic links are not allowed/,
    );
    // A clean path under the same root is allowed.
    await rejectSymlinkChain(path.join(root, "src", "file.txt"), {
      workspaceRoot: root, allowedRoots: [root], allowMissing: true,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("rejectSymlinkChain stops at the root even when a non-canonical entry is configured", async t => {
  // Regression guard for the resolved-roots fix: allowedRoots used to be
  // compared raw, so an entry with a trailing separator never matched the
  // walked path and the loop kept climbing past the root — here it would
  // inspect (and reject) the symlinked ancestor *above* the configured root.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ob-root-stop-"));
  try {
    const realParent = path.join(tmp, "real");
    await fs.mkdir(path.join(realParent, "proj"), { recursive: true });
    if (!(await linkDir(realParent, path.join(tmp, "linked")))) return t.skip("platform cannot create directory links");

    const rootUnderLink = path.join(tmp, "linked", "proj");
    await rejectSymlinkChain(path.join(rootUnderLink, "file.txt"), {
      workspaceRoot: rootUnderLink,
      allowedRoots: [`${rootUnderLink}${path.sep}`],
      allowMissing: true,
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
