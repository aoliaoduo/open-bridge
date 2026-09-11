/**
 * `npm run build:core` used to delete `dist/ui` along with everything else.
 * A live instance serves `/console` out of `dist/ui` per request, so that build
 * silently took the console away from whoever was running it — the panel
 * answered `{"error":"Console UI is not built..."}` with no hint as to why.
 * The core scope keeps the vite bundle; the full build still removes it and
 * rebuilds it in the same command.
 */
import assert from "node:assert/strict";
import {test} from "node:test";
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {cleanDist} from "../scripts/clean.mjs";

/** A throwaway dist: the vite output plus two files tsc produces. */
function scratch() {
  const root = mkdtempSync(path.join(tmpdir(), "ob-clean-"));
  mkdirSync(path.join(root, "dist", "ui", "assets"), {recursive: true});
  mkdirSync(path.join(root, "dist", "bridge"), {recursive: true});
  writeFileSync(path.join(root, "dist", "ui", "index.html"), "<!doctype html>");
  writeFileSync(path.join(root, "dist", "cli.js"), "// cli");
  writeFileSync(path.join(root, "dist", "bridge", "state.js"), "// state");
  return root;
}

test("the core scope keeps the console bundle and still removes stale core output", async () => {
  const root = scratch();
  try {
    const removed = await cleanDist(root, "core");
    assert.deepEqual(removed.sort(), ["bridge", "cli.js"]);
    assert.equal(existsSync(path.join(root, "dist", "ui", "index.html")), true, "the vite bundle survives");
    assert.equal(existsSync(path.join(root, "dist", "bridge")), false, "stale core output goes");
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("the full scope removes the console bundle too", async () => {
  const root = scratch();
  try {
    await cleanDist(root, "all");
    assert.equal(existsSync(path.join(root, "dist", "ui")), false);
    assert.equal(existsSync(path.join(root, "dist", "cli.js")), false);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test("nothing to clean is not an error", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ob-clean-"));
  try {
    assert.deepEqual(await cleanDist(root, "core"), []);
    assert.deepEqual(await cleanDist(root, "all"), []);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
