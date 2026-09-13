/**
 * search_files behavior pins: the query is a regex by default, literal is
 * opt-in, a single-file path scans just that file, and an invalid pattern
 * fails loudly instead of answering empty.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHost, type Host } from "../src/host/host.js";
import { searchFiles } from "../src/bridge/file-tools.js";

let dir: string;

function memoryHost(): Host {
  return {
    config: {
      get: <T>(...args: [string, T]): T => args[1],
      update: async (): Promise<void> => undefined,
    },
    secrets: {
      get: async (): Promise<string | undefined> => undefined,
      store: async (): Promise<void> => undefined,
    },
    state: {
      get: <T>(_key: string, fallback: T): T => fallback,
      update: async (): Promise<void> => undefined,
    },
    storageDir: () => "",
    version: () => "test",
    bundledRipgrep: () => undefined,
    projectRoot: () => dir,
    notify: (): void => undefined,
    log: (): void => undefined,
    ui: { update: (): void => undefined, refresh: (): void => undefined },
  };
}

// Unit-test files run in their own process, so installing a memory host here
// cannot leak into any other file's tests.
setHost(memoryHost());

type Hit = { path: string; line: number; text: string };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ob-searchdef-"));
  writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  writeFileSync(path.join(dir, "sub", "b.txt"), "alpha beta\n", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("query is a regex by default", async () => {
  const hits = (await searchFiles({ query: "alp|gam" })) as Hit[];
  assert.deepEqual(
    hits.map(h => `${h.path}:${h.line}`).sort(),
    ["a.txt:1", "a.txt:3", "sub/b.txt:1"],
  );
});

test("regex=false restores literal matching", async () => {
  const hits = (await searchFiles({ query: "alp|gam", regex: false })) as Hit[];
  assert.equal(hits.length, 0);
});

test("a single-file path scans just that file", async () => {
  const hits = (await searchFiles({ query: "beta", path: "sub/b.txt" })) as Hit[];
  assert.deepEqual(
    hits.map(h => `${h.path}:${h.line}`),
    ["sub/b.txt:1"],
  );
});

test("an invalid pattern fails loudly instead of answering empty", async () => {
  await assert.rejects(searchFiles({ query: "([" }));
});
