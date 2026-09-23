import assert from "node:assert/strict";
import test from "node:test";
import {
  PROGRESS_CATEGORIES,
  PROGRESS_LEVELS,
  PROGRESS_PHASES,
  isProgressCategory,
  isProgressLevel,
  isProgressPhase,
  normalizeCategory,
  normalizeLevel,
  normalizePhase,
} from "../src/bridge/tools/progress-vocabulary.js";

test("the vocabularies are non-empty, unique and lowercase", () => {
  for (const list of [PROGRESS_PHASES, PROGRESS_CATEGORIES, PROGRESS_LEVELS]) {
    assert.ok(list.length > 0);
    assert.equal(new Set(list).size, list.length, "no duplicates");
    assert.ok(list.every(value => value === value.toLowerCase()), "members are lowercase");
    assert.ok(list.every(value => value.trim() === value), "members are already trimmed");
  }
});

test("phase membership is exact, and normalisation only trims and lowercases", () => {
  for (const phase of PROGRESS_PHASES) {
    assert.equal(isProgressPhase(phase), true);
    assert.equal(normalizePhase(phase), phase);
  }
  assert.equal(normalizePhase("  RUNNING  "), "running", "case and padding are forgiven");
  assert.equal(normalizePhase("done"), "done");

  // Anything outside the set is refused rather than coerced to a default: the
  // whole point is that an arbitrary value never reaches storage.
  for (const bad of ["finished", "running-now", "", "   ", "run", "DONE!", 1, null, undefined, {}, [], true]) {
    assert.equal(normalizePhase(bad), undefined, `${JSON.stringify(bad)} must be refused`);
    assert.equal(isProgressPhase(bad), false);
  }
});

test("category membership is exact and refuses arbitrary strings", () => {
  for (const category of PROGRESS_CATEGORIES) {
    assert.equal(isProgressCategory(category), true);
    assert.equal(normalizeCategory(category), category);
  }
  assert.equal(normalizeCategory(" BUILD "), "build");

  for (const bad of ["compile", "npm", "read_file", "cat", "test:unit", "", 42, null, undefined, {}]) {
    assert.equal(normalizeCategory(bad), undefined, `${JSON.stringify(bad)} must be refused`);
  }
});

test("a refused value is dropped, never replaced by a default", () => {
  // Spelled out because it is the security property, not a style choice:
  // normalising "whatever the model said" into a legal member would mean the
  // stored value no longer reflects the caller, and the closed set would stop
  // bounding what reaches the console and the audit log.
  assert.equal(normalizePhase("deploying"), undefined);
  assert.equal(normalizeCategory("deploying"), undefined);
  assert.notEqual(normalizePhase("deploying"), "running");
  assert.notEqual(normalizeCategory("deploying"), "other");
});

test("level falls back to info, unlike the others, and still bounds the set", () => {
  // A level must always exist to emit a log line, and "info" is the documented
  // default — so this one defaults instead of dropping.
  assert.equal(normalizeLevel(undefined), "info");
  assert.equal(normalizeLevel(""), "info");
  assert.equal(normalizeLevel("shout"), "info");
  assert.equal(normalizeLevel(7), "info");
  for (const level of PROGRESS_LEVELS) {
    assert.equal(normalizeLevel(level), level);
    assert.equal(isProgressLevel(level), true);
  }
  assert.equal(normalizeLevel(" WARNING "), "warning");
  assert.equal(isProgressLevel("shout"), false);
});

test("the vocabularies cannot be mutated through the exported arrays", () => {
  // The arrays are the authority the membership checks read, so they are frozen
  // at runtime. A stray push must throw rather than silently widen the set.
  for (const list of [PROGRESS_PHASES, PROGRESS_CATEGORIES, PROGRESS_LEVELS]) {
    assert.equal(Object.isFrozen(list), true, "the vocabulary array is frozen");
    assert.throws(() => { (list as unknown as string[]).push("deploying"); }, TypeError);
  }
  assert.equal(isProgressPhase("deploying"), false, "the accepted set is unchanged");
  assert.equal(isProgressCategory("deploying"), false);
  assert.equal(isProgressLevel("deploying"), false);
});
