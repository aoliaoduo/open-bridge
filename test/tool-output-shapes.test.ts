/**
 * Does each MCP outputSchema match the structuredContent that clients receive?
 *
 * `content[0].text` intentionally preserves the handler's legacy JSON for old
 * clients. MCP structuredContent, however, must be an object. The endpoint
 * therefore envelopes a bare handler array as `{ items: [...] }` before
 * publishing it. Declaring that legacy array as the output schema makes a
 * schema-validating client reject the payload it actually got.
 *
 * This test pins the client-facing contract. It is declaration-level on
 * purpose; transport integration separately proves that the endpoint emits
 * structuredContent for these schemas.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import { CONFIG_DEFAULTS } from "../src/bridge/config-defaults.js";

type Schema = {
  type?: string | string[];
  items?: Schema;
  required?: string[];
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  enum?: string[];
};

const STRUCTURED_ARRAY_OUTPUT = new Set(["service_status", "read_files"]);
const PAGE_RETURNING = new Set(["search_files", "find_files", "list_directory"]);

function schemaOf(name: string): Schema | undefined {
  const def = TOOL_DEFINITIONS.find(entry => entry.name === name);
  return def?.outputSchema as Schema | undefined;
}

function itemsOf(schema: Schema | undefined): Schema | undefined {
  return schema?.properties?.items;
}

test("get_config declares every runtime setting with its actual default type", () => {
  const properties = schemaOf("get_config")?.properties ?? {};
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    const property = properties[key];
    assert.ok(property, `get_config must declare ${key}`);
    const expected = Array.isArray(value) ? "array" : typeof value;
    assert.equal(property.type, expected, `get_config.${key} must be ${expected}`);
    if (Array.isArray(value)) assert.equal(property.items?.type, "string", `${key} array entries are strings`);
  }
});

test("process-output tools publish the page and continuation contract", () => {
  for (const name of ["read_process_output", "interact_with_process"]) {
    const schema = schemaOf(name);
    assert.equal(schema?.type, "object", `${name} returns one output page`);
    const properties = schema?.properties ?? {};
    assert.deepEqual(
      Object.keys(properties).sort(),
      [
        "command_id", "dropped_bytes", "exit_code", "next_offset", "offset",
        "output", "output_available_bytes", "output_bytes", "status", "stream",
        "termination_reason", "truncated",
      ],
      `${name} must declare every output-page field`,
    );
    assert.equal(properties.output?.type, "string");
    assert.equal(properties.next_offset?.type, "number");
    assert.equal(properties.truncated?.type, "boolean");
    assert.deepEqual(properties.stream?.enum, ["merged", "stdout", "stderr"]);
    assert.deepEqual(properties.exit_code?.type, ["number", "null"]);
  }
});

test("bare-array handlers declare the object envelope used for structuredContent", () => {
  for (const name of STRUCTURED_ARRAY_OUTPUT) {
    const schema = schemaOf(name);
    assert.equal(schema?.type, "object", `${name} structuredContent is an object`);
    assert.deepEqual(schema?.required, ["items"], `${name} always exposes items`);
    const items = itemsOf(schema);
    assert.equal(items?.type, "array", `${name}.items is an array`);
    assert.ok(items?.items, `${name}.items describes the row shape`);
  }
});

test("activity_log declares all three action result variants", () => {
  const variants = schemaOf("activity_log")?.oneOf ?? [];
  assert.equal(variants.length, 3, "recent, search and clear each have a schema");

  const [recent, search, clear] = variants;
  assert.equal(recent?.type, "object");
  assert.deepEqual(recent?.required, ["items"]);
  assert.equal(itemsOf(recent)?.type, "array");
  assert.ok(itemsOf(recent)?.items, "recent rows are described");

  assert.deepEqual(search?.required, ["entries", "total_scanned", "truncated"]);
  assert.equal(search?.properties?.entries?.type, "array");
  assert.equal(search?.properties?.truncated?.type, "boolean");

  assert.deepEqual(clear?.required, ["cleared_memory_entries", "live_truncated", "rotated_removed"]);
  assert.equal(clear?.properties?.cleared_memory_entries?.type, "number");
  assert.equal(clear?.properties?.live_truncated?.type, "boolean");
  assert.equal(clear?.properties?.rotated_removed?.type, "boolean");
});

test("page-returning tools declare an object that can carry truncation state", () => {
  for (const name of PAGE_RETURNING) {
    const schema = schemaOf(name);
    assert.equal(schema?.type, "object", `${name} answers with {items, truncated}`);
    assert.ok(schema?.properties && "items" in schema.properties, `${name} must declare its rows`);
    assert.ok(schema?.properties && "truncated" in schema.properties, `${name} must declare truncation`);
    assert.deepEqual([...(schema?.required ?? [])].sort(), ["items", "truncated"]);
  }
});

test("every paged schema describes the row array", () => {
  for (const name of PAGE_RETURNING) {
    const items = itemsOf(schemaOf(name));
    assert.equal(items?.type, "array", `${name}.items must say it is an array`);
    assert.ok(items?.items, `${name}.items must describe the row shape`);
  }
});
