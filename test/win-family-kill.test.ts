/**
 * Safety invariants for Windows process-family termination.
 *
 * The production helper may be invoked by a CLI that itself was launched from
 * a live Bridge. Its target family must never overlap the caller or any caller
 * ancestor, otherwise an integration cleanup can take down the MCP host that is
 * running the test. The pure projections below pin the tree arithmetic, and the
 * final test proves the runtime guard refuses a direct self-kill before any OS
 * termination command can run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ancestorPidsFromRows,
  descendantPidsFromRows,
  killWindowsProcessFamily,
  type WindowsProcessRow,
} from "../src/process/win-family-kill.js";

const ROWS: WindowsProcessRow[] = [
  { ProcessId: 10, ParentProcessId: 1 },
  { ProcessId: 20, ParentProcessId: 10 },
  { ProcessId: 30, ParentProcessId: 20 },
  { ProcessId: 40, ParentProcessId: 20 },
  { ProcessId: 900, ParentProcessId: 800 },
  { ProcessId: 800, ParentProcessId: 700 },
  { ProcessId: 700, ParentProcessId: 1 },
];

test("descendant projection is post-order and cannot escape its Windows tree", () => {
  assert.deepEqual(descendantPidsFromRows(20, ROWS), [30, 40, 20]);
  assert.deepEqual(descendantPidsFromRows(10, ROWS), [30, 40, 20, 10]);
});

test("ancestor projection protects the caller chain only", () => {
  assert.deepEqual(ancestorPidsFromRows(900, ROWS), [900, 800, 700, 1]);
  assert.deepEqual(ancestorPidsFromRows(30, ROWS), [30, 20, 10, 1]);
});

test("malformed cycles terminate instead of looping forever", () => {
  const cyclic: WindowsProcessRow[] = [
    { ProcessId: 2, ParentProcessId: 3 },
    { ProcessId: 3, ParentProcessId: 2 },
  ];
  assert.deepEqual(descendantPidsFromRows(2, cyclic), [3, 2]);
  assert.deepEqual(ancestorPidsFromRows(2, cyclic), [2, 3]);
});

test("process-family termination always refuses to kill its own caller", async () => {
  await assert.rejects(
    killWindowsProcessFamily(process.pid, process.execPath),
    /Refusing to terminate protected process/,
  );
});
