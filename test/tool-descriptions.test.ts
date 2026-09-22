/**
 * The advertised catalog's context budget.
 *
 * Tool definitions sit in the client's context for the whole conversation, so a
 * description is not free text — it is a recurring cost paid on every request.
 * The budget agreed for this repository is 200 characters per tool, with the
 * long-form detail living in docs/tools.md (which is read on demand) and the
 * rules that apply to every tool living once in SERVER_INSTRUCTIONS_BASE.
 *
 * This test exists so the budget cannot quietly erode one well-meaning
 * paragraph at a time, which is exactly how the catalog reached 11,957
 * characters of description text before the trim.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";

const MAX_DESCRIPTION_CHARS = 200;
/** Below this a description is not saying what the tool does. */
const MIN_DESCRIPTION_CHARS = 20;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

test("every tool description fits the context budget", () => {
  const over = TOOL_DEFINITIONS
    .map(tool => ({ name: tool.name, length: tool.description.length }))
    .filter(entry => entry.length > MAX_DESCRIPTION_CHARS);

  assert.deepEqual(
    over,
    [],
    `descriptions over ${MAX_DESCRIPTION_CHARS} chars (move the detail to docs/tools.md): `
      + over.map(entry => `${entry.name}=${entry.length}`).join(", "),
  );
});

test("run_command describes the continuation route for long work", () => {
  const run = TOOL_DEFINITIONS.find(tool => tool.name === "run_command");
  assert.ok(run, "run_command remains advertised");
  assert.match(run.description, /background=true/);
  assert.match(run.description, /command_id/);
});

test("every tool description says what the tool does", () => {
  const thin = TOOL_DEFINITIONS
    .filter(tool => tool.description.trim().length < MIN_DESCRIPTION_CHARS)
    .map(tool => tool.name);

  assert.deepEqual(thin, [], `descriptions under ${MIN_DESCRIPTION_CHARS} chars: ${thin.join(", ")}`);
});

test("every public input field explains its call-time meaning", () => {
  const missing = TOOL_DEFINITIONS.flatMap(tool => {
    const properties = (tool.inputSchema as unknown as {
      properties?: Record<string, { description?: unknown }>;
    }).properties ?? {};
    return Object.entries(properties)
      .filter(([, schema]) => typeof schema.description !== "string" || schema.description.trim().length < 8)
      .map(([field]) => `${tool.name}.${field}`);
  });

  assert.deepEqual(missing, [], `input properties without a useful description: ${missing.join(", ")}`);
});

test("the per-tool detail has a documented home", () => {
  // The trimmed rules went to docs/tools.md; if that file disappears, the
  // trimming turns into information loss, so the budget and the document are
  // one contract, tested together.
  const doc = readFileSync(path.join(repoRoot, "docs", "tools.md"), "utf8");

  assert.match(doc, /## 结果字段约定/, "docs/tools.md lost the field-contract section");
  assert.match(doc, /## 在相似工具之间怎么选/, "docs/tools.md lost the routing table");

  const missing = TOOL_DEFINITIONS
    .filter(tool => !doc.includes(tool.name))
    .map(tool => tool.name);
  assert.deepEqual(missing, [], `tools missing from docs/tools.md: ${missing.join(", ")}`);
});

test("the shared rules are stated once, in the server instructions", () => {
  // The field-set sentence used to be repeated in run_command, edit_block and
  // read_files; every copy is a separate thing to keep in sync. It lives in
  // SERVER_INSTRUCTIONS_BASE, which moved to instruction-prefix.ts when the
  // connect-time prefix became a measured, byte-stability-tested thing.
  const prefix = readFileSync(path.join(repoRoot, "src", "bridge", "instruction-prefix.ts"), "utf8");

  assert.match(prefix, /parse by field name and never by line presence/);
  assert.match(prefix, /docs\/tools\.md/);

  const repeated = TOOL_DEFINITIONS
    .filter(tool => /parse by field name, never by line presence/i.test(tool.description))
    .map(tool => tool.name);
  assert.deepEqual(repeated, [], `tool descriptions still repeat the field-set rule: ${repeated.join(", ")}`);
});
