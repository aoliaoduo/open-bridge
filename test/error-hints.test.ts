import { test } from "node:test";
import assert from "node:assert/strict";
import { availableHint, suggestNames, suggestionHint } from "../src/bridge/error-hints.js";

test("availableHint lists current values so clients can self-correct", () => {
  assert.equal(availableHint("Active command ids", ["a1", "b2"]), " Active command ids: a1, b2.");
});

test("availableHint says 'none' when nothing is available", () => {
  assert.equal(availableHint("Saved services", []), " Saved services: none.");
});

test("availableHint truncates long lists with a remainder count", () => {
  const ids = Array.from({ length: 15 }, (_, i) => `id${i}`);
  const hint = availableHint("Active command ids", ids, 12);
  assert.ok(hint.includes("id0"));
  assert.ok(hint.includes("id11"));
  assert.ok(!hint.includes("id12,"));
  assert.ok(hint.endsWith("(+3 more)."));
});

test("suggestNames ranks exact, then prefix, then substring", () => {
  const tools = ["read_files", "read_process_output", "write_file", "list_directory"];
  assert.deepEqual(suggestNames("read_files", tools), ["read_files"]);
  assert.deepEqual(suggestNames("read", tools), ["read_files", "read_process_output"]);
  assert.ok(suggestNames("process", tools).includes("read_process_output"));
  assert.deepEqual(suggestNames("zzz-no-match", tools), []);
  assert.deepEqual(suggestNames("", tools), []);
});

test("suggestionHint formats a question or stays empty", () => {
  assert.equal(suggestionHint("list_director", ["list_directory"]), " Did you mean: list_directory?");
  assert.equal(suggestionHint("nope", ["list_directory"]), "");
});

test("suggestNames falls back to edit distance for typos", () => {
  const tools = ["list_directory", "read_files", "write_file", "list_processes"];
  assert.deepEqual(suggestNames("list_diretory", tools), ["list_directory"]);
  assert.deepEqual(suggestNames("read_fil", tools), ["read_files"]);
  assert.deepEqual(suggestNames("totally-unrelated", tools), []);
  // Name-tier matches still outrank edit-distance ones.
  const ranking = suggestNames("read", ["read_files", "read_process_output", "list_directory"]);
  assert.deepEqual(ranking, ["read_files", "read_process_output"]);
});


test("cross-tier suggestion ranking: prefix outranks substring outranks edit distance", () => {
  const tools = ["readfiles", "xread", "red"];
  assert.deepEqual(suggestNames("read", tools), ["readfiles", "xread", "red"]);
  // exact still tops everything (the default suggestion budget is 3, so the
  // edit-distance tier is cut once exact/prefix/substring fill it).
  assert.deepEqual(suggestNames("read", [...tools, "read"]), ["read", "readfiles", "xread"]);
  // Raising the budget surfaces the full ranking including the edit tier.
  assert.deepEqual(suggestNames("read", [...tools, "read"], 4), ["read", "readfiles", "xread", "red"]);
});
