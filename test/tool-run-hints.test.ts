import { test } from "node:test";
import assert from "node:assert/strict";
import { freshRunState, noteToolCall } from "../src/bridge/tool-run-hints.js";

test("a run of identical calls is noticed once, at its threshold", () => {
  const state = freshRunState();
  assert.equal(noteToolCall(state, "read_file"), undefined, "1st");
  assert.equal(noteToolCall(state, "read_file"), undefined, "2nd");
  const hint = noteToolCall(state, "read_file");
  assert.match(String(hint), /3 read_file calls in a row/);
  assert.match(String(hint), /read_files/, "names the call that replaces the run");
  // Once per session: a hint repeated every subsequent call is a nag, and a
  // nag gets filtered out exactly like the docs it is restating.
  assert.equal(noteToolCall(state, "read_file"), undefined, "4th stays quiet");
  assert.equal(noteToolCall(state, "read_file"), undefined, "5th stays quiet");
});

test("alternating tools is ordinary work, not a missed batch", () => {
  const state = freshRunState();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(noteToolCall(state, "read_file"), undefined, `read ${i}`);
    assert.equal(noteToolCall(state, "edit_block"), undefined, `edit ${i}`);
  }
});

test("an interruption resets the run", () => {
  const state = freshRunState();
  noteToolCall(state, "run_command");
  noteToolCall(state, "run_command");
  noteToolCall(state, "run_command");
  noteToolCall(state, "run_command");
  // Four in a row, one below the threshold of five.
  assert.equal(noteToolCall(state, "get_file_info"), undefined);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(noteToolCall(state, "run_command"), undefined, `post-reset ${i}`);
  }
  assert.match(String(noteToolCall(state, "run_command")), /5 run_command calls in a row/);
});

test("each pattern fires independently", () => {
  const state = freshRunState();
  for (let i = 0; i < 3; i += 1) noteToolCall(state, "read_file");
  // The read hint has fired; the command hint has not, and must still be able to.
  for (let i = 0; i < 4; i += 1) {
    assert.equal(noteToolCall(state, "run_command"), undefined, `cmd ${i}`);
  }
  assert.match(String(noteToolCall(state, "run_command")), /run_script/);
});

test("tools without a named better call never produce a hint", () => {
  const state = freshRunState();
  // "Be more efficient" is not actionable, so a tool with no concrete
  // replacement is simply not watched -- however long the run gets.
  for (let i = 0; i < 30; i += 1) {
    assert.equal(noteToolCall(state, "get_file_info"), undefined, `call ${i}`);
  }
});
