/**
 * Does each tool's declared output shape match what it actually returns?
 *
 * Six of them did not. activity_log, service_status, read_files,
 * search_files, find_files and list_directory all declared
 * `type: "object"` with the rows nested under an `items` key, and all six
 * return the array directly. read_files was further off: its schema described
 * a single file's metadata, which looks like it was copied from
 * get_file_info.
 *
 * This is the failure mode that costs a model the most. The schema is what it
 * plans against, so it writes `result.items.map(...)`, gets undefined, and has
 * to discover the real shape by trial — on a tool it was told it understood.
 * Every individual schema looked plausible in isolation; only running the
 * tools showed the mismatch.
 *
 * Second pass (the truncation fix): the three LISTING tools moved from a bare
 * array to an object — `{items, truncated, ...}` — because an array has no
 * room for the one fact a capped listing must carry. A page that cannot say
 * it was cut is an answer about the world ("this directory has three files")
 * that the tool was never in a position to give. So the split is now explicit
 * and enforced below: array-returning tools declare arrays, page-returning
 * tools declare an object whose `truncated` field is the whole point.
 *
 * Kept as a unit test over the declarations rather than a live invocation:
 * spawning a bridge per tool would be slow and platform-bound, and the thing
 * worth pinning is that the DECLARATION agrees with the handler's shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import { CONFIG_DEFAULTS } from "../src/bridge/config-defaults.js";

/**
 * Tools whose handler returns a bare array. Verified by invoking each one
 * against a running bridge while writing this list; a tool added later that
 * also returns an array has to be added here, which is the point.
 */
const ARRAY_RETURNING = new Set([
  "activity_log",
  "service_status",
  "read_files",
]);

/**
 * Tools that return a page: `{items, truncated, ...}`. They cannot honestly
 * declare an array, because the truncation state has nowhere to live in one.
 */
const PAGE_RETURNING = new Set([
  "search_files",
  "find_files",
  "list_directory",
]);

function schemaOf(name: string): { type?: string; items?: unknown; required?: string[]; properties?: Record<string, unknown> } | undefined {
  const def = TOOL_DEFINITIONS.find(entry => entry.name === name);
  return def?.outputSchema as ReturnType<typeof schemaOf>;
}

test("get_config declares every runtime setting with its actual default type", () => {
  // getConfig() returns every entry in CONFIG_DEFAULTS, including newer settings
  // such as profiles, OAuth, locks and notification channels. A partial output
  // schema is worse than none: MCP clients plan against it and silently miss a
  // setting that the result really carries. Iterate the runtime source of truth
  // so adding a default cannot create that drift again.
  const properties = schemaOf("get_config")?.properties ?? {};
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    const property = properties[key] as { type?: string; items?: { type?: string } } | undefined;
    assert.ok(property, `get_config must declare ${key}`);
    const expected = Array.isArray(value) ? "array" : typeof value;
    assert.equal(property.type, expected, `get_config.${key} must be ${expected}`);
    if (Array.isArray(value)) assert.equal(property.items?.type, "string", `${key} array entries are strings`);
  }
});

test("array-returning tools declare an array", () => {
  for (const name of ARRAY_RETURNING) {
    const schema = schemaOf(name);
    assert.ok(schema, `${name} has no outputSchema`);
    assert.equal(
      schema.type,
      "array",
      `${name} returns an array but its schema promises ${String(schema.type)} — a model will plan against the wrong shape`,
    );
  }
});

test("an array schema says what the elements are", () => {
  // "type: array" with no items is barely better than the wrong type: the
  // model still cannot tell what it is iterating over.
  for (const name of ARRAY_RETURNING) {
    const schema = schemaOf(name);
    assert.ok(schema?.items, `${name} declares an array without describing its elements`);
  }
});

test("no array schema nests rows under a key the handler never sends", () => {
  // The specific shape of the first bug: properties.items on an object schema,
  // for a tool that returns the rows directly.
  for (const name of ARRAY_RETURNING) {
    const schema = schemaOf(name);
    assert.ok(
      !(schema?.type === "object" && schema.properties && "items" in schema.properties),
      `${name} wraps its rows in a phantom "items" field`,
    );
  }
});

test("page-returning tools declare an object that can carry the truncation state", () => {
  for (const name of PAGE_RETURNING) {
    const schema = schemaOf(name);
    assert.ok(schema, `${name} has no outputSchema`);
    assert.equal(
      schema.type,
      "object",
      `${name} answers with {items, truncated} but its schema promises ${String(schema.type)}`,
    );
    assert.equal(schema.properties?.items && schema.type, "object");
    assert.ok(schema.properties && "items" in schema.properties, `${name} must declare its rows`);
    assert.ok(schema.properties && "truncated" in schema.properties,
      `${name} cut a result short without a field to say so — that is the bug this test exists for`);
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      ["items", "truncated"],
      `${name} must require both fields, so a caller can parse without guessing`,
    );
  }
});

test("a page schema describes its rows", () => {
  for (const name of PAGE_RETURNING) {
    const items = schemaOf(name)?.properties?.items as { type?: string; items?: unknown } | undefined;
    assert.equal(items?.type, "array", `${name}.items must say it is an array`);
    assert.ok(items?.items, `${name}.items must describe the row shape`);
  }
});
