/**
 * The CLI flag drift alarm.
 *
 * `parseArgs` refuses a bare VALUE_FLAG, and every value flag must be
 * registered there or its `--flag value` form silently degrades to `true`
 * (the `--ttl` cast 1-second tokens; bare `stop --pid` retargeted the
 * current directory's instance). This test scans every read site and fails
 * the build when a flag is read but registered in neither VALUE_FLAGS nor
 * BOOLEAN_FLAGS — so adding a flag means registering it, in one place.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VALUE_FLAGS, BOOLEAN_FLAGS } from "../src/cli/args.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSiteFlags(): Map<string, string[]> {
  const files = [
    path.join(ROOT, "src", "cli.ts"),
    ...readdirSync(path.join(ROOT, "src", "cli"))
      .filter(name => name.endsWith(".ts"))
      .map(name => path.join(ROOT, "src", "cli", name)),
  ];
  const sites = new Map<string, string[]>();
  const pattern = /flags\.(?:get|has)\("([^"]+)"\)/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    for (const match of text.matchAll(pattern)) {
      const key = match[1] ?? "";
      const list = sites.get(key) ?? [];
      list.push(rel);
      sites.set(key, list);
    }
  }
  return sites;
}

test("every flag a command reads is registered in args.ts (VALUE or BOOLEAN)", () => {
  const unregistered: string[] = [];
  for (const [key, sites] of readSiteFlags()) {
    if (!VALUE_FLAGS.has(key) && !BOOLEAN_FLAGS.has(key)) {
      unregistered.push(`--${key} (read in ${sites.join(", ")})`);
    }
  }
  assert.deepEqual(
    unregistered,
    [],
    "flags read somewhere but registered in neither VALUE_FLAGS nor BOOLEAN_FLAGS; "
    + "register in src/cli/args.ts so the parser knows the arity",
  );
});

test("both registries are disjoint and non-empty", () => {
  assert.ok(VALUE_FLAGS.size > 0);
  assert.ok(BOOLEAN_FLAGS.size > 0);
  for (const key of VALUE_FLAGS) {
    assert.equal(BOOLEAN_FLAGS.has(key), false, `--${key} is in both registries`);
  }
});
