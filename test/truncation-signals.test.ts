/**
 * A capped listing has to say that it was capped.
 *
 * Measured against the live Bridge before this change: a directory holding 12
 * files answered `max_entries: 3` with three entries and nothing else — no
 * truncated flag, no total, and no way to ask for the rest. The caller (usually
 * a model) could not tell "this directory has three files" from "this directory
 * has 500 and you are holding the first three", and those two lead to opposite
 * actions: stop, or keep looking. `read_files` / `run_command` /
 * `read_process_output` all report `truncated` for exactly this reason; the
 * three listing tools said nothing.
 *
 * The fix is not a bigger default cap — any cap silently becomes an answer
 * about the world. It is reporting the cap, and (for the flat case) handing
 * back the offset that continues the survey.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHost, type Host } from "../src/host/host.js";
import { listDirectory, findFiles, searchFiles } from "../src/bridge/file-tools.js";

interface Listing {
  items: Array<{ name: string; type: string; children?: Listing["items"] }>;
  truncated: boolean;
  total: number | null;
  next_offset: number | null;
}
interface Matches {
  items: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
  partial: boolean;
}
interface Found {
  items: string[];
  truncated: boolean;
}

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

setHost(memoryHost());

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ob-trunc-"));
  for (let i = 1; i <= 12; i += 1) {
    writeFileSync(path.join(dir, `file${String(i).padStart(2, "0")}.txt`), `needle ${i}\n`, "utf8");
  }
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  writeFileSync(path.join(dir, "sub", "nested.txt"), "needle nested\n", "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("list_directory reports the cap, the true total and the offset that continues", async () => {
  const page = (await listDirectory({ path: ".", max_entries: 3 })) as unknown as Listing;
  assert.equal(page.items.length, 3);
  assert.equal(page.truncated, true, "13 entries were listed into a cap of 3 — the result must say so");
  assert.equal(page.total, 13, "the flat total is knowable for free: readdir already returned every entry");
  assert.equal(page.next_offset, 3, "and the caller gets the offset that picks up where this page stopped");

  const next = (await listDirectory({ path: ".", max_entries: 3, offset: 3 })) as unknown as Listing;
  assert.equal(next.items.length, 3);
  assert.equal(next.truncated, true);
  // The two pages must not overlap: that is the whole point of next_offset.
  const firstNames = page.items.map(item => item.name);
  const overlap = next.items.filter(item => firstNames.includes(item.name));
  assert.deepEqual(overlap, [], "paging must not repeat entries from the previous page");
  assert.equal(next.next_offset, 6, "the third page starts where this one stopped");
});

test("a zero-sized directory page reports its flat total without a looping cursor", async () => {
  const zero = (await listDirectory({ path: ".", max_entries: 0 })) as unknown as Listing;
  assert.deepEqual(zero.items, []);
  assert.equal(zero.total, 13, "the one flat directory read can still report its exact total");
  assert.equal(zero.truncated, true);
  assert.equal(zero.next_offset, null, "an empty page cannot safely advance its cursor");
});

test("list_directory orders flat pages by name so their cursor stays stable", async () => {
  const ordered = path.join(dir, "ordered");
  mkdirSync(ordered);
  // Create them in the opposite order. The visible order is a tool contract,
  // not an accident of the filesystem's insertion order.
  writeFileSync(path.join(ordered, "z-last.txt"), "z", "utf8");
  writeFileSync(path.join(ordered, "a-first.txt"), "a", "utf8");

  const first = (await listDirectory({ path: "ordered", max_entries: 1 })) as unknown as Listing;
  assert.deepEqual(first.items.map(item => item.name), ["a-first.txt"]);
  assert.equal(first.next_offset, 1);

  const second = (await listDirectory({ path: "ordered", max_entries: 1, offset: first.next_offset! })) as unknown as Listing;
  assert.deepEqual(second.items.map(item => item.name), ["z-last.txt"]);
  assert.equal(second.next_offset, null);
});

test("an uncapped listing is not marked truncated, and says there is nothing more", async () => {
  const all = (await listDirectory({ path: "." })) as unknown as Listing;
  assert.equal(all.items.length, 13);
  assert.equal(all.truncated, false);
  assert.equal(all.total, 13);
  assert.equal(all.next_offset, null, "no next page exists");
});

test("a depth>1 listing still reports truncation, without inventing a total", async () => {
  const deep = (await listDirectory({ path: ".", depth: 2, max_entries: 4 })) as unknown as Listing;
  assert.equal(deep.truncated, true, "the shared budget cut the tree short");
  assert.equal(deep.total, null, "counting the whole tree is what max_entries exists to avoid");
  assert.equal(deep.next_offset, null, "paging a recursive listing is not a thing this tool offers");
});

test("find_files reports the cap instead of answering with a short list", async () => {
  const capped = (await findFiles({ pattern: "*.txt", max_results: 3 })) as unknown as Found;
  assert.equal(capped.items.length, 3);
  assert.equal(capped.truncated, true, "13 files matched a cap of 3");

  const full = (await findFiles({ pattern: "*.txt", max_results: 50 })) as unknown as Found;
  assert.equal(full.items.length, 13);
  assert.equal(full.truncated, false);
});

test("search_files reports the cap, and offset paging stays exact", async () => {
  const capped = (await searchFiles({ query: "needle", max_results: 3 })) as unknown as Matches;
  assert.equal(capped.items.length, 3);
  assert.equal(capped.truncated, true, "13 matches hit a cap of 3");

  const full = (await searchFiles({ query: "needle", max_results: 50 })) as unknown as Matches;
  assert.equal(full.items.length, 13);
  assert.equal(full.truncated, false, "nothing was dropped, so nothing is claimed to be dropped");

  // The last page of a paged scan is the one where the cap and the data meet:
  // 13 matches, 4 per page, so page 4 holds one match and must NOT be called
  // truncated just because the cap was not filled.
  const last = (await searchFiles({ query: "needle", max_results: 4, offset: 12 })) as unknown as Matches;
  assert.equal(last.items.length, 1);
  assert.equal(last.truncated, false, "a partially filled final page is complete");
  for (const page of [capped, full, last]) {
    assert.equal(page.partial, false, "a normally readable search is exhaustive even when its page is capped");
  }
});
