import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FILE_LOG_MAX_BYTES, FileLog } from "../src/host/node-host.js";

/** One line of the shape the bridge writes, padded so a test can fill a file fast. */
const line = (index: number): string => `line ${index} ${"x".repeat(40)}`;

async function linesOf(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8")).split("\n").filter(text => text.length > 0);
  } catch {
    return [];
  }
}

const indicesOf = (lines: string[]): number[] =>
  lines.map(text => Number(/^\[[^\]]+\] line (\d+) /.exec(text)?.[1] ?? NaN));

test("bridge.log rotates to one previous generation at the cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ob-filelog-"));
  try {
    const log = new FileLog(dir, { maxBytes: 700 });
    const total = 60;
    for (let index = 0; index < total; index += 1) log.write(line(index));
    await log.flush();

    assert.equal(log.path(), path.join(dir, "bridge.log"));
    assert.deepEqual((await readdir(dir)).sort(), ["bridge.log", "bridge.log.1"],
      "exactly one previous generation, nothing else");

    assert.ok(Buffer.byteLength(await readFile(log.path(), "utf8"), "utf8") <= 700 + 64,
      "the live file stays near the cap");

    const seen = [...indicesOf(await linesOf(`${log.path()}.1`)), ...indicesOf(await linesOf(log.path()))];
    assert.ok(seen.every(Number.isInteger), "every surviving line is intact");
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "order survives the rename");
    assert.equal(new Set(seen).size, seen.length, "no line is duplicated by a rotation");
    assert.equal(seen[seen.length - 1], total - 1, "the newest line is in the live file");
    assert.ok(seen.length < total, "older generations are dropped, that is the point");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maxBytes 0 disables rotation and keeps accepting lines", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ob-filelog-off-"));
  try {
    const log = new FileLog(dir, { maxBytes: 0 });
    for (let index = 0; index < 40; index += 1) log.write(line(index));
    await log.flush();

    assert.deepEqual((await readdir(dir)).sort(), ["bridge.log"]);
    assert.equal((await linesOf(log.path())).length, 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listeners keep receiving stamped lines across rotations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ob-filelog-tail-"));
  try {
    const seen: string[] = [];
    const log = new FileLog(dir, { maxBytes: 700 });
    const stop = log.onLine(text => seen.push(text));
    for (let index = 0; index < 30; index += 1) log.write(line(index));
    await log.flush();
    stop();

    assert.equal(seen.length, 30, "every write reached the live stream");
    assert.match(seen[0], /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] line 0 /);
    assert.match(seen[29], /line 29 /);
    // The stream is live data, not a file read: rotated-away lines were still seen.
    assert.equal((await readdir(dir)).filter(name => name.startsWith("bridge.log")).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the documented default cap is a positive number", () => {
  assert.equal(FILE_LOG_MAX_BYTES, 10 * 1024 * 1024);
});

test("a rotation that fails is skipped, never a truncation", async () => {
  // The previous fallback on a failed rename was writeFile(file, "") — which
  // destroyed exactly the history the rotation was supposed to keep. A
  // directory at the .1 path makes rename() fail everywhere, the same shape as
  // another instance holding the file open on Windows.
  const dir = await mkdtemp(path.join(tmpdir(), "ob-filelog-fail-"));
  try {
    await mkdir(`${path.join(dir, "bridge.log")}.1`, { recursive: true });
    const log = new FileLog(dir, { maxBytes: 400 });
    for (let index = 0; index < 40; index += 1) log.write(line(index));
    await log.flush();

    const lines = await linesOf(log.path());
    assert.equal(lines.length, 40, "no line was lost to a failed rotation");
    assert.ok(Buffer.byteLength(lines.join("\n"), "utf8") > 400, "the live file exceeded the cap instead");
    assert.deepEqual(indicesOf(lines), [...Array(40).keys()], "order and content are intact, oldest first");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
