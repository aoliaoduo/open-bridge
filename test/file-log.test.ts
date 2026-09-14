import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FILE_LOG_MAX_BYTES, FileLog, localLogStamp, localUtcOffset,
  normalizeTimezone as localNormalize,
} from "../src/host/node-host.js";

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

/**
 * The log-line prefix is for a human reading the console, so it carries LOCAL
 * wall-clock time, not `toISOString()`'s Z. This was a real report: an operator
 * in UTC+8 saw every line eight hours behind the action that produced it.
 *
 * The assertions are timezone-independent on purpose — they compare against the
 * same Date's own local fields, so this passes on a CI runner in UTC and on the
 * author's machine in UTC+8. Asserting a literal "20:02" would just be a test
 * that fails everywhere except one desk.
 */
test("log lines are stamped in local wall-clock time, never UTC Z", () => {
  const at = new Date(2026, 8, 14, 20, 2, 43, 248); // local 2026-09-14 20:02:43.248
  const stamp = localLogStamp(at);

  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
    "shape is 'YYYY-MM-DD HH:mm:ss.mmm'");
  assert.ok(!stamp.endsWith("Z"), "a Z suffix would mean UTC, which is the bug");

  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  assert.equal(stamp,
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`,
    "the printed clock is this machine's wall clock");
});

/**
 * The offset used to ride along on every log line, where it was the same
 * eleven characters thousands of times over. It is gone from the prefix and
 * kept as its own function, because `doctor` still has to state which zone the
 * process resolved — there it is the answer, not decoration.
 */
test("the stamp carries no UTC offset, but doctor can still ask for one", () => {
  const at = new Date(2026, 8, 14, 20, 2, 43, 248);
  assert.doesNotMatch(localLogStamp(at), /[+-]\d{2}:\d{2}$/,
    "an offset on every line is noise: the reader is sitting in that zone");

  // Sign is the human convention, not getTimezoneOffset()'s: UTC+8 prints
  // "+08:00" even though the method reports -480 minutes.
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, "0");
  const offsetMinutes = -at.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  assert.equal(localUtcOffset(at),
    `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`,
    "offset sign and value match the environment");
});

/**
 * These run in whatever zone the suite was started in, so they assert the
 * decision (map / refuse) rather than a resulting wall-clock time. The guard
 * that matters: normalizeTimezone only ever acts on an already-broken zone, so
 * on a healthy machine it must be a no-op — which is exactly what it is here,
 * since the suite's own zone resolves fine.
 */
test("normalizeTimezone leaves a working environment completely alone", () => {
  const before = process.env.TZ;
  try {
    // A zone that resolves: there is nothing to repair, whatever TZ says.
    const env = { TZ: "CST-8" };
    const healthy = Intl.DateTimeFormat().resolvedOptions().timeZone !== "Etc/Unknown";
    const result = localNormalize(env);
    if (healthy) {
      assert.equal(result, undefined, "a resolvable zone is never second-guessed");
      assert.equal(env.TZ, "CST-8", "and the caller's env is untouched");
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test("a written line carries the local stamp, and the audit timestamp stays ISO UTC", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ob-filelog-tz-"));
  try {
    const log = new FileLog(dir, { maxBytes: 0 });
    log.write("hello");
    await log.flush();
    const [written = ""] = await linesOf(log.path());
    assert.match(written, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] hello$/,
      "the file gets the same human stamp the console stream shows");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
    assert.match(seen[0], /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\] line 0 /);
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
