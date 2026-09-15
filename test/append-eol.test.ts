/**
 * Appending to a file has to write the line endings that file already uses.
 *
 * Measured before this fix: a CRLF file `p1\r\np2\r\n` plus `write_file{mode:
 * "append", content: "p3\n"}` produced the bytes `70 31 0d 0a 70 32 0d 0a 70 33
 * 0a` — two CRLF lines and a stray LF one. `edit_block` and `apply_patch` already
 * preserved the file's style (they run through detectEol/applyEol); the append
 * branch handed the caller's bytes straight to `fs.appendFile`. A Windows
 * checkout that gets appended to over a session therefore drifts into mixed
 * endings, and every later diff or lint of that file is noise.
 *
 * The rule is: the caller says WHAT to append, the file says how its lines end.
 * Nothing already on disk is rewritten — only the appended text is normalized.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHost, type Host } from "../src/host/host.js";
import { writeFile } from "../src/bridge/file-tools.js";

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
  dir = mkdtempSync(path.join(tmpdir(), "ob-append-eol-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const bytesOf = (file: string): string => readFileSync(path.join(dir, file)).toString("latin1");

test("appending to a CRLF file writes CRLF", async () => {
  writeFileSync(path.join(dir, "win.log"), "p1\r\np2\r\n", "utf8");
  await writeFile({ path: "win.log", mode: "append", content: "p3\n" });
  assert.equal(bytesOf("win.log"), "p1\r\np2\r\np3\r\n",
    "the appended line has to end the way the file already does");

  // Several lines at once, and a mix of styles in the input: the file decides.
  await writeFile({ path: "win.log", mode: "append", content: "p4\np5\r\n" });
  assert.equal(bytesOf("win.log"), "p1\r\np2\r\np3\r\np4\r\np5\r\n");
});

test("appending to an LF file writes LF", async () => {
  writeFileSync(path.join(dir, "nix.log"), "p1\np2\n", "utf8");
  await writeFile({ path: "nix.log", mode: "append", content: "p3\r\n" });
  assert.equal(bytesOf("nix.log"), "p1\np2\np3\n",
    "\"match the file\" cannot mean \"always CRLF\": the file here is LF");
});

test("a file with no line endings yet is left alone", async () => {
  // Nothing to match, so nothing is rewritten: the caller's bytes are the file.
  await writeFile({ path: "fresh.txt", mode: "append", content: "a\nb\r\n" });
  assert.equal(bytesOf("fresh.txt"), "a\nb\r\n");
});

test("a file bigger than the sampling window still matches", async () => {
  // The style is read from a bounded tail, not the whole file: append targets
  // are logs, and reading 400 KB to write 5 bytes would make every append
  // O(file size). The answer has to stay right anyway.
  const line = "2026-09-15 00:00:00 something happened\r\n";
  const existing = line.repeat(Math.ceil((400 * 1024) / line.length));
  writeFileSync(path.join(dir, "big.log"), existing, "utf8");
  await writeFile({ path: "big.log", mode: "append", content: "tail\n" });
  const after = bytesOf("big.log");
  assert.ok(after.startsWith(existing), "everything that was there is still there");
  assert.ok(after.endsWith("tail\r\n"), "the appended line still matches the file");
});

test("the reported byte count is what was actually written", async () => {
  writeFileSync(path.join(dir, "count.log"), "x\r\n", "utf8");
  const result = await writeFile({ path: "count.log", mode: "append", content: "y\n" }) as { bytes: number };
  assert.equal(result.bytes, 3, "\"y\" plus CRLF, not the 2 bytes that were handed in");
  assert.equal(readFileSync(path.join(dir, "count.log"), "utf8"), "x\r\ny\r\n");
});

test("a base64 append stays byte-exact: that path is for binary", async () => {
  // Deliberately NOT normalized. content_base64 is how a caller writes bytes
  // that are not text, and rewriting its line endings would corrupt it.
  writeFileSync(path.join(dir, "bin.dat"), "p1\r\n", "utf8");
  const payload = Buffer.from("x\r\ny", "utf8").toString("base64");
  await writeFile({ path: "bin.dat", mode: "append", content_base64: payload });
  assert.equal(bytesOf("bin.dat"), "p1\r\nx\r\ny");
});
