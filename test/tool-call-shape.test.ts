/**
 * The tool catalog's own contract: what `tools/list` offers, what the
 * dispatcher can actually run, and what the old names still mean.
 *
 * Three things are worth a test here, because all three are easy to break
 * silently:
 *
 *  - **Parity.** Every advertised tool must have a handler and every handler
 *    must be advertised. A name that is advertised but not runnable is a lie a
 *    client only discovers by calling it.
 *  - **The family vocabulary matches the definitions.** The action lists live in
 *    `tool-call-shape.ts` and are enforced at runtime; if a definition's enum
 *    drifts from that list, the client sees a value the server refuses (or the
 *    reverse).
 *  - **Legacy names stay complete and unambiguous.** Every name that used to be
 *    advertised resolves to an advertised tool, arguments are re-labelled rather
 *    than dropped, and a caller cannot smuggle a different action through an old
 *    name.
 *
 * The dispatcher's handler table is read from its source text on purpose: importing
 * it would initialize the host, the state and the config, which a unit test must
 * not do to a real environment.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CORE_TOOLS, TOOL_DEFINITIONS } from "../src/mcp/tool-definitions.js";
import {
  FAMILY_ACTIONS, FAMILY_PARAMS, LEGACY_REWRITES, legacyToolNames, normalizeToolCall,
} from "../src/bridge/tool-call-shape.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const advertised = new Set(TOOL_DEFINITIONS.map(tool => tool.name));

/** Handler names, read out of the dispatcher's table. */
function handlerNames(): Set<string> {
  const source = readFileSync(path.join(repoRoot, "src", "bridge", "dispatcher.ts"), "utf8");
  const start = source.indexOf("const HANDLERS: Record<string, Handler> = {");
  const end = source.indexOf("\n};", start);
  assert.notEqual(start, -1, "dispatcher.ts lost its HANDLERS table");
  assert.notEqual(end, -1, "dispatcher.ts's HANDLERS table is unterminated");
  const body = source.slice(start, end);
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const match = /^ {2}([a-z_0-9]+):/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

test("every advertised tool has a handler, and every handler is advertised", () => {
  const handlers = handlerNames();
  const missingHandler = [...advertised].filter(name => !handlers.has(name)).sort();
  const unadvertised = [...handlers].filter(name => !advertised.has(name)).sort();
  assert.deepEqual(missingHandler, [], `advertised but not runnable: ${missingHandler.join(", ")}`);
  assert.deepEqual(unadvertised, [], `runnable but not advertised: ${unadvertised.join(", ")}`);
});

test("the family vocabulary and the definitions agree", () => {
  const byName = new Map(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));
  for (const [family, actions] of Object.entries(FAMILY_ACTIONS)) {
    const definition = byName.get(family);
    assert.ok(definition, `${family} is not advertised`);
    const property = FAMILY_PARAMS[family as keyof typeof FAMILY_PARAMS];
    const enumValues = (definition.inputSchema.properties as Record<string, { enum?: readonly string[] }>)[property]?.enum ?? [];
    assert.deepEqual([...enumValues].sort(), [...actions].sort(), `${family}'s ${property} enum drifted from FAMILY_ACTIONS`);
  }
});

test("a family tool is only its discriminator; nothing else is a family", () => {
  // The families must never join the legacy table: a name is either advertised
  // or an alias for something advertised, never both.
  for (const name of Object.keys(FAMILY_ACTIONS)) {
    assert.equal(LEGACY_REWRITES[name], undefined, `${name} is both a family and a legacy name`);
  }
  const legacy = new Set(legacyToolNames());
  const overlap = [...advertised].filter(name => legacy.has(name));
  assert.deepEqual(overlap, [], `advertised names that are also legacy aliases: ${overlap.join(", ")}`);
});

test("every legacy name resolves to an advertised tool", () => {
  for (const name of legacyToolNames()) {
    const call = normalizeToolCall(name, {});
    assert.ok(advertised.has(call.tool), `${name} -> ${call.tool}, which is not advertised`);
    assert.equal(call.alias?.used, name);
    assert.equal(call.alias?.replaced_by, call.tool);
  }
});

test("legacy arguments are re-labelled, one case per name", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["start_service", { name: "web" }, { name: "web", action: "start" }],
    ["stop_service", { name: "web" }, { name: "web", action: "stop" }],
    ["restart_service", { name: "web" }, { name: "web", action: "restart" }],
    ["delete_service", { name: "web" }, { name: "web", action: "delete" }],
    ["start_all_services", { group: "dev", parallel: false }, { group: "dev", parallel: false, action: "start_all" }],
    ["stop_all_services", { group: "dev" }, { group: "dev", action: "stop_all" }],
    ["list_services", { ignored: true }, { detail: "definitions" }],
    ["create_directory", { path: "src/new" }, { path: "src/new", op: "create_directory" }],
    ["copy_file", { source: "a", destination: "b", overwrite: true }, { source: "a", destination: "b", overwrite: true, op: "copy" }],
    ["move_file", { source: "a", destination: "b" }, { source: "a", destination: "b", op: "move" }],
    ["delete_file", { path: "a", recursive: true }, { path: "a", recursive: true, op: "delete" }],
    ["restart_process", { command_id: "c1", delay_ms: 50 }, { command_id: "c1", delay_ms: 50, action: "restart" }],
    ["force_terminate", { command_id: "c1" }, { command_id: "c1", action: "terminate" }],
    ["wait_process", { command_id: "c1", timeout_ms: 1000 }, { command_id: "c1", timeout_ms: 1000 }],
    ["get_bridge_status", {}, { section: "overview" }],
    ["get_auth_status", {}, { section: "auth" }],
    ["get_lock_status", {}, { section: "locks" }],
    ["list_sessions", {}, { section: "sessions" }],
    ["get_recent_activity", { max_results: 5 }, { max_results: 5, action: "recent" }],
    ["search_activity_log", { tool: "run_command", limit: 10 }, { tool: "run_command", limit: 10, action: "search" }],
    ["clear_activity_log", {}, { action: "clear" }],
    ["check_port", { host: "127.0.0.1", port: 8080 }, { host: "127.0.0.1", port: 8080, target: "port" }],
    ["check_http", { url: "http://x/health" }, { url: "http://x/health", target: "http" }],
    ["list_shells", {}, { list: true }],
  ];

  assert.deepEqual(
    cases.map(([name]) => name).sort(),
    legacyToolNames().sort(),
    "this table must cover every legacy name exactly once",
  );

  for (const [name, input, expected] of cases) {
    const call = normalizeToolCall(name, input);
    assert.deepEqual(call.args, expected, name);
    // Undefined values are absence: a rewrite must not forward `{name: undefined}`.
    for (const value of Object.values(call.args)) assert.notEqual(value, undefined, `${name} forwarded an undefined argument`);
  }
});

test("the discriminator of a rewrite cannot be overridden by the caller", () => {
  const call = normalizeToolCall("start_service", { name: "web", action: "delete" });
  assert.equal(call.args.action, "start", "a legacy name must not be a back door to another action");
});

test("an unknown name is passed through untouched", () => {
  const call = normalizeToolCall("read_fil", { path: "a" });
  assert.equal(call.tool, "read_fil");
  assert.deepEqual(call.args, { path: "a" });
  assert.equal(call.alias, undefined);
});

test("the canonical call is described the way a hint would write it", () => {
  const call = normalizeToolCall("check_http", { url: "http://x" });
  assert.equal(call.alias?.call, 'connectivity{target:"http"}');
  assert.deepEqual(normalizeToolCall("wait", { ms: 5 }), { tool: "wait", args: { ms: 5 } });
});

test("a declared boolean is read in any encoding a client sends", () => {
  const tools = TOOL_DEFINITIONS as ReadonlyArray<{
    name: string;
    inputSchema?: { properties?: Record<string, { type?: unknown }> };
  }>;
  let checked = 0;
  for (const tool of tools) {
    for (const [key, schema] of Object.entries(tool.inputSchema?.properties ?? {})) {
      if (schema?.type !== "boolean") continue;
      checked += 1;
      assert.equal(normalizeToolCall(tool.name, { [key]: "false" }).args[key], false,
        `${tool.name}.${key} must read the string "false" as false`);
      assert.equal(normalizeToolCall(tool.name, { [key]: "true" }).args[key], true,
        `${tool.name}.${key} must read the string "true" as true`);
      assert.equal(normalizeToolCall(tool.name, { [key]: 0 }).args[key], false,
        `${tool.name}.${key} must read 0 as false`);
    }
  }
  assert.ok(checked >= 10, `the catalog declares boolean inputs; saw ${checked}`);
});

test("a legacy name normalizes its booleans in the canonical vocabulary", () => {
  assert.deepEqual(normalizeToolCall("delete_file", { path: "a", recursive: "true" }).args,
    { path: "a", recursive: true, op: "delete" });
  assert.deepEqual(normalizeToolCall("open_shell", { list: "false" }).args, { list: false });
  assert.deepEqual(normalizeToolCall("list_shells", {}).args, { list: true });
});

test("a value that is not a boolean stays untouched for the handler to refuse", () => {
  const call = normalizeToolCall("file_op", { op: "copy", source: "a", destination: "b", overwrite: "nope" });
  assert.deepEqual(call.args, { op: "copy", source: "a", destination: "b", overwrite: "nope" });
  const unknown = normalizeToolCall("no_such_tool", { flag: "false" });
  assert.deepEqual(unknown.args, { flag: "false" });
});

test("the core profile points at tools that still exist", () => {
  // The reviewer's everyday set must not name something the merge removed.
  const gone = [...CORE_TOOLS].filter(name => !advertised.has(name));
  assert.deepEqual(gone, [], `core profile names that no longer exist: ${gone.join(", ")}`);
});
