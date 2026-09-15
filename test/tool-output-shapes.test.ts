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
 * Kept as a unit test over the declarations rather than a live invocation:
 * spawning a bridge per tool would be slow and platform-bound, and the thing
 * worth pinning is that the DECLARATION says array where the handler returns
 * one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";

/**
 * Tools whose handler returns a bare array. Verified by invoking each one
 * against a running bridge while writing this list; a tool added later that
 * also returns an array has to be added here, which is the point.
 */
const ARRAY_RETURNING = new Set([
  "activity_log",
  "service_status",
  "read_files",
  "search_files",
  "find_files",
  "list_directory",
]);

function schemaOf(name: string): { type?: string } | undefined {
  const def = TOOL_DEFINITIONS.find(entry => entry.name === name);
  return def?.outputSchema as { type?: string } | undefined;
}

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
    const schema = schemaOf(name) as { items?: unknown } | undefined;
    assert.ok(schema?.items, `${name} declares an array without describing its elements`);
  }
});

test("no schema nests rows under a key the handler never sends", () => {
  // The specific shape of the bug: properties.items on an object schema, for
  // a tool that returns the rows directly.
  for (const name of ARRAY_RETURNING) {
    const schema = schemaOf(name) as { type?: string; properties?: Record<string, unknown> } | undefined;
    assert.ok(
      !(schema?.type === "object" && schema.properties && "items" in schema.properties),
      `${name} wraps its rows in a phantom "items" field`,
    );
  }
});
