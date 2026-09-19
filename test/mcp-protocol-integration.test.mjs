/**
 * MCP protocol integration test: boots the real `open-bridge serve` process and
 * checks the transport-level contracts a client depends on — session identity,
 * body limits, CORS, usage accounting and result shapes.
 *
 * Ported from the VS Code extension's `endpoint-integration.test.mjs` (29
 * checks), which the standalone app never carried over: its integration suite
 * covered the app-shell surface (console, settings, services, rotation) but not
 * the protocol guarantees the MCP endpoint makes to a client. Those are exactly
 * the guarantees an external evaluator probes — and the ones a regression would
 * silently break for every client at once.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {execFileSync, spawn} from "node:child_process";
import http from "node:http";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {routeTokenFor, waitForRuntime} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";
import Ajv from "ajv";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let home;
let dataHome;
let child;
let port;
let routeToken;
let serveExit = null;
let serveOutput = "";
const contractAjv = new Ajv({ allErrors: true, strict: false });
const inputValidators = new Map();
const outputValidators = new Map();
const validatedInputTools = new Set();
const validatedOutputTools = new Set();

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-protocol-"));
  dataHome = mkdtempSync(path.join(tmpdir(), "ob-protocol-data-"));
  execFileSync("git", ["init", "--quiet"], { cwd: home });
  execFileSync("git", ["config", "user.name", "Open Bridge protocol test"], { cwd: home });
  execFileSync("git", ["config", "user.email", "protocol-test@example.invalid"], { cwd: home });
  execFileSync("git", ["commit", "--allow-empty", "--quiet", "-m", "protocol baseline"], { cwd: home });
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", dataHome,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => { serveOutput += d; });
  child.stderr.on("data", d => { serveOutput += d; });
  child.on("exit", (code, signal) => { serveExit = { code, signal }; });
  const runtime = await waitForRuntime(dataHome, home);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(dataHome, home); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");

  // Compile the schemas that the running MCP endpoint actually advertises, not
  // a hand-copied test version. Every successful tools/call below is then
  // checked against both client-visible input and output contracts at one
  // common boundary.
  const { sessionId } = await openSession();
  assert.ok(sessionId, "the schema-audit session was initialized");
  const catalog = await mcpCall(sessionId, "tools/list", {});
  assert.equal(catalog.status, 200, "the schema-audit catalog is available");
  for (const tool of catalog.payload?.result?.tools ?? []) {
    if (tool.inputSchema) inputValidators.set(tool.name, contractAjv.compile(tool.inputSchema));
    if (tool.outputSchema) outputValidators.set(tool.name, contractAjv.compile(tool.outputSchema));
  }
  assert.equal(inputValidators.size, 39, "every published tool exposes a compilable input contract");
  assert.equal(outputValidators.size, 39, "every published tool exposes a compilable output contract");
});

after(async () => {
  try {
    const unexercisedInputs = [...inputValidators.keys()].filter(name => !validatedInputTools.has(name));
    assert.deepEqual(unexercisedInputs, [], "every published inputSchema has a successful live contract example");
    const unexercisedOutputs = [...outputValidators.keys()].filter(name => !validatedOutputTools.has(name));
    assert.deepEqual(unexercisedOutputs, [], "every published outputSchema has a successful live contract example");
  } finally {
    if (child && !child.killed) child.kill("SIGTERM");
    await delay(300);
    removeTempDir(home);
    removeTempDir(dataHome);
  }
});

function rawRequest(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers, agent: false, signal: AbortSignal.timeout(15_000) },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function lastSsePayload(body) {
  let payload;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data: ")) payload = JSON.parse(line.slice(6));
  }
  return payload;
}

let rpcId = 1;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} });
const jsonHeaders = extra => ({ "content-type": "application/json", accept: "application/json, text/event-stream", ...extra });

async function openSession() {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "protocol-test", version: "1" },
  })), jsonHeaders());
  const sessionId = res.headers["mcp-session-id"];
  if (sessionId) {
    await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      jsonHeaders({ "mcp-session-id": sessionId }));
  }
  return { res, sessionId };
}

async function mcpCall(sessionId, method, params) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc(method, params)),
    jsonHeaders({ "mcp-session-id": sessionId }));
  return { status: res.status, payload: res.status === 200 ? lastSsePayload(res.body) : null, body: res.body };
}

function assertPublishedInputSchema(name, args, payload) {
  const result = payload?.result;
  if (!result || result.isError) return;
  const validate = inputValidators.get(name);
  // Legacy aliases are compatibility entry points, not separately published
  // tools. Their canonical counterpart is validated by the same suite.
  if (!validate) return;

  assert.ok(
    validate(args),
    `${name} accepted input outside its published inputSchema: ${contractAjv.errorsText(validate.errors)}`,
  );
  validatedInputTools.add(name);
}

function assertPublishedOutputSchema(name, payload) {
  const result = payload?.result;
  if (!result || result.isError) return;
  const validate = outputValidators.get(name);
  // Legacy aliases are compatibility entry points, not separately published
  // tools. Their canonical counterpart is validated by the same suite.
  if (!validate) return;

  assert.ok(
    result.structuredContent && typeof result.structuredContent === "object",
    `${name} advertises an outputSchema and must return structuredContent`,
  );
  assert.ok(
    validate(result.structuredContent),
    `${name} structuredContent violates its published outputSchema: ${contractAjv.errorsText(validate.errors)}`,
  );
  validatedOutputTools.add(name);
}

async function callTool(sessionId, name, args) {
  const { status, payload } = await mcpCall(sessionId, "tools/call", { name, arguments: args });
  assertPublishedInputSchema(name, args, payload);
  assertPublishedOutputSchema(name, payload);
  return { status, payload, text: payload?.result?.content?.[0]?.text ?? "" };
}

async function usage() {
  const res = await rawRequest("GET", "/api/usage", null, {});
  assert.equal(res.status, 200);
  return JSON.parse(res.body).usage;
}

test("a failed call records WHY it failed, not just how long it took", async () => {
  // The audit line is the only trace a failure leaves: the console's activity
  // pane, `activity_log` search and the audit file all read it. It used to say
  // "Failed in 1 ms." and nothing else — the reason was in hand on the very
  // next line, on its way back to the caller, and simply not written down.
  // Debugging from the log alone meant reproducing the call to learn anything.
  const { sessionId } = await openSession();
  const failed = await callTool(sessionId, "set_todos", { todos: "not a list" });
  assert.match(failed.text, /todos must be an array/, "the caller is told what is wrong");

  await delay(300);
  const audit = readFileSync(path.join(dataHome, "audit.log"), "utf8")
    .split("\n").filter(Boolean).map(line => JSON.parse(line));
  const entry = audit.findLast(row => row.tool === "set_todos" && row.status === "error");
  assert.ok(entry, "the failure reached the audit log");
  assert.match(entry.message, /todos must be an array/,
    "and the log carries the same reason the caller got");
  // The duration is still there — it is just no longer the ONLY thing there.
  assert.match(entry.message, /^Failed in \d+ ms: /);
});

test("a rejected write says which field is wrong, and which tool reads", async () => {
  const { sessionId } = await openSession();

  // set_todos is write-only, so the commonest way to get an array error is
  // reaching for it to READ the list. Naming get_todos costs one clause.
  const notAList = await callTool(sessionId, "set_todos", { todos: "not a list" });
  assert.match(notAList.text, /use get_todos to read/, "the read tool is named, not just the bad parameter");

  // Naming the offending field beats listing all three and leaving the caller
  // to diff their payload against the list.
  const badStatus = await callTool(sessionId, "set_todos", {
    todos: [{ id: "1", title: "x", status: "doing" }],
  });
  assert.match(badStatus.text, /status must be pending, in_progress or completed/);
  assert.match(badStatus.text, /"doing"/, "the rejected value is quoted back");

  const noTitle = await callTool(sessionId, "set_todos", { todos: [{ id: "1", status: "pending" }] });
  assert.match(noTitle.text, /missing title/);
});

test("tools/list advertises the catalog and get_bridge_status agrees on the count", async () => {
  const { res, sessionId } = await openSession();
  assert.equal(res.status, 200);
  const listed = await mcpCall(sessionId, "tools/list", {});
  const tools = listed.payload?.result?.tools ?? [];
  assert.ok(tools.length >= 36, `expected the full catalog, got ${tools.length}`);
  assert.ok(tools.every(tool => tool.name && tool.inputSchema), "every tool carries a schema");
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length, "no duplicate tool names");

  const status = await callTool(sessionId, "get_bridge_status", {});
  const reported = JSON.parse(status.text).tool_count;
  assert.equal(reported, tools.length, "the status count must match what tools/list advertises");
});

test("tools/list declares the inputs that each operation branch needs", async () => {
  const { sessionId } = await openSession();
  const catalog = await mcpCall(sessionId, "tools/list", {});
  const tools = catalog.payload?.result?.tools ?? [];
  const input = name => tools.find(tool => tool.name === name)?.inputSchema;
  const branch = (schema, key, value) => schema?.oneOf?.find(entry => entry.properties?.[key]?.enum?.includes(value));

  assert.deepEqual(input("write_file")?.anyOf?.map(entry => entry.required),
    [["content"], ["content_base64"]], "write_file advertises that a payload is required");
  assert.deepEqual(input("apply_patch")?.oneOf?.map(entry => entry.required),
    [["patch"], ["patch_file"]], "apply_patch advertises its mutually exclusive sources");
  assert.deepEqual(branch(input("file_op"), "op", "copy")?.required,
    ["op", "source", "destination"], "copy advertises both endpoints");
  assert.deepEqual(branch(input("service"), "action", "start")?.required,
    ["action", "name"], "single-service actions advertise their name");
  assert.deepEqual(branch(input("service"), "action", "start_all")?.required,
    ["action"], "bulk service actions do not invent a name requirement");
  assert.deepEqual(input("wait")?.anyOf?.map(entry => entry.required),
    [["ms"], ["command_id"]], "wait exposes sleep and process-wait modes");
  assert.deepEqual(input("connectivity")?.anyOf?.map(entry => entry.required),
    [["url"], ["port"]], "connectivity exposes HTTP and TCP entry points");
});

test("outputSchema tools answer with structuredContent in the declared shape", async () => {
  const { sessionId } = await openSession();
  const services = await callTool(sessionId, "service_status", { detail: "definitions" });
  const structured = services.payload?.result?.structuredContent;
  assert.ok(structured && typeof structured === "object", "structuredContent is present");
  assert.ok(Array.isArray(structured.items), "service_status answers with the declared items envelope");

  // MCP requires structuredContent to be an object. The compatibility text for
  // these handlers remains a bare JSON array, but their schemas must describe
  // the actual typed envelope clients validate and read.
  const catalog = await mcpCall(sessionId, "tools/list", {});
  const catalogTools = catalog.payload?.result?.tools ?? [];
  for (const name of ["read_files", "service_status"]) {
    const definition = catalogTools.find(tool => tool.name === name);
    assert.equal(definition?.outputSchema?.type, "object", `${name} declares its object envelope`);
    assert.deepEqual(definition?.outputSchema?.required, ["items"]);
  }
  const activityDefinition = catalogTools.find(tool => tool.name === "activity_log");
  assert.equal(activityDefinition?.outputSchema?.oneOf?.length, 3, "activity_log declares every action variant");

  const written = await callTool(sessionId, "write_file", { path: "typed.txt", content: "typed" });
  assert.equal(written.status, 200, "the fixture file was written");
  const files = await callTool(sessionId, "read_files", { paths: ["typed.txt"] });
  assert.ok(Array.isArray(files.payload?.result?.structuredContent?.items),
    "read_files wraps its raw row array in typed items");
  assert.equal(files.payload?.result?.structuredContent?.items?.[0]?.path, "typed.txt");
  const createdDirectory = await callTool(sessionId, "file_op", { op: "create_directory", path: "typed-dir" });
  assert.equal(createdDirectory.payload?.result?.structuredContent?.created, true,
    "file_op create_directory keeps its specific result shape");
  const copied = await callTool(sessionId, "file_op", { op: "copy", source: "typed.txt", destination: "typed-copy.txt" });
  assert.equal(copied.payload?.result?.structuredContent?.destination, "typed-copy.txt");
  const moved = await callTool(sessionId, "file_op", { op: "move", source: "typed-copy.txt", destination: "typed-moved.txt" });
  assert.equal(moved.payload?.result?.structuredContent?.source, "typed-copy.txt");
  const deleted = await callTool(sessionId, "file_op", { op: "delete", path: "typed-moved.txt" });
  assert.equal(deleted.payload?.result?.structuredContent?.deleted, true);

  const savedService = await callTool(sessionId, "save_service", {
    name: "typed-service", group: "typed-group", command: `node -e "process.stdout.write('typed-service')"`,
  });
  assert.equal(savedService.status, 200, "the typed service fixture was saved");
  const startedService = await callTool(sessionId, "service", { action: "start", name: "typed-service" });
  assert.equal(startedService.payload?.result?.structuredContent?.status, "running");
  const restartedService = await callTool(sessionId, "service", { action: "restart", name: "typed-service" });
  assert.equal(restartedService.payload?.result?.structuredContent?.restarted, true);
  const startedServices = await callTool(sessionId, "service", { action: "start_all", group: "typed-group" });
  assert.ok(Array.isArray(startedServices.payload?.result?.structuredContent?.items),
    "service start_all uses the typed items envelope");
  const stoppedServices = await callTool(sessionId, "service", { action: "stop_all", group: "typed-group" });
  assert.ok(Array.isArray(stoppedServices.payload?.result?.structuredContent?.items),
    "service stop_all uses the typed items envelope");
  const deletedService = await callTool(sessionId, "service", { action: "delete", name: "typed-service" });
  assert.equal(deletedService.payload?.result?.structuredContent?.deleted, true);

  const recent = await callTool(sessionId, "activity_log", { action: "recent" });
  assert.ok(Array.isArray(recent.payload?.result?.structuredContent?.items),
    "activity_log recent uses the same object envelope");

  const status = await callTool(sessionId, "get_bridge_status", {});
  const shape = status.payload?.result?.structuredContent;
  assert.equal(typeof shape?.state, "string", "get_bridge_status declares a state field");
  assert.equal(typeof shape?.tool_count, "number");

  // A process-output page used to be text-only, despite carrying the cursor a
  // client needs to keep reading. It must now expose the same fields as typed
  // structuredContent, not merely a JSON-looking text block.
  const launched = await callTool(sessionId, "run_command", {
    command: `node -e "process.stdout.write('schema-page')"`,
  });
  const commandId = JSON.parse(launched.text).command_id;
  const foregroundLaunch = launched.payload?.result?.structuredContent;
  assert.equal(foregroundLaunch?.command_id, commandId);
  assert.equal(typeof foregroundLaunch?.exit_code, "number",
    "a completed foreground command exposes its typed exit result");
  const supervised = await callTool(sessionId, "start_process", {
    command: `node -e "process.stdout.write('schema-supervised')"`,
  });
  assert.equal(supervised.payload?.result?.structuredContent?.ready_checked, false,
    "a supervised launch exposes the no-readiness-check distinction");

  const snapshots = await callTool(sessionId, "get_process_snapshot", {});
  assert.ok(Array.isArray(snapshots.payload?.result?.structuredContent?.items),
    "an all-process snapshot is an items envelope");
  const snapshot = await callTool(sessionId, "get_process_snapshot", { command_id: commandId });
  assert.equal(snapshot.payload?.result?.structuredContent?.command_id, commandId,
    "a targeted process snapshot remains one object");
  const shells = await callTool(sessionId, "open_shell", { list: true });
  assert.ok(Array.isArray(shells.payload?.result?.structuredContent?.items),
    "open_shell list is an items envelope");

  const output = await callTool(sessionId, "read_process_output", { command_id: commandId });
  const page = output.payload?.result?.structuredContent;
  assert.equal(page?.command_id, commandId);
  assert.equal(page?.output, "schema-page");
  assert.equal(typeof page?.next_offset, "number");
  assert.equal(typeof page?.output_available_bytes, "number");
  assert.equal(typeof page?.dropped_bytes, "number");
  assert.equal(typeof page?.truncated, "boolean");

  const restarted = await callTool(sessionId, "process_control", { action: "restart", command_id: commandId });
  assert.equal(restarted.payload?.result?.structuredContent?.command_id, commandId);
  assert.equal(restarted.payload?.result?.structuredContent?.restarted, true,
    "process_control restart exposes its restart result");
  const terminated = await callTool(sessionId, "process_control", { action: "terminate", command_id: commandId });
  assert.equal(terminated.payload?.result?.structuredContent?.command_id, commandId);
  assert.equal(typeof terminated.payload?.result?.structuredContent?.terminated, "boolean",
    "process_control terminate exposes its final snapshot result");

  const shellName = "typed-output-shell";
  const openedShell = await callTool(sessionId, "open_shell", { name: shellName });
  assert.equal(typeof openedShell.payload?.result?.structuredContent?.command_id, "string");
  const shellCommand = await callTool(sessionId, "send_to_shell", { name: shellName, command: "printf schema-shell" });
  const shellResult = shellCommand.payload?.result?.structuredContent;
  assert.equal(shellResult?.name, shellName);
  assert.equal(shellResult?.output, "schema-shell");
  assert.equal(shellResult?.exit_code, 0);
  assert.equal(shellResult?.timed_out, false);
  assert.equal(shellResult?.shell_alive, true);
  const closedShell = await callTool(sessionId, "close_shell", { name: shellName });
  assert.deepEqual(closedShell.payload?.result?.structuredContent, { name: shellName, closed: true });
  const missingShell = await callTool(sessionId, "close_shell", { name: "not-open-typed-shell" });
  assert.deepEqual(missingShell.payload?.result?.structuredContent,
    { name: "not-open-typed-shell", closed: false, reason: "not_open" });

  const durationWait = await callTool(sessionId, "wait", { ms: 0 });
  assert.deepEqual(durationWait.payload?.result?.structuredContent, { waited_ms: 0 });
  const processWait = await callTool(sessionId, "wait", { command_id: commandId, timeout_ms: 0 });
  const waitedProcess = processWait.payload?.result?.structuredContent;
  assert.equal(waitedProcess?.command_id, commandId);
  assert.equal(typeof waitedProcess?.output, "string");
  assert.equal(typeof waitedProcess?.stdout, "string");
  assert.equal(typeof waitedProcess?.truncated, "boolean");
  const policy = await callTool(sessionId, "set_process_policy", {
    command_id: commandId, auto_restart: false, max_restarts: 0, restart_delay_ms: 0,
  });
  assert.deepEqual(policy.payload?.result?.structuredContent,
    { command_id: commandId, auto_restart: false, max_restarts: 0, restart_delay_ms: 0 });

  for (const name of ["send_to_shell", "set_process_policy"]) {
    const definition = catalogTools.find(tool => tool.name === name);
    assert.equal(definition?.outputSchema?.type, "object", `${name} declares its fixed object result`);
  }
  assert.equal(catalogTools.find(tool => tool.name === "close_shell")?.outputSchema?.oneOf?.length, 2,
    "close_shell declares close and not_open results");
  assert.equal(catalogTools.find(tool => tool.name === "wait")?.outputSchema?.oneOf?.length, 2,
    "wait declares duration and process results");
});

test("row pages expose reusable continuation offsets in live structuredContent", async () => {
  const { sessionId } = await openSession();
  const dir = "continuation-contract";
  const marker = "p5-continuation-marker";
  const created = await callTool(sessionId, "file_op", { op: "create_directory", path: dir });
  assert.equal(created.payload?.result?.structuredContent?.created, true);
  for (const name of ["one.txt", "two.txt"]) {
    const written = await callTool(sessionId, "write_file", {
      path: `${dir}/${name}`, content: `${marker} ${name}`,
    });
    assert.equal(written.status, 200, `fixture ${name} was written`);
  }

  const requireRowContinuation = (page, label) => {
    assert.equal(page?.truncated, true, `${label} reports an incomplete first page`);
    assert.equal(typeof page?.next_offset, "number", `${label} publishes a reusable offset`);
    assert.ok(page.next_offset > 0, `${label} advances its cursor`);
  };

  const directory = await callTool(sessionId, "list_directory", {
    path: dir, depth: 1, max_entries: 1,
  });
  const directoryPage = directory.payload?.result?.structuredContent;
  requireRowContinuation(directoryPage, "list_directory");
  assert.equal(directoryPage?.total, 2, "a flat directory page reports its exact total");
  const directoryNext = await callTool(sessionId, "list_directory", {
    path: dir, depth: 1, max_entries: 1, offset: directoryPage.next_offset,
  });
  assert.equal(directoryNext.payload?.result?.structuredContent?.next_offset, null,
    "the final directory page has a null continuation cursor");

  const found = await callTool(sessionId, "find_files", {
    path: dir, pattern: "*.txt", max_results: 1,
  });
  const foundPage = found.payload?.result?.structuredContent;
  requireRowContinuation(foundPage, "find_files");
  const foundNext = await callTool(sessionId, "find_files", {
    path: dir, pattern: "*.txt", max_results: 1, offset: foundPage.next_offset,
  });
  assert.equal(foundNext.payload?.result?.structuredContent?.next_offset, null,
    "the final file-find page has a null continuation cursor");
  assert.notEqual(foundNext.payload?.result?.structuredContent?.items?.[0], foundPage?.items?.[0],
    "find_files does not repeat the row consumed by its cursor");
  const zeroFind = await callTool(sessionId, "find_files", {
    path: dir, pattern: "*.txt", max_results: 0,
  });
  assert.deepEqual(zeroFind.payload?.result?.structuredContent?.items, []);
  assert.equal(zeroFind.payload?.result?.structuredContent?.next_offset, null,
    "a zero-sized find page does not publish a looping cursor");

  const searched = await callTool(sessionId, "search_files", {
    path: dir, query: marker, regex: false, max_results: 1,
  });
  const searchedPage = searched.payload?.result?.structuredContent;
  requireRowContinuation(searchedPage, "search_files");
  const searchedNext = await callTool(sessionId, "search_files", {
    path: dir, query: marker, regex: false, max_results: 1, offset: searchedPage.next_offset,
  });
  assert.equal(searchedNext.payload?.result?.structuredContent?.next_offset, null,
    "the final text-search page has a null continuation cursor");
  assert.notEqual(searchedNext.payload?.result?.structuredContent?.items?.[0]?.path, searchedPage?.items?.[0]?.path,
    "search_files does not repeat the match consumed by its cursor");
  const zeroSearch = await callTool(sessionId, "search_files", {
    path: dir, query: marker, regex: false, max_results: 0,
  });
  assert.deepEqual(zeroSearch.payload?.result?.structuredContent?.items, []);
  assert.equal(zeroSearch.payload?.result?.structuredContent?.next_offset, null,
    "a zero-sized text-search page does not publish a looping cursor");

  const activity = await callTool(sessionId, "activity_log", {
    action: "search", tool: "write_file", limit: 1,
  });
  const activityPage = activity.payload?.result?.structuredContent;
  requireRowContinuation(activityPage, "activity_log search");
  const activityNext = await callTool(sessionId, "activity_log", {
    action: "search", tool: "write_file", limit: 1, offset: activityPage.next_offset,
  });
  assert.ok(
    activityNext.payload?.result?.structuredContent?.next_offset === null ||
      typeof activityNext.payload?.result?.structuredContent?.next_offset === "number",
    "the continued audit page keeps the same nullable cursor contract",
  );
  assert.notDeepEqual(activityNext.payload?.result?.structuredContent?.entries?.[0], activityPage?.entries?.[0],
    "activity search does not repeat the entry consumed by its cursor");
});

test("remaining response schemas match live structuredContent", async () => {
  const { sessionId } = await openSession();
  const catalog = await mcpCall(sessionId, "tools/list", {});
  const tools = catalog.payload?.result?.tools ?? [];
  for (const name of ["write_file", "edit_block", "apply_patch", "workspace_brief", "save_service", "set_config_value", "get_config", "get_usage_stats", "report_progress", "get_todos", "read_service_log", "batch"]) {
    const schema = tools.find(tool => tool.name === name)?.outputSchema;
    assert.ok(schema?.required?.length, `${name} advertises required structured fields`);
  }

  const written = await callTool(sessionId, "write_file", { path: "remaining-shape.txt", content: "before" });
  assert.equal(written.payload?.result?.structuredContent?.mode, "overwrite");
  assert.equal(typeof written.payload?.result?.structuredContent?.sha256, "string");
  const edited = await callTool(sessionId, "edit_block", { path: "remaining-shape.txt", old_text: "before", new_text: "after" });
  assert.equal(edited.payload?.result?.structuredContent?.replacements, 1);
  assert.equal(typeof edited.payload?.result?.structuredContent?.diff, "string");

  const brief = await callTool(sessionId, "workspace_brief", {});
  assert.equal(typeof brief.payload?.result?.structuredContent?.workspace, "string");
  assert.ok(Array.isArray(brief.payload?.result?.structuredContent?.top_level_entries));
  const config = await callTool(sessionId, "get_config", {});
  assert.equal(typeof config.payload?.result?.structuredContent?.toolProfile, "string");
  const usageStats = await callTool(sessionId, "get_usage_stats", {});
  assert.equal(typeof usageStats.payload?.result?.structuredContent?.by_tool, "object");

  const saved = await callTool(sessionId, "save_service", {
    name: "remaining-shape-service", command: `node -e "process.stdout.write('remaining')"`,
  });
  assert.deepEqual(saved.payload?.result?.structuredContent, { name: "remaining-shape-service", saved: true });
  const serviceLog = await callTool(sessionId, "read_service_log", { name: "remaining-shape-service" });
  assert.equal(serviceLog.payload?.result?.structuredContent?.name, "remaining-shape-service");
  assert.equal(typeof serviceLog.payload?.result?.structuredContent?.next_offset, "number");

  const todos = await callTool(sessionId, "set_todos", { todos: [{ id: "remaining", title: "schema", status: "in_progress" }] });
  assert.deepEqual(todos.payload?.result?.structuredContent?.items, [{ id: "remaining", title: "schema", status: "in_progress" }]);
  const progress = await callTool(sessionId, "report_progress", { message: "testing", phase: "verifying", category: "test" });
  assert.equal(progress.payload?.result?.structuredContent?.received, true);
  const listedTodos = await callTool(sessionId, "get_todos", {});
  assert.equal(listedTodos.payload?.result?.structuredContent?.session_todos?.[0]?.id, "remaining");

  const probe = await callTool(sessionId, "connectivity", { target: "port", host: "127.0.0.1", port });
  assert.equal(probe.payload?.result?.structuredContent?.port, port);
  assert.equal(typeof probe.payload?.result?.structuredContent?.open, "boolean");
  const overview = await callTool(sessionId, "bridge_status", { section: "overview" });
  assert.equal(typeof overview.payload?.result?.structuredContent?.tool_count, "number");
  const locks = await callTool(sessionId, "bridge_status", { section: "locks" });
  assert.ok(Array.isArray(locks.payload?.result?.structuredContent?.held));
  const sessions = await callTool(sessionId, "bridge_status", { section: "sessions" });
  assert.ok(Array.isArray(sessions.payload?.result?.structuredContent?.items));

  const batch = await callTool(sessionId, "batch", { calls: [{ tool: "get_usage_stats" }] });
  assert.equal(batch.payload?.result?.structuredContent?.total, 1);
  assert.equal(batch.payload?.result?.structuredContent?.results?.[0]?.ok, true);
});

test("the schema audit exercises every remaining published output contract", async () => {
  const { sessionId } = await openSession();

  const written = await callTool(sessionId, "write_file", {
    path: "schema-audit-file.txt",
    content: "schema audit\n",
  });
  assert.equal(written.payload?.result?.isError, undefined);
  const info = await callTool(sessionId, "get_file_info", { path: "schema-audit-file.txt" });
  assert.equal(info.payload?.result?.structuredContent?.type, "file");

  const patch = [
    "*** Begin Patch",
    "*** Add File: schema-audit-patch.txt",
    "+schema audit patch",
    "*** End Patch",
    "",
  ].join("\n");
  const applied = await callTool(sessionId, "apply_patch", { patch });
  assert.equal(applied.payload?.result?.structuredContent?.applied, true);

  const review = await callTool(sessionId, "review_changes", { mark_reviewed: false });
  const reviewContent = review.payload?.result?.structuredContent;
  assert.equal(typeof reviewContent?.available, "boolean");
  assert.equal(reviewContent?.available, true, "the schema-audit workspace is a Git repository");
  assert.equal(reviewContent?.checkpoint_action, "established",
    "the first review establishes checkpoints even when mark_reviewed is false");
  assert.equal(typeof reviewContent?.working_tree?.clean, "boolean");
  assert.equal(reviewContent?.working_tree?.clean, false, "the new audit files are still uncommitted");
  assert.ok((reviewContent?.working_tree?.summary?.files ?? 0) >= 2,
    "working_tree counts current uncommitted audit files separately from the review baseline");

  // Keep the checkpoint, then add a later commit. The cumulative review must
  // retain that history while working_tree reports the now-clean checkout.
  execFileSync("git", ["add", "-A"], { cwd: home });
  execFileSync("git", ["commit", "--quiet", "-m", "schema audit checkpoint"], { cwd: home });
  writeFileSync(path.join(home, "committed-after-review.txt"), "reviewed commit\n");
  execFileSync("git", ["add", "committed-after-review.txt"], { cwd: home });
  execFileSync("git", ["commit", "--quiet", "-m", "committed after review checkpoint"], { cwd: home });
  const committedReview = await callTool(sessionId, "review_changes", { mark_reviewed: false });
  const committedContent = committedReview.payload?.result?.structuredContent;
  assert.ok((committedContent?.summary?.files ?? 0) >= 1,
    "the cumulative review keeps changes that were committed after its checkpoint");
  assert.equal(committedContent?.working_tree?.clean, true,
    "a later committed change does not make the current working tree dirty");
  assert.deepEqual(committedContent?.working_tree?.summary, { files: 0, additions: 0, deletions: 0 });
  assert.equal(committedContent?.checkpoint_action, "retained",
    "mark_reviewed:false keeps an existing last-shown checkpoint");

  const advancedReview = await callTool(sessionId, "review_changes", { mark_reviewed: true });
  const advancedContent = advancedReview.payload?.result?.structuredContent;
  assert.equal(advancedContent?.checkpoint_action, "advanced",
    "mark_reviewed:true explicitly advances an existing last-shown checkpoint");
  assert.equal(advancedContent?.baseline_advanced, true);

  const interactive = await callTool(sessionId, "start_process", {
    command: `node -e "process.stdin.once('data', data => { process.stdout.write(data); process.exit(0); })"`,
  });
  const interactiveId = interactive.payload?.result?.structuredContent?.command_id;
  assert.equal(typeof interactiveId, "string");
  const interacted = await callTool(sessionId, "interact_with_process", {
    command_id: interactiveId,
    input: "schema-interaction",
    wait_ms: 1000,
  });
  assert.equal(interacted.payload?.result?.structuredContent?.command_id, interactiveId);

  const configured = await callTool(sessionId, "set_config_value", { key: "logMaxBytes", value: 262144 });
  assert.equal(configured.payload?.result?.structuredContent?.key, "openBridge.logMaxBytes");
  const scripted = await callTool(sessionId, "run_script", { source: "return { schema_audit: true };" });
  assert.equal(scripted.payload?.result?.structuredContent?.ok, true);
  const skills = await callTool(sessionId, "list_skills", {});
  assert.equal(typeof skills.payload?.result?.structuredContent?.count, "number");
  const notification = await callTool(sessionId, "notify", { event: "finished", title: "schema audit" });
  assert.equal(notification.payload?.result?.structuredContent?.event, "finished");
});

test("a forged session id is refused and the server keeps serving", async () => {
  const forged = await mcpCall("0000000000000000000000000000dead", "tools/call", { name: "get_bridge_status", arguments: {} });
  assert.ok(forged.status === 404 || forged.status === 400, `a forged session must be refused, got ${forged.status}`);
  assert.equal(serveExit, null, "the server survived a forged session");

  const { sessionId } = await openSession();
  const ok = await callTool(sessionId, "get_bridge_status", {});
  assert.equal(ok.status, 200, "and still serves real sessions");
});

test("a malformed JSON body is answered with a parse error and the server keeps serving", async () => {
  const { sessionId } = await openSession();
  const broken = await rawRequest("POST", `/mcp/${routeToken}`, '{"jsonrpc": "2.0", "id": 1, "method": ',
    jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(broken.status, 400, "a truncated body is the caller's error, not a session kill");
  assert.equal(JSON.parse(broken.body).error?.code, -32700, "the JSON-RPC parse error code is reported");

  const ok = await callTool(sessionId, "get_bridge_status", {});
  assert.equal(ok.status, 200, "the same session still works afterwards");
});

test("an oversized body is rejected before it is buffered", async () => {
  const { sessionId } = await openSession();
  const oversized = `{"pad":"${"x".repeat(8 * 1024 * 1024 + 1024)}"}`;
  const res = await rawRequest("POST", `/mcp/${routeToken}`, oversized, jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(res.status, 400);
  assert.match(res.body, /exceeds/i, "the refusal names the size limit");
  const ok = await callTool(sessionId, "get_bridge_status", {});
  assert.equal(ok.status, 200);
});

test("CORS preflight is answered 204 and responses expose the session header", async () => {
  const preflight = await rawRequest("OPTIONS", `/mcp/${routeToken}`, null, {
    origin: "https://example.test",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type, mcp-session-id",
  });
  assert.equal(preflight.status, 204, "browser-hosted MCP clients need a preflight answer");
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.match(String(preflight.headers["access-control-allow-methods"]), /POST/);

  const { res } = await openSession();
  assert.equal(res.headers["access-control-expose-headers"], "mcp-session-id");
});

test("usage counters stay consistent, and batch sub-calls are not double counted", async () => {
  const { sessionId } = await openSession();
  const baseline = await usage();

  const ok = await callTool(sessionId, "get_bridge_status", {});
  assert.equal(ok.payload?.result?.isError, undefined);

  const unknown = await callTool(sessionId, "definitely_no_such_tool", {});
  assert.equal(unknown.payload?.result?.isError, true, "an unknown tool is a tool-level error");

  const batched = await mcpCall(sessionId, "tools/call", {
    name: "batch",
    arguments: { calls: [
      { tool: "get_bridge_status", arguments: {} },
      { tool: "list_services", arguments: {} },
    ] },
  });
  assert.equal(batched.status, 200);

  const totals = await usage();
  assert.equal(totals.calls, totals.successes + totals.failures, "every call is exactly one outcome");
  assert.equal(totals.calls - baseline.calls, 3, "batch counts once, not once per sub-call");
  assert.equal(totals.by_tool.definitely_no_such_tool, undefined, "unknown tools stay out of by_tool");
});

test("a command that cannot run reports a real failure, never a phantom success", async () => {
  const { sessionId } = await openSession();
  const missingCwd = await callTool(sessionId, "run_command", {
    command: "echo should-not-run",
    cwd: path.join(home, "definitely", "missing", "directory"),
  });
  const result = missingCwd.payload?.result;
  const text = missingCwd.text;
  const failed = result?.isError === true
    || /ENOENT|no such file|not found|cannot find/i.test(text)
    || (JSON.parse(text || "{}").exit_code ?? 0) !== 0;
  assert.ok(failed, `a spawn that cannot start must not look like success: ${text.slice(0, 300)}`);

  const alive = await callTool(sessionId, "run_command", { command: "echo still-here" });
  assert.match(alive.text, /still-here/, "the server keeps serving after a failed spawn");
  assert.equal(serveExit, null, `serve died during the protocol suite:\n${serveOutput.slice(-600)}`);
});

test("the session table reports the handshake time and a cumulative call count", async () => {
  // The 会话 page's 「首次连接」 and 「调用数」 columns: both are per-session facts
  // only the server knows, so the wire shape is pinned here rather than in a probe.
  const { sessionId } = await openSession();
  assert.ok(sessionId, "the handshake assigned a session id");

  const rowFor = async () => {
    const res = await rawRequest("GET", "/api/sessions", null, {});
    assert.equal(res.status, 200);
    const row = JSON.parse(res.body).sessions.find(candidate => candidate.id === sessionId);
    assert.ok(row, "the session is listed");
    return row;
  };

  const fresh = await rowFor();
  assert.equal(fresh.calls, 0, "a session that has only handshaken has made no calls");
  assert.match(fresh.connected_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.ok(Date.parse(fresh.connected_at) <= Date.now(), "the handshake is in the past");
  assert.ok(fresh.idle_ms >= 0);

  await callTool(sessionId, "get_bridge_status", {});
  await callTool(sessionId, "list_services", {});
  const counted = await rowFor();
  assert.equal(counted.calls, 2, "each served call is counted once, on its own session");
  assert.equal(counted.connected_at, fresh.connected_at, "the handshake time does not move");

  const listed = JSON.parse((await callTool(sessionId, "list_sessions", {})).text);
  const row = listed.find(entry => entry.session_id === sessionId);
  assert.ok(row, "list_sessions knows this session");
  assert.equal(row.calls, 3, "the tool counts its own call too");
  assert.match(row.connected_at, /^\d{4}-\d\d-\d\dT/);
});

test("closing a session needs an unambiguous id; an ambiguous prefix closes nothing", async () => {
  // Session ids are random, so the collision is produced rather than assumed:
  // handshake until two ids share a first character, then ask the API to close
  // by that one character. The old route took the first startsWith hit in
  // insertion order — which may not be the session the operator meant.
  const ids = [];
  let pair = null;
  for (let attempt = 0; attempt < 40 && !pair; attempt += 1) {
    const { sessionId } = await openSession();
    if (!sessionId) continue;
    pair = ids.find(id => id[0] === sessionId[0]) ?? null;
    ids.push(sessionId);
    if (pair) pair = [pair, sessionId];
  }
  assert.ok(pair, `no two of ${ids.length} sessions shared a first character`);

  const close = async id => {
    const res = await rawRequest("POST", "/api/sessions/close", JSON.stringify({ id }),
      { "content-type": "application/json", "x-open-bridge-console": routeToken });
    return { status: res.status, body: res.body };
  };

  const ambiguous = await close(pair[0][0]);
  assert.equal(ambiguous.status, 400, ambiguous.body);
  assert.match(ambiguous.body, /前缀不唯一|prefix/);

  const listed = JSON.parse((await rawRequest("GET", "/api/sessions", null, {})).body).sessions.map(row => row.id);
  assert.ok(listed.includes(pair[0]) && listed.includes(pair[1]), "neither session was touched");

  const exact = await close(pair[0]);
  assert.equal(exact.status, 200, exact.body);
  assert.equal(JSON.parse(exact.body).closed, pair[0], "the exact id closes exactly the session asked for");
  const remaining = JSON.parse((await rawRequest("GET", "/api/sessions", null, {})).body).sessions.map(row => row.id);
  assert.equal(remaining.includes(pair[0]), false, "the intended session is gone");
  assert.ok(remaining.includes(pair[1]), "the other one is still connected");
});
