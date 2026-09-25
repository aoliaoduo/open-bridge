/**
 * `parseArgs` used to swallow a value-taking flag that arrived without its
 * value: the flag was recorded as boolean `true` and the reader coerced it —
 * `Number(true)` is 1, so `token create --ttl` minted a token that expired in
 * one second, `stop --pid` silently fell back to "this directory's instance",
 * and `serve --root --home D:\x` died in `path.resolve(true)` with a TypeError
 * that named no flag. `--port` had already been fixed at its read site; the
 * parser is the one place every reader is protected at once.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, UsageError } from "../src/cli/args.js";

test("a value-taking flag without a value is a usage error naming the flag", () => {
  for (const argv of [
    ["token", "create", "--ttl"],
    ["token", "create", "--label", "--ttl", "3600"],
    ["stop", "--pid"],
    ["serve", "--root", "--home", "D:/x"],
    ["diagnostics", "--out"],
    ["logs", "--tail"],
  ]) {
    assert.throws(() => parseArgs(argv), UsageError, `bare value flag in ${JSON.stringify(argv)}`);
    try {
      parseArgs(argv);
    } catch (error) {
      const flagged = (error as Error).message.match(/--([a-z-]+)/);
      assert.ok(flagged, `the error names the offending flag for ${JSON.stringify(argv)}`);
    }
  }
});

test("a value-taking flag with a value still parses, and boolean flags stay boolean", () => {
  const parsed = parseArgs(["token", "create", "--ttl", "3600", "--label", "ci"]);
  assert.equal(parsed.flags.get("ttl"), "3600");
  assert.equal(parsed.flags.get("label"), "ci");

  const logs = parseArgs(["logs", "--follow", "--tail", "40"]);
  assert.equal(logs.flags.get("follow"), true);
  assert.equal(logs.flags.get("tail"), "40");

  // Unknown flags keep the old lenient shape: only the known value-takers are
  // refused, so a future flag is not broken by this registry.
  const unknown = parseArgs(["whatever", "--future-flag"]);
  assert.equal(unknown.flags.get("future-flag"), true);
});
