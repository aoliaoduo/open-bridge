import { test } from "node:test";
import assert from "node:assert/strict";
import { ProcessOutputBuffer } from "../src/process/output-buffer.js";
import {
  createMarkerScanState,
  resetMarkerScanCarry,
  scanForMarker,
} from "../src/shell/marker-scan.js";

const MARKER = "__OB_DONE_abcdef0123__";

/** A live output buffer fed chunk by chunk, exactly as the child's stdout does. */
function makeSource(): ProcessOutputBuffer {
  return new ProcessOutputBuffer(32 * 1024 * 1024);
}

test("a sentinel split across two scans is still found", () => {
  // THE REGRESSION. send_to_shell polls every 60 ms; a sentinel line can be
  // written in two pieces that land in different polls. The first scan sees
  // "...=0" with no newline yet and must not match (the digits could be
  // truncated), but it HAS advanced the cursor past those bytes. Unless the
  // examined tail is carried into the next scan, the marker is unreachable
  // forever: the command is reported timed_out despite succeeding, and
  // pendingMarker wedges the session until it is reopened.
  const buffer = makeSource();
  const scan = createMarkerScanState();

  buffer.append(Buffer.from(`hello\n${MARKER}=0`));
  assert.equal(scanForMarker(buffer, scan, MARKER), null,
    "digits at the very end may be truncated; not a complete sentinel yet");

  buffer.append(Buffer.from("\n"));
  assert.equal(scanForMarker(buffer, scan, MARKER), 0,
    "the newline completes the sentinel the previous scan half-saw");
});

test("a sentinel split mid-marker across two scans is still found", () => {
  // The split can fall anywhere, including inside the marker text itself.
  const buffer = makeSource();
  const scan = createMarkerScanState();

  buffer.append(Buffer.from(`work\n${MARKER.slice(0, 12)}`));
  assert.equal(scanForMarker(buffer, scan, MARKER), null);

  buffer.append(Buffer.from(`${MARKER.slice(12)}=127\n`));
  assert.equal(scanForMarker(buffer, scan, MARKER), 127);
});

test("a byte-at-a-time sentinel is still found", () => {
  // Pathological but legal: a slow pipe delivering one byte per poll.
  const buffer = makeSource();
  const scan = createMarkerScanState();
  const text = `out\n${MARKER}=3\n`;
  let found: number | null = null;
  for (const byte of Buffer.from(text)) {
    buffer.append(Buffer.from([byte]));
    found = scanForMarker(buffer, scan, MARKER);
    if (found !== null) break;
  }
  assert.equal(found, 3);
});

test("the exit code is read in full, never a truncated prefix", () => {
  // -123 split after "-1" must NOT be reported as -1.
  const buffer = makeSource();
  const scan = createMarkerScanState();

  buffer.append(Buffer.from(`run\n${MARKER}=-1`));
  assert.equal(scanForMarker(buffer, scan, MARKER), null);

  buffer.append(Buffer.from("23\n"));
  assert.equal(scanForMarker(buffer, scan, MARKER), -123,
    "the carry must rejoin the digits, not report the truncated prefix");
});

test("a marker buried under a burst of later output is still found", () => {
  // The reason the cursor exists: the sentinel must not need to be in the tail.
  const buffer = makeSource();
  const scan = createMarkerScanState();
  buffer.append(Buffer.from(`done\n${MARKER}=0\n`));
  buffer.append(Buffer.from("x".repeat(2 * 1024 * 1024)));
  assert.equal(scanForMarker(buffer, scan, MARKER), 0);
});

test("scanning is idempotent once the marker has been consumed", () => {
  const buffer = makeSource();
  const scan = createMarkerScanState();
  buffer.append(Buffer.from(`${MARKER}=5\n`));
  assert.equal(scanForMarker(buffer, scan, MARKER), 5);
  // A second command's marker is a different string; the old one must not
  // keep matching and must not block progress.
  const next = "__OB_DONE_9999999999__";
  resetMarkerScanCarry(scan);
  assert.equal(scanForMarker(buffer, scan, next), null);
  buffer.append(Buffer.from(`${next}=0\n`));
  assert.equal(scanForMarker(buffer, scan, next), 0);
});

test("a fresh command's carry cannot forge a match from stale bytes", () => {
  // resetMarkerScanCarry is what keeps the previous command's trailing bytes
  // from being re-examined against the new marker.
  const buffer = makeSource();
  const scan = createMarkerScanState();
  buffer.append(Buffer.from(`${MARKER}=0\n`));
  assert.equal(scanForMarker(buffer, scan, MARKER), 0);
  resetMarkerScanCarry(scan);
  assert.equal(scan.carry.length, 0);
});

test("an absent marker stays null while output keeps arriving", () => {
  const buffer = makeSource();
  const scan = createMarkerScanState();
  for (let i = 0; i < 5; i += 1) {
    buffer.append(Buffer.from(`line ${i}\n`));
    assert.equal(scanForMarker(buffer, scan, MARKER), null);
  }
});
