/**
 * SharedJsonStore's cross-process contract. One data dir is common to all
 * instances, so the lock-merge inside write() is the moment another
 * instance's committed keys must survive — the stale-memory-before-disk
 * merge order silently rolled them back, and a failed update left its key
 * in memory to ride the next successful write.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost } from "../src/host/node-host.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-shared-store-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const statePath = (): string => path.join(home, "state.json");
const configPath = (): string => path.join(home, "config.json");

test("a write inside the lock does not roll back another instance's committed key", { timeout: 30_000 }, async () => {
  // Instance B loads {k:"v0"}; instance A then commits {k:"v1", other:"x"} to
  // disk with an mtime no later than B's load (the reload() fast path skips
  // same-millisecond writes, exactly as when both instances write in the same
  // millisecond). B's write must still pick A's key up from the disk it
  // re-reads INSIDE the lock: memory must not shadow what just landed.
  writeFileSync(statePath(), JSON.stringify({ k: "v0" }));
  const { host } = installNodeHost({ homeDir: home, version: "test" });
  const loadedMtime = statSync(statePath()).mtimeMs;
  writeFileSync(statePath(), JSON.stringify({ k: "v1", other: "x" }));
  utimesSync(statePath(), new Date(loadedMtime), new Date(loadedMtime));

  await host.state.update("b", "bb");

  const disk = JSON.parse(readFileSync(statePath(), "utf8")) as { k?: string; other?: string; b?: string };
  assert.equal(disk.k, "v1", "the other instance's committed value survives the merge");
  assert.equal(disk.other, "x");
  assert.equal(disk.b, "bb");
});

test("a failed update does not leave its key in memory to ride the next write", { timeout: 30_000 }, async () => {
  // Hold the file lock the way a wedged peer would: a lock file with a fresh
  // mtime and an owner that is not ours. The update must refuse — and must
  // not leave "phantom" in memory, where the NEXT successful write would
  // publish a value the operator believes was refused.
  writeFileSync(statePath(), JSON.stringify({}));
  const { host } = installNodeHost({ homeDir: home, version: "test" });
  writeFileSync(`${statePath()}.lock`, "someone-else");
  await assert.rejects(host.state.update("phantom", "x"), /not saved/);
  rmSync(`${statePath()}.lock`, { force: true }); // the holder exits

  await host.state.update("real", "y");

  const disk = JSON.parse(readFileSync(statePath(), "utf8")) as { phantom?: string; real?: string };
  assert.equal(disk.phantom, undefined, "a refused key must not ride a later write");
  assert.equal(disk.real, "y");
});

test("a hand-edited config.json with a UTF-8 BOM still yields its values", () => {
  // PowerShell 5.1's `Set-Content -Encoding UTF8` and old Notepad write a
  // BOM; JSON.parse refuses the whole file and every setting silently fell
  // back to its default — auth.enabled included.
  writeFileSync(configPath(), "\uFEFF" + JSON.stringify({ port: 8123 }), "utf8");
  const { host } = installNodeHost({ homeDir: home, version: "test" });
  assert.equal(host.config.get("port", 0), 8123);
});
