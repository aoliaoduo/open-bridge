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
import { listDirectory, searchFiles } from "../src/bridge/file-tools.js";

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

/**
 * The rows out of a result that now carries its truncation state alongside
 * them. Read through here rather than casting: a regression back to a bare
 * array (or to a differently named key) should fail loudly in these tests,
 * not silently turn every assertion below into "undefined !== expected".
 */
function rows<T>(result: unknown): T[] {
  assert.ok(result && typeof result === "object" && !Array.isArray(result),
    `expected a result object, got ${Array.isArray(result) ? "an array" : typeof result}`);
  const items = (result as { items?: unknown }).items;
  assert.ok(Array.isArray(items), "the result object must carry its rows under items");
  return items as T[];
}

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
  const hits = rows<Hit>(await searchFiles({ query: "alp|gam" }));
  assert.deepEqual(
    hits.map(h => `${h.path}:${h.line}`).sort(),
    ["a.txt:1", "a.txt:3", "sub/b.txt:1"],
  );
});

test("regex=false restores literal matching", async () => {
  const hits = rows<Hit>(await searchFiles({ query: "alp|gam", regex: false }));
  assert.equal(hits.length, 0);
});

test("a single-file path scans just that file", async () => {
  const hits = rows<Hit>(await searchFiles({ query: "beta", path: "sub/b.txt" }));
  assert.deepEqual(
    hits.map(h => `${h.path}:${h.line}`),
    ["sub/b.txt:1"],
  );
});

test("an invalid pattern fails loudly instead of answering empty", async () => {
  await assert.rejects(searchFiles({ query: "([" }));
});

test("look-around queries are answered, not lost to a backend that cannot parse them", async () => {
  // ripgrep's default engine refuses look-around (exit 2, "Consider enabling
  // PCRE2"), while a JavaScript RegExp — the semantics this tool documents — takes
  // it. Whether the call skips ripgrep up front (pattern detected) or falls back
  // after a failed spawn (not detected), the ANSWER must be identical; that is the
  // outcome that actually matters to the caller, so that is what this pins.
  const ahead = rows<Hit>(await searchFiles({ query: "alpha(?= beta)" }));
  assert.deepEqual(ahead.map(h => `${h.path}:${h.line}`), ["sub/b.txt:1"]);
  const behind = rows<Hit>(await searchFiles({ query: "(?<=alpha )beta" }));
  assert.deepEqual(behind.map(h => `${h.path}:${h.line}`), ["sub/b.txt:1"]);
});

/**
 * A negative max_results failed in two opposite directions depending on which
 * search path ran. Measured against this repo's own src/bridge before the fix:
 * max_results -1 returned 166 matches (ripgrep reads a negative --max-count as
 * "no limit") while -1000 returned 0 (the built-in scan compares
 * `out.length >= limit`, true from the first entry). One argument, one tool,
 * opposite answers -- and "0 results" is the dangerous one, because it reads
 * as "nothing matches" rather than "you passed something invalid".
 */
test("a negative max_results falls back to the default instead of meaning all or nothing", async () => {
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(path.join(dir, `hit-${i}.txt`), "needle here\n");
  }

  const negative = rows<Hit>(await searchFiles({ path: ".", query: "needle", max_results: -1 }));
  const alsoNegative = rows<Hit>(await searchFiles({ path: ".", query: "needle", max_results: -1000 }));

  // The point is not the exact count but that both negatives agree and that
  // neither collapsed to zero -- the caller asked for matches and there are 12.
  assert.equal(negative.length, alsoNegative.length, "-1 and -1000 must not disagree");
  assert.equal(negative.length, 12, "a nonsense limit must not hide real matches");

  // Zero stays meaningful: it is a real request for no rows, not a mistake.
  const zero = rows<Hit>(await searchFiles({ path: ".", query: "needle", max_results: 0 }));
  assert.equal(zero.length, 0, "0 still means 0");

  // And a sane limit is still honoured exactly.
  const three = rows<Hit>(await searchFiles({ path: ".", query: "needle", max_results: 3 }));
  assert.equal(three.length, 3);
});

/**
 * Same trap as max_results, found in the same sweep: Math.max(0, -5) is 0, so
 * a negative max_entries listed an empty directory. "There is nothing here"
 * and "that argument was nonsense" must not look identical -- the first gets
 * believed and acted on.
 */
test("a negative max_entries falls back to the default instead of listing nothing", async () => {
  for (let i = 0; i < 6; i += 1) {
    writeFileSync(path.join(dir, `entry-${i}.txt`), "x\n");
  }

  const negative = await listDirectory({ path: ".", max_entries: -5 });

  // The fixture dir carries files from the beforeEach setup too, so assert the
  // property that matters rather than an exact count: the six just written are
  // all present, i.e. nothing was hidden by the bad argument.
  const names = rows<{ name: string }>(negative).map(e => e.name);
  for (let i = 0; i < 6; i += 1) {
    assert.ok(names.includes("entry-" + i + ".txt"), "entry-" + i + ".txt must survive a nonsense cap");
  }

  // 0 is a real request for no rows and stays exactly that.
  const zero = await listDirectory({ path: ".", max_entries: 0 });
  assert.equal(rows(zero).length, 0, "0 still means 0");

  // A sane cap is still honoured.
  const two = await listDirectory({ path: ".", max_entries: 2 });
  assert.equal(rows(two).length, 2);
});
