/**
 * docs/tools.md must cover every advertised tool — and promise none the
 * server does not define.
 *
 * The case that prompted this: a manual drift check nearly filed a false
 * alarm in both directions at once. It looked only for backticked names
 * while the tool entries are bold, and its name list was scraped from
 * source with a grep that both missed four definitions and invented one
 * ("done"). The registry of truth is TOOL_DEFINITIONS imported the way
 * every other test imports it; the documentation mixes `name` and
 * **name** styles, so the gate accepts either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";

function docsToolsMd(): string {
  return readFileSync(path.join(process.cwd(), "docs", "tools.md"), "utf8");
}

test("every advertised tool is documented in docs/tools.md", () => {
  const text = docsToolsMd();
  const missing = TOOL_DEFINITIONS
    .map(tool => tool.name)
    .filter(name => !text.includes(`**${name}**`) && !text.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `tools without a docs/tools.md entry: ${missing.join(", ")}`);
});

test("bold entries in docs/tools.md all name advertised tools", () => {
  const defined = new Set(TOOL_DEFINITIONS.map(tool => tool.name));
  // A leading letter keeps bold default values (numbers) out of the check.
  const ghosts = [...docsToolsMd().matchAll(/\*\*([a-z][a-z0-9_]*)\*\*/g)]
    .map(match => match[1] ?? "")
    .filter(name => !defined.has(name));
  assert.deepEqual(ghosts, [], `documented but undefined tools: ${ghosts.join(", ")}`);
});
