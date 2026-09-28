import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  legacyRuntimePath,
  readRuntime,
  resolveInstance,
  runtimePath,
} from "../src/cli/registry.js";

function runtime(root: string, port: number) {
  return {
    pid: process.pid,
    port,
    root,
    startedAt: new Date().toISOString(),
  };
}

test("legacy runtime.json remains usable and its compatibility path is visible", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ob-registry-legacy-"));
  const root = mkdtempSync(path.join(tmpdir(), "ob-registry-root-"));
  try {
    writeFileSync(legacyRuntimePath(home), JSON.stringify(runtime(root, 8123)));
    assert.equal(readRuntime(home, root)?.port, 8123);

    const resolved = resolveInstance(home, root);
    assert.equal(resolved.runtime?.port, 8123);
    assert.match(resolved.note ?? "", /legacy runtime\.json|旧版 runtime\.json/i,
      "using the old registry format must be observable without breaking it");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the per-workspace runtime record wins silently over the legacy fallback", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ob-registry-modern-"));
  const root = mkdtempSync(path.join(tmpdir(), "ob-registry-root-"));
  try {
    writeFileSync(legacyRuntimePath(home), JSON.stringify(runtime(root, 8123)));
    writeFileSync(runtimePath(home, root), JSON.stringify(runtime(root, 9123)));

    const resolved = resolveInstance(home, root);
    assert.equal(resolved.runtime?.port, 9123);
    assert.equal(resolved.note, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
