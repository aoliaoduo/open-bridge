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
import { CONFIG_DEFAULTS } from "../src/bridge/config/config-defaults.js";

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

test("read_files declares successful rows, failed rows, and their recovery cursors", () => {
  const rows = itemsOf(schemaOf("read_files"))?.items;
  assert.equal(rows?.oneOf?.length, 2, "each requested path returns either an error row or a data row");
  const success = rows?.oneOf?.find(variant => variant.required?.includes("content"));
  assert.deepEqual(success?.required, ["path", "content", "encoding", "sha256", "truncated", "bytes_returned", "bytes_total"]);
  assert.deepEqual(success?.properties?.encoding?.enum, ["utf8", "base64"]);
  assert.deepEqual(success?.properties?.next_offset?.type, ["number", "null"]);
  assert.deepEqual(success?.properties?.next_start_line?.type, ["number", "null"]);
  const failure = rows?.oneOf?.find(variant => variant.required?.includes("error"));
  assert.deepEqual(failure?.required, ["path", "error"]);
});

test("activity_log declares all three action result variants", () => {
  const variants = schemaOf("activity_log")?.oneOf ?? [];
  assert.equal(variants.length, 3, "recent, search and clear each have a schema");

  const [recent, search, clear] = variants;
  assert.equal(recent?.type, "object");
  assert.deepEqual(recent?.required, ["items"]);
  assert.equal(itemsOf(recent)?.type, "array");
  assert.ok(itemsOf(recent)?.items, "recent rows are described");

  assert.deepEqual(search?.required, ["entries", "total_scanned", "truncated", "next_offset"]);
  assert.equal(search?.properties?.entries?.type, "array");
  assert.equal(search?.properties?.truncated?.type, "boolean");
  assert.deepEqual(search?.properties?.next_offset?.type, ["number", "null"]);

  assert.deepEqual(clear?.required, ["cleared_memory_entries", "live_truncated", "rotated_removed"]);
  assert.equal(clear?.properties?.cleared_memory_entries?.type, "number");
  assert.equal(clear?.properties?.live_truncated?.type, "boolean");
  assert.equal(clear?.properties?.rotated_removed?.type, "boolean");
});

test("row-page tools publish a nullable continuation cursor", () => {
  for (const name of PAGE_RETURNING) {
    const schema = schemaOf(name);
    assert.equal(schema?.type, "object", `${name} answers with {items, truncated, next_offset}`);
    assert.ok(schema?.properties && "items" in schema.properties, `${name} must declare its rows`);
    assert.equal(schema?.properties?.truncated?.type, "boolean", `${name} declares truncation`);
    assert.deepEqual(schema?.properties?.next_offset?.type, ["number", "null"],
      `${name} uses a nullable terminal continuation cursor`);
    const expected = name === "list_directory"
      ? ["items", "next_offset", "total", "truncated"]
      : name === "search_files"
        ? ["items", "next_offset", "partial", "truncated"]
        : ["items", "next_offset", "truncated"];
    assert.deepEqual([...(schema?.required ?? [])].sort(), expected);
  }
  assert.deepEqual(schemaOf("list_directory")?.properties?.total?.type, ["number", "null"],
    "directory pages always state whether an exact flat total is available");
  assert.equal(schemaOf("search_files")?.properties?.partial?.type, "boolean",
    "search pages distinguish a full search from one with unreadable/errored paths");
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
  assert.equal(itemsOf(actions[4])?.items?.oneOf?.length, 3,
    "batch rows cover successful starts, failed starts and stops");
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

test("shell lifecycle and wait tools declare their input-dependent results", () => {
  const shellCommand = schemaOf("send_to_shell");
  assert.equal(shellCommand?.type, "object");
  for (const key of ["command_id", "output", "exit_code", "timed_out", "shell_alive"]) {
    assert.ok(shellCommand?.required?.includes(key), `send_to_shell requires ${key}`);
  }

  const close = schemaOf("close_shell")?.oneOf ?? [];
  assert.equal(close.length, 2, "close_shell distinguishes close from not_open");
  assert.deepEqual(close[0]?.required, ["name", "closed"]);
  assert.deepEqual(close[1]?.required, ["name", "closed", "reason"]);

  const waits = schemaOf("wait")?.oneOf ?? [];
  assert.equal(waits.length, 2, "wait distinguishes duration and command waits");
  assert.deepEqual(waits[0]?.required, ["waited_ms"]);
  for (const key of ["command_id", "output", "stdout", "stderr", "truncated"]) {
    assert.ok(waits[1]?.required?.includes(key), `wait command branch requires ${key}`);
  }

  const policy = schemaOf("set_process_policy");
  assert.deepEqual(policy?.required, ["command_id", "auto_restart", "max_restarts", "restart_delay_ms"]);
});

test("remaining write, status and batch tools publish concrete structured results", () => {
  for (const name of [
    "write_file", "edit_block", "apply_patch", "workspace_brief", "save_service", "set_config_value",
    "get_config", "get_usage_stats", "report_progress", "get_todos", "read_service_log", "batch",
  ]) {
    const schema = schemaOf(name);
    assert.ok(schema?.required?.length, `${name} declares required result fields`);
  }
  const review = schemaOf("review_changes");
  assert.equal(review?.oneOf?.length, 2, "review distinguishes unavailable and available workspaces");
  const availableReview = review?.oneOf?.find(branch => branch.properties?.available?.enum?.[0] === true);
  assert.ok(availableReview?.required?.includes("working_tree"), "review declares its current-worktree fact");
  assert.ok(availableReview?.required?.includes("checkpoint_action"), "review declares what it did to the checkpoint");
  assert.deepEqual(availableReview?.properties?.checkpoint_action?.enum, ["established", "rebuilt", "advanced", "retained"]);
  assert.deepEqual(availableReview?.properties?.working_tree?.required, ["clean", "summary"]);
  assert.equal(availableReview?.properties?.working_tree?.properties?.clean?.type, "boolean");
  assert.equal(availableReview?.properties?.working_tree?.properties?.summary?.type, "object");
  assert.equal(schemaOf("connectivity")?.oneOf?.length, 2, "connectivity distinguishes TCP and HTTP probes");
  assert.equal(schemaOf("bridge_status")?.oneOf?.length, 4, "bridge_status declares all four sections");
  assert.deepEqual(schemaOf("set_todos")?.required, ["items"], "set_todos uses the structured array envelope");
  for (const name of ["read_process_output", "interact_with_process"]) {
    for (const key of ["command_id", "stream", "next_offset", "truncated"]) {
      assert.ok(schemaOf(name)?.required?.includes(key), `${name} pages require ${key}`);
    }
  }
  const serviceLog = schemaOf("read_service_log");
  for (const key of ["offset", "next_offset", "truncated"]) {
    assert.ok(serviceLog?.required?.includes(key), `service-log pages require ${key}`);
  }
  assert.equal(serviceLog?.properties?.next_offset?.type, "number",
    "streaming logs expose an absolute byte cursor even at the current end");
});
