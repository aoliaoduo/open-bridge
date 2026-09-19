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
  additionalProperties?: boolean;
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

test("snapshot and shell tools declare their input-dependent structured results", () => {
  const snapshots = schemaOf("get_process_snapshot")?.oneOf ?? [];
  assert.equal(snapshots.length, 2, "one snapshot or an items envelope");
  assert.equal(snapshots[0]?.type, "object");
  assert.ok(snapshots[0]?.required?.includes("command_id"));
  assert.deepEqual(snapshots[1]?.required, ["items"]);
  assert.equal(itemsOf(snapshots[1])?.type, "array");
  assert.ok(itemsOf(snapshots[1])?.items, "snapshot rows are described");

  const shells = schemaOf("open_shell")?.oneOf ?? [];
  assert.equal(shells.length, 2, "open and list variants are explicit");
  assert.deepEqual(shells[0]?.required, ["name", "command_id", "cwd"]);
  assert.deepEqual(shells[1]?.required, ["items"]);
  assert.equal(itemsOf(shells[1])?.type, "array");
  assert.ok(itemsOf(shells[1])?.items, "shell-list rows are described");
});

test("action-family tools declare each non-overlapping result shape", () => {
  const fileOps = schemaOf("file_op")?.oneOf ?? [];
  assert.equal(fileOps.length, 3, "create, transfer and delete each have a result shape");
  assert.deepEqual(fileOps[0]?.required, ["path", "created"]);
  assert.deepEqual(fileOps[1]?.required, ["source", "destination"]);
  assert.equal(fileOps[1]?.properties?.unchanged?.type, "boolean");
  assert.deepEqual(fileOps[2]?.required, ["path", "deleted"]);

  const processActions = schemaOf("process_control")?.oneOf ?? [];
  assert.equal(processActions.length, 2, "restart and terminate are distinct result variants");
  assert.deepEqual(processActions[0]?.required, ["command_id", "restarted", "restart_count", "auto_restart"]);
  assert.ok(processActions[1]?.required?.includes("terminated"));
  assert.ok(processActions[1]?.required?.includes("command_id"));
  assert.equal(processActions[1]?.properties?.already_exited?.type, "boolean");
});

test("service action variants preserve their single and batch result contracts", () => {
  const actions = schemaOf("service")?.oneOf ?? [];
  assert.equal(actions.length, 5, "start, stop, restart, delete and batched actions are explicit");
  assert.deepEqual(actions[0]?.required, ["name", "command_id", "status"]);
  assert.deepEqual(actions[1]?.required, ["name", "command_id", "stopped", "status"]);
  assert.deepEqual(actions[2]?.required, ["name", "command_id", "restarted"]);
  assert.deepEqual(actions[3]?.required, ["name", "deleted", "stopped"]);
  for (const action of actions.slice(0, 4)) {
    assert.equal(action?.additionalProperties, false, "single-action variants cannot overlap by extra fields");
  }
  assert.deepEqual(actions[4]?.required, ["items"]);
  assert.equal(itemsOf(actions[4])?.type, "array");
  assert.equal(itemsOf(actions[4])?.items?.oneOf?.length, 2, "batch rows cover start_all and stop_all");
});

test("command launch tools declare their real foreground and supervised results", () => {
  const runs = schemaOf("run_command")?.oneOf ?? [];
  assert.equal(runs.length, 3, "run_command declares background, completed and timeout branches");
  assert.ok(runs[0]?.required?.includes("ready_checked"), "background distinguishes an observed readiness check");
  assert.ok(runs[1]?.required?.includes("exit_code"), "foreground completion carries exit code");
  assert.ok(runs[2]?.required?.includes("message"), "foreground timeout explains the next step");
  assert.deepEqual(runs[2]?.properties?.status?.enum, ["running"]);

  const supervised = schemaOf("start_process");
  assert.equal(supervised?.type, "object", "start_process has only the supervised launch shape");
  assert.equal(supervised?.oneOf, undefined, "start_process never returns foreground run variants");
  assert.ok(supervised?.required?.includes("ready_checked"));
  assert.ok(supervised?.required?.includes("command_id"));
});
