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

/**
 * The measurement behind this: 2138 calls in one day of this repo's own audit
 * log, `set_todos` called zero times — by the model that had just built the
 * todo board. Documentation, a console page and the whole notification path
 * all keyed off a tool nothing ever pointed at while work was happening.
 */
test("a session that works without a task list is told once", () => {
  const state = freshRunState();
  const hints: string[] = [];
  // Alternate so no run pattern fires: this must be the todo hint, not a
  // side effect of hammering one tool.
  for (let i = 0; i < 12; i += 1) {
    const hint = noteToolCall(state, i % 2 === 0 ? "edit_block" : "write_file");
    if (hint) hints.push(hint);
  }
  assert.equal(hints.length, 1, "exactly one hint");
  assert.match(hints[0] ?? "", /no task list exists/);
  assert.match(hints[0] ?? "", /set_todos/, "names the call that fixes it");

  // Never twice, however long the session runs.
  for (let i = 0; i < 30; i += 1) {
    assert.equal(noteToolCall(state, "write_file"), undefined, "the hint does not repeat");
  }
});

test("reading and searching never triggers the task-list hint", () => {
  const state = freshRunState();
  // A question being answered is not a multi-step task, and nagging about a
  // todo list here would be exactly the noise that gets every hint filtered.
  for (let i = 0; i < 40; i += 1) {
    const hint = noteToolCall(state, i % 2 === 0 ? "read_files" : "search_files");
    assert.equal(hint, undefined, "no hint for read-only work");
  }
});

test("a session that already has a task list is left alone", () => {
  const state = freshRunState();
  noteToolCall(state, "set_todos");
  for (let i = 0; i < 40; i += 1) {
    const hint = noteToolCall(state, i % 2 === 0 ? "edit_block" : "write_file");
    assert.equal(hint, undefined, "the list exists; there is nothing to point out");
  }
});
