import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { projectBuildRequired } from "../scripts/windows/launcher-build.mjs";

function file(root, relative, seconds) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, relative);
  utimesSync(target, seconds, seconds);
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ob-launch-build-"));
  file(root, "src/cli.ts", 10);
  file(root, "ui/src/App.tsx", 10);
  file(root, "ui/src/App.test.tsx", 10);
  file(root, "ui/console.html", 10);
  file(root, "config/vite.config.ts", 10);
  file(root, "tsconfig.json", 10);
  file(root, "tsconfig.ui.json", 10);
  file(root, "package.json", 10);
  file(root, "dist/cli.js", 20);
  file(root, "dist/ui/console.html", 20);
  return root;
}

test("a fresh project build does not need to be rewritten just to restart", () => {
  const root = fixture();
  try {
    assert.equal(projectBuildRequired(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new core or UI build inputs require a rebuild", () => {
  const root = fixture();
  try {
    file(root, "src/bridge/new-feature.ts", 30);
    assert.equal(projectBuildRequired(root), true);

    rmSync(path.join(root, "src", "bridge"), { recursive: true, force: true });
    assert.equal(projectBuildRequired(root), false);

    file(root, "ui/src/new-panel.tsx", 30);
    assert.equal(projectBuildRequired(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UI test-only edits do not rebuild the production launcher", () => {
  const root = fixture();
  try {
    file(root, "ui/src/App.test.tsx", 30);
    assert.equal(projectBuildRequired(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing core or UI output always requires a build", () => {
  const root = fixture();
  try {
    rmSync(path.join(root, "dist", "cli.js"));
    assert.equal(projectBuildRequired(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
