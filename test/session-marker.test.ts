import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMarker,
  scanMarkerExitCode,
  stripMarkerLines,
} from "../src/shell/session-marker.js";

test("createMarker produces unique sentinel-shaped markers", () => {
  const a = createMarker();
  const b = createMarker();
  assert.match(a, /^__OB_DONE_[0-9a-f]{10}__$/);
  assert.notEqual(a, b);
});

test("scanMarkerExitCode returns the exit code of the last complete marker", () => {
  const m = createMarker();
  assert.equal(scanMarkerExitCode(`hello\n${m}=0\n`, m), 0);
  assert.equal(scanMarkerExitCode(`boom\n${m}=127\n`, m), 127);
  assert.equal(scanMarkerExitCode(`${m}=-1\n`, m), -1);
});

test("scanMarkerExitCode returns null while the marker is absent or incomplete", () => {
  const m = createMarker();
  assert.equal(scanMarkerExitCode("no marker here", m), null);
  // Echoed command line contains the bare marker text but no "=<code>" yet.
  assert.equal(scanMarkerExitCode(`echo "${m}=$?"\npartial output`, m), null);
});

test("scanMarkerExitCode prefers the real sentinel over an echoed command line", () => {
  const m = createMarker();
  const echoed = `echo "${m}=$?"\n`;
  const real = `${m}=42\n`;
  assert.equal(scanMarkerExitCode(echoed + "out\n" + real, m), 42);
  // Even if the echoed line appears AFTER (weird tty ordering), the last
  // complete occurrence wins.
  assert.equal(scanMarkerExitCode(real + echoed, m), 42);
});

test("stripMarkerLines removes the sentinel line, LF and CRLF", () => {
  const m = createMarker();
  assert.equal(stripMarkerLines(`out\n${m}=0\n`, m), "out\n");
  assert.equal(stripMarkerLines(`out\r\n${m}=0\r\n`, m), "out\r\n");
  assert.equal(stripMarkerLines(`${m}=0`, m), "");
  assert.equal(stripMarkerLines("no marker", m), "no marker");
});

test("a truncated digit at the end of the window is not a match", () => {
  // The chunked scanner in shell-sessions re-examines a carry of the previous
  // chunk, so a marker whose digits straddle the boundary arrives split:
  // window 1 ends with "__OB_DONE_x__=-1" (the real code was -123). The scan
  // must refuse a match that touches the END of the window unless the line is
  // newline-terminated, or it reports the truncation as the exit code.
  const m = createMarker();
  assert.equal(scanMarkerExitCode(`work\n${m}=-1`, m), null,
    "digits at the very end of the window may be truncated; not a complete marker");
  assert.equal(scanMarkerExitCode(`work\n${m}=-123`, m), null);
  // Same prefix, but newline-terminated: now it is complete and must match.
  assert.equal(scanMarkerExitCode(`work
${m}=-1
`, m), -1);
});
