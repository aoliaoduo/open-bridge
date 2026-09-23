import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHost, type Host } from "../src/host/host.js";
import { readFiles } from "../src/bridge/tools/file-tools.js";

let dir: string;

function memoryHost(): Host {
  return {
    config: { get: <T>(...args: [string, T]): T => args[1], update: async (): Promise<void> => undefined },
    secrets: { get: async (): Promise<string | undefined> => undefined, store: async (): Promise<void> => undefined },
    state: { get: <T>(_key: string, fallback: T): T => fallback, update: async (): Promise<void> => undefined },
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
  dir = mkdtempSync(path.join(tmpdir(), "ob-read-page-"));
  writeFileSync(path.join(dir, "bytes.bin"), "0123456789", "utf8");
  writeFileSync(path.join(dir, "lines.txt"), "one\ntwo\nthree\n", "utf8");
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

type Row = {
  content: string;
  encoding: "utf8" | "base64";
  truncated: boolean;
  offset?: number;
  next_offset?: number | null;
  next_start_line?: number | null;
  lines_total?: number | null;
};

async function row(args: Record<string, unknown>): Promise<Row> {
  const result = await readFiles(args) as Array<Row>;
  assert.equal(result.length, 1);
  return result[0]!;
}

test("read_files gives binary pages a byte cursor that can recover every byte", async () => {
  const first = await row({ paths: ["bytes.bin"], encoding: "base64", max_bytes: 4 });
  assert.equal(first.encoding, "base64");
  assert.equal(Buffer.from(first.content, "base64").toString("utf8"), "0123");
  assert.equal(first.offset, 0);
  assert.equal(first.truncated, true);
  assert.equal(first.next_offset, 4);

  const second = await row({ paths: ["bytes.bin"], encoding: "base64", offset: first.next_offset, max_bytes: 4 });
  assert.equal(Buffer.from(second.content, "base64").toString("utf8"), "4567");
  assert.equal(second.offset, 4);
  assert.equal(second.next_offset, 8);

  const last = await row({ paths: ["bytes.bin"], encoding: "base64", offset: second.next_offset, max_bytes: 4 });
  assert.equal(Buffer.from(last.content, "base64").toString("utf8"), "89");
  assert.equal(last.truncated, false);
  assert.equal(last.next_offset, null);
});

test("read_files gives newline-ended text pages a safe line continuation", async () => {
  const first = await row({ paths: ["lines.txt"], max_bytes: 8 });
  assert.equal(first.encoding, "utf8");
  assert.equal(first.content, "one\ntwo\n");
  assert.equal(first.truncated, true);
  assert.equal(first.next_start_line, 3);

  const last = await row({ paths: ["lines.txt"], start_line: first.next_start_line, max_bytes: 8 });
  assert.equal(last.content, "three\n");
  assert.equal(last.lines_total, 3);
  assert.equal(last.next_start_line, null, "a terminal range must not advertise a looping cursor");
});
