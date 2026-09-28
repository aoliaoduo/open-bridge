import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("tracked text files do not contain mixed line endings", () => {
  const output = execFileSync("git", ["ls-files", "--eol"], { encoding: "utf8" });
  const mixed = output
    .split(/\r?\n/)
    .filter(line => /\bw\/mixed\b/.test(line))
    .map(line => line.split("\t").at(-1) ?? line);

  assert.deepEqual(mixed, [], "mixed line endings: " + mixed.join(", "));
});
