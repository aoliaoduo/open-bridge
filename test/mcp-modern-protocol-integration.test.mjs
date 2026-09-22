/**
 * Modern-protocol integration test: boots the real `open-bridge serve` process
 * and drives the 2026-07-28-era, per-request, stateless MCP protocol over HTTP.
 *
 * Why this file exists next to `mcp-protocol-integration.test.mjs`: from the
 * 2026-07-28 revision onward MCP is request-oriented. There is no `initialize`
 * handshake and no session id — every request carries its own envelope in
 * `params._meta` plus `MCP-Protocol-Version` / `MCP-Method` headers. The Bridge
 * serves that era and the older stateful one from the same `/mcp/<token>`
 * endpoint, and the choice is made per request, never by configuration.
 *
 * These checks are the contract a modern client actually depends on:
 * discovery advertises the revision, a session id is never minted, tool calls
 * work with no prior handshake, and the legacy era still behaves exactly as it
 * did before (a session id, and an error reported as `isError` in the result
 * rather than a JSON-RPC error).
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {spawn} from "node:child_process";
import http from "node:http";
import {mkdtempSync, rmSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import {tmpdir} from "node:os";
import path from "node:path";
import {routeTokenFor, runtimeFileFor, waitForRuntime} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const MODERN_REVISION = "2026-07-28";

let home;
let child;
let port;
let routeToken;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-modern-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(home, home); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  removeTempDir(home);
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

let rpcId = 1;

/** The per-request envelope a modern client sends, plus its headers. */
function modernEnvelope(method, params) {
  return {
    jsonrpc: "2.0",
    id: rpcId++,
    method,
    params: {
      ...(params ?? {}),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_REVISION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "modern-protocol-test", version: "1" },
      },
    },
  };
}

/**
 * The modern envelope is header-driven as well as body-driven: for a request
 * that names a target (`tools/call`), the `MCP-Name` header must agree with
 * `params.name` or the server rejects it as a header/body mismatch. That check
 * is the protocol's own anti-smuggling rule, so the test must satisfy it the way
 * a real client does.
 */
function modernHeaders(method, params) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MODERN_REVISION,
    "mcp-method": method,
  };
  const name = params?.name;
  if (typeof name === "string" && name) headers["mcp-name"] = name;
  return headers;
}

/** A modern response may be plain JSON or a single SSE frame; accept both. */
function decode(body) {
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
  }
  return JSON.parse(body);
}

async function modern(method, params, extraHeaders = {}) {
  const res = await rawRequest(
    "POST",
    `/mcp/${routeToken}`,
    JSON.stringify(modernEnvelope(method, params)),
    { ...modernHeaders(method, params), ...extraHeaders },
  );
  return {
    status: res.status,
    sessionId: res.headers["mcp-session-id"],
    payload: res.body ? decode(res.body) : null,
  };
}

test("server/discover advertises the 2026-07-28 revision with no session", async () => {
  const { status, payload, sessionId } = await modern("server/discover");
  assert.equal(status, 200, payload ? JSON.stringify(payload) : "");
  const versions = payload?.result?.supportedVersions ?? [];
  assert.ok(
    versions.includes(MODERN_REVISION),
    `supportedVersions must advertise ${MODERN_REVISION}, got ${JSON.stringify(versions)}`,
  );
  assert.equal(sessionId, undefined, "a modern request must not mint a session id");
});

test("tools/list answers with the full catalog and no handshake", async () => {
  // Deliberately no initialize: the modern era has no handshake to perform.
  const { status, payload, sessionId } = await modern("tools/list");
  assert.equal(status, 200);
  assert.equal(sessionId, undefined, "no session id on the modern path");

  const tools = payload?.result?.tools ?? [];
  assert.ok(tools.length >= 36, `expected the full catalog, got ${tools.length}`);
  assert.ok(tools.every(tool => tool.name && tool.inputSchema), "every tool carries a schema");
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length, "no duplicate tool names");

  // Same catalog as the legacy path: the count the status tool reports must agree.
  const statusCall = await modern("tools/call", { name: "get_bridge_status", arguments: {} });
  const reported = JSON.parse(statusCall.payload.result.content[0].text).tool_count;
  assert.equal(reported, tools.length, "get_bridge_status and tools/list agree on the count");
});

test("tools/list carries behaviour annotations but the same catalog", async () => {
  const { payload } = await modern("tools/list");
  const tools = payload?.result?.tools ?? [];
  const byName = new Map(tools.map(tool => [tool.name, tool]));

  // Hints are information for the client; they must be present and well-formed.
  for (const tool of tools) {
    assert.ok(tool.annotations, `${tool.name} carries annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", `${tool.name}.readOnlyHint is a boolean`);
    assert.equal(typeof tool.annotations.idempotentHint, "boolean", `${tool.name}.idempotentHint is a boolean`);
    assert.equal(typeof tool.annotations.openWorldHint, "boolean", `${tool.name}.openWorldHint is a boolean`);
    if (tool.annotations.destructiveHint !== undefined) {
      assert.equal(typeof tool.annotations.destructiveHint, "boolean", `${tool.name}.destructiveHint is a boolean`);
    }
  }

  // Spot-check the semantics that matter most: a pure read is read-only, and a
  // tool that can overwrite existing content never claims to be non-destructive.
  assert.equal(byName.get("read_files").annotations.readOnlyHint, true);
  assert.equal(byName.get("list_directory").annotations.readOnlyHint, true);
  assert.equal(byName.get("bridge_status").annotations.readOnlyHint, true);
  assert.equal(byName.get("run_command").annotations.readOnlyHint, false);
  assert.notEqual(byName.get("run_command").annotations.destructiveHint, false,
    "an arbitrary shell command must not promise to be harmless");
  assert.notEqual(byName.get("file_op").annotations.destructiveHint, false,
    "the family can delete, so it must not claim to be non-destructive");
  assert.equal(byName.get("file_op").annotations.readOnlyHint, false,
    "the family owns a delete, so it is not read-only");
  assert.equal(byName.get("connectivity").annotations.openWorldHint, true,
    "a probe leaves the machine");
  assert.equal(byName.get("read_files").annotations.openWorldHint, false);

  // The added hints must not change which tools exist or what they accept.
  assert.ok(tools.length >= 36, `the merged catalog is smaller but not gutted, got ${tools.length}`);
  assert.ok(tools.every(tool => tool.inputSchema), "every tool still carries its input schema");
});

test("annotations do not gate anything: a non-read-only tool still runs unattended", async () => {
  // The whole point of the hints is that they inform without restricting. A
  // destructiveHint tool must still execute with no server-side confirmation.
  const { status, payload } = await modern("tools/call", {
    name: "create_directory",
    arguments: { path: "annotation-probe-dir" },
  });
  assert.equal(status, 200);
  const text = payload?.result?.content?.[0]?.text ?? "";
  assert.ok(text.length > 0, "the call ran and returned a result");
  assert.notEqual(payload?.result?.isError, true, "the call was not refused");
});

test("a modern tools/call runs with no session and returns the same text shape", async () => {
  const { status, payload } = await modern("tools/call", {
    name: "list_directory",
    arguments: { path: "." },
  });
  assert.equal(status, 200);
  const text = payload?.result?.content?.[0]?.text ?? "";
  assert.ok(text.length > 0, "a modern tool call returns content");
  // The result envelope is a normal CallToolResult, not an era-specific wrapper.
  assert.ok(Array.isArray(payload.result.content), "content is a content-block array");
});

test("two consecutive modern requests are independent (no session to carry)", async () => {
  const first = await modern("tools/call", { name: "get_bridge_status", arguments: {} });
  const second = await modern("tools/call", { name: "get_bridge_status", arguments: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.sessionId, undefined);
  assert.equal(second.sessionId, undefined);
  // Usage counters are process-global, so the second call must observe the first.
  assert.equal(second.payload.result.content.length, first.payload.result.content.length);
});

test("modern input errors keep prose and carry typed details, even with output schemas", async () => {
  const cases = [
    {
      name: "write_file",
      arguments: { path: "never-written-by-error-test.txt" },
      kind: "missing",
      fields: ["content", "content_base64"],
      prose: /^Missing one of "content" or "content_base64"\./,
    },
    {
      name: "service",
      arguments: { action: "not-a-real-action" },
      kind: "invalid",
      fields: ["action"],
      prose: /^Invalid "action" value "not-a-real-action" for service\./,
    },
    {
      name: "apply_patch",
      arguments: { patch: "not a patch", patch_file: "irrelevant.patch" },
      kind: "conflict",
      fields: ["patch", "patch_file"],
      prose: /^Conflict: provide exactly one of "patch" or "patch_file"\./,
    },
  ];

  for (const expected of cases) {
    const { status, payload } = await modern("tools/call", {
      name: expected.name,
      arguments: expected.arguments,
    });
    assert.equal(status, 200, JSON.stringify(payload));
    const result = payload?.result;
    const prose = result?.content?.[0]?.text ?? "";
    assert.equal(result?.isError, true, `${expected.name} is a tool error, not a success`);
    assert.match(prose, expected.prose, `${expected.name} keeps its readable P7 explanation`);
    assert.deepEqual(result?.structuredContent?.error, {
      kind: expected.kind,
      tool: expected.name,
      fields: expected.fields,
      message: prose,
    }, `${expected.name} has a stable typed companion`);
  }

  const domainError = await modern("tools/call", {
    name: "read_files",
    arguments: { paths: ["../definitely-outside-the-workspace.txt"] },
  });
  assert.equal(domainError.status, 200, JSON.stringify(domainError.payload));
  const domainRows = domainError.payload?.result?.structuredContent?.items;
  assert.equal(domainError.payload?.result?.isError, undefined,
    "a valid path that cannot be read is a row error, not a failed batch");
  assert.equal(domainRows?.length, 1, "the rejected path keeps its result row");
  assert.match(domainRows?.[0]?.error ?? "", /inside the workspace/);
});

test("each exchange leaves a bounded trace line naming the era and method", async () => {
  // Observability is only real if it reaches a surface an operator reads. The
  // trace must (a) exist, (b) name the era and the method, and (c) never carry
  // the raw session id or the raw tool name — those are hashed.
  const probing = await modern("tools/call", { name: "get_bridge_status", arguments: {} });
  assert.equal(probing.status, 200);

  const res = await rawRequest("GET", "/api/activity", null, {});
  assert.equal(res.status, 200);
  const entries = JSON.parse(res.body).activity ?? [];
  const traces = entries.filter(entry => entry.tool === "mcp");

  assert.ok(traces.length > 0, "at least one exchange was traced");
  const line = traces[traces.length - 1].message;
  assert.match(line, /modern\//, "the era is named");
  assert.match(line, /HTTP \d{3}/, "the status is recorded");
  assert.match(line, /ms/, "the duration is recorded");

  // The security property: what was sent is not what was stored.
  assert.equal(line.includes("get_bridge_status"), false, "the tool name is hashed, not printed");
  // The trace is one bounded line, never a dump.
  assert.ok(line.length < 300, `a trace line stays short, got ${line.length}`);
  assert.equal(line.split("\n").length, 1);
});

test("a modern request with a broken envelope gets a spec error, not a silent 200", async () => {
  // Header claims the modern revision but the body carries no envelope: the
  // client must be told what is wrong, in the spec's own error shape.
  const res = await rawRequest(
    "POST",
    `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: 9001, method: "tools/list", params: {} }),
    modernHeaders("tools/list"),
  );
  assert.notEqual(res.status, 200, "an envelope-less modern claim must be rejected");
  const payload = decode(res.body);
  assert.ok(payload?.error, "the rejection carries a JSON-RPC error");
  assert.match(
    String(payload.error.message ?? ""),
    /_meta/,
    "the error names the missing envelope key so the client can fix it",
  );
});

test("the legacy era still mints a session and reports errors as isError", async () => {
  // The whole point of routing per request: nothing about the 2025-era path may
  // change. A legacy client still handshakes, still gets a session id, and still
  // receives tool failures as `isError: true` inside a successful JSON-RPC result.
  const init = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId++,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy-probe", version: "1" } },
  }), { "content-type": "application/json", accept: "application/json, text/event-stream" });
  assert.equal(init.status, 200);
  const sessionId = init.headers["mcp-session-id"];
  assert.ok(sessionId, "the legacy handshake still mints a session id");

  const legacyCall = await rawRequest(
    "POST",
    `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: "write_file", arguments: { path: "never-written-by-legacy-error-test.txt" } } }),
    { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
  );
  const payload = decode(legacyCall.body);
  const result = payload?.result;
  const prose = result?.content?.[0]?.text ?? "";
  assert.equal(legacyCall.status, 200, "the legacy transport reports failures in-band");
  assert.equal(result?.isError, true, "legacy keeps the isError result shape");
  assert.deepEqual(result?.structuredContent?.error, {
    kind: "missing",
    tool: "write_file",
    fields: ["content", "content_base64"],
    message: prose,
  }, "legacy and modern calls receive the same typed error contract");
});

test("bridge_status reports a modern caller even though it has no session", async () => {
  // "Who is connected?" has to have one answer for both eras. A modern client
  // mints no session, so the session view used to answer "nobody" while this
  // very request was being served — the same two-truths problem that once let a
  // stale instance look busy to the server and broken to its client.
  const listed = await modern("tools/call", { name: "bridge_status", arguments: { section: "sessions" } });
  assert.equal(listed.status, 200, JSON.stringify(listed.payload));
  const rows = JSON.parse(listed.payload.result.content[0].text);
  const stateless = rows.find(row => row.era === "modern");
  assert.ok(stateless, "the stateless era appears in the session view");
  assert.equal(stateless.stateless, true);
  assert.equal(stateless.closable, false, "there is nothing to close: no transport is held");
  assert.equal(stateless.connected_at, null, "and no handshake happened, so none is reported");
  assert.match(String(stateless.last_used), /^\d{4}-\d\d-\d\dT/, "when it last spoke is a real timestamp");

  // The same fact in the overview, next to the count it explains.
  const overview = await modern("tools/call", { name: "bridge_status", arguments: {} });
  const shape = overview.payload.result.structuredContent;
  assert.match(String(shape.modern_last_used), /^\d{4}-\d\d-\d\dT/,
    "overview dates the modern-era traffic instead of leaving active_sessions to imply nobody is there");
});


test("console sessions includes the same stateless activity as the MCP session view", async () => {
  const listed = await modern("tools/call", { name: "bridge_status", arguments: { section: "sessions" } });
  assert.equal(listed.status, 200);
  const mcpRows = JSON.parse(listed.payload.result.content[0].text);
  const mcpModern = mcpRows.find(row => row.era === "modern");
  assert.ok(mcpModern);
  const response = await rawRequest("GET", "/api/sessions", null);
  assert.equal(response.status, 200);
  const rows = JSON.parse(response.body).sessions;
  const activity = rows.find(row => row.era === "modern");
  assert.ok(activity, "Console must not say nobody is here while MCP reports modern activity");
  assert.equal(activity.id, "modern");
  assert.equal(activity.stateless, true);
  assert.equal(activity.closable, false);
  assert.equal(activity.connected_at, null);
  assert.equal(activity.first_seen, mcpModern.first_seen);
  assert.ok(Date.parse(activity.last_used) >= Date.parse(mcpModern.last_used));
  assert.equal(activity.calls, null, "no per-client call counter is available for a stateless summary");
  assert.equal(activity.todos, null, "no synthetic session owns a todo count");
  assert.equal(activity.active_requests, 0);
  assert.ok(activity.idle_ms >= 0);
  for (const legacy of mcpRows.filter(row => row.era === "legacy")) {
    const consoleRow = rows.find(row => row.id === legacy.session_id);
    assert.ok(consoleRow);
    assert.equal(consoleRow.closable, true);
    assert.equal(consoleRow.stateless, false);
    assert.equal(consoleRow.calls, legacy.calls);
    assert.equal(consoleRow.connected_at, legacy.connected_at);
  }

  const refused = await rawRequest("POST", "/api/sessions/close", JSON.stringify({ id: activity.id }), {
    "content-type": "application/json", "x-open-bridge-console": routeToken,
  });
  assert.equal(refused.status, 404, "there is no modern session transport to disconnect");
});

test("console stateless activity reports requests that are still in flight", async () => {
  const pending = modern("tools/call", { name: "wait", arguments: { ms: 2000 } });
  try {
    let activity;
    const deadline = Date.now() + 5000;
    // Wait for the observable condition, not a guessed server-start delay.
    do {
      const response = await rawRequest("GET", "/api/sessions", null);
      assert.equal(response.status, 200);
      activity = JSON.parse(response.body).sessions.find(row => row.era === "modern");
      if (activity?.active_requests > 0) break;
      await delay(20);
    } while (Date.now() < deadline);
    assert.equal(activity?.active_requests, 1, "the pending stateless request must be visible");
    assert.equal(activity.closable, false);
  } finally {
    const completed = await pending;
    assert.equal(completed.status, 200);
  }
  const response = await rawRequest("GET", "/api/sessions", null);
  assert.equal(JSON.parse(response.body).sessions.find(row => row.era === "modern").active_requests, 0);
});

// ---------------------------------------------------------------------------
// Dependency contract: what the three @modelcontextprotocol packages must keep
// doing. Run these before bumping any of them.
//
// `mcp-protocol-integration.test.mjs` and the checks above prove the Bridge
// behaves. These prove the *assumptions underneath it* still hold, which is what
// a dependency bump breaks. Each one names the module that depends on it:
//
//  A. sdk/server `Server` accepts `instructions` and hands the string back
//     verbatim in the initialize result            -> bridge/mcp-endpoint.ts
//  B. sdk/server passes a `tools/list` handler's return through unmodified,
//     preserving array order and per-entry annotations
//                                                    -> bridge/tool-catalog.ts
//  C. `server` SpecServer routes on the method STRING ("tools/list"), and
//     `createMcpHandler` calls the factory per request
//                                                    -> bridge/mcp-endpoint.ts
//  D. both eras therefore emit one catalog, byte for byte — the claim
//     createSpecMcp makes in a comment and nothing else checked
//
// If a bump renames a handler key, starts normalizing schemas, or drops
// `instructions`, the assertion that fails names the assumption instead of
// surfacing later as a client that silently sees fewer tools.
// ---------------------------------------------------------------------------

/** A legacy (2025-era) session: initialize, then the initialized notification. */
async function legacyInitialize() {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0", id: rpcId++, method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "contract-test", version: "1" },
    },
  }), { "content-type": "application/json", accept: "application/json, text/event-stream" });
  const sessionId = res.headers["mcp-session-id"];
  assert.ok(sessionId, "the legacy era still mints a session id (assumption A)");
  await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId });
  return { sessionId, payload: res.body ? decode(res.body) : null };
}

// Named for the era, not `legacyCall`: an existing test below uses that name
// for a local, and a module-scope helper with the same name would shadow it.
async function legacyRpc(sessionId, method, params) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} }),
    {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-06-18",
    });
  return { status: res.status, payload: res.body ? decode(res.body) : null };
}

test("CONTRACT A/B: initialize carries instructions verbatim, and tools/list is a faithful passthrough", async () => {
  const { sessionId, payload } = await legacyInitialize();
  const instructions = payload?.result?.instructions;

  assert.equal(typeof instructions, "string", "the sdk Server surfaces `instructions` (assumption A)");
  assert.ok(instructions.includes("standalone Open Bridge"), "our own text reaches the client unrewritten");
  assert.equal(payload?.result?.serverInfo?.name, "open-bridge");

  // Called twice: a passthrough that sorted, deduplicated, re-serialized or
  // stripped annotations would still return the right tools the first time.
  const first = await legacyRpc(sessionId, "tools/list", {});
  const second = await legacyRpc(sessionId, "tools/list", {});
  const wireA = JSON.stringify(first.payload?.result?.tools);
  const wireB = JSON.stringify(second.payload?.result?.tools);

  assert.equal(wireB, wireA, "repeated tools/list is byte-identical (assumption B)");
  assert.equal(wireA, JSON.stringify(second.payload?.result?.tools), "no re-encoding between calls");

  const advertised = first.payload.result.tools;
  assert.deepEqual(
    advertised.map(tool => tool.name),
    [...new Set(advertised.map(tool => tool.name))],
    "order is preserved and nothing was deduplicated away",
  );
  assert.ok(
    advertised.every(tool => tool.inputSchema && tool.annotations),
    "annotations survive the sdk's serialization (assumption B)",
  );
});

test("CONTRACT C/D: the modern era routes on the method string and emits the identical catalog", async () => {
  const { sessionId } = await legacyInitialize();
  const legacy = await legacyRpc(sessionId, "tools/list", {});
  const modernList = await modern("tools/list");

  assert.equal(modernList.status, 200, "SpecServer routes the string \"tools/list\" (assumption C)");
  // createSpecMcp claims the JSON a client receives is byte-identical to the
  // legacy path's. That is assumption D, and until this test it was a comment.
  assert.equal(
    JSON.stringify(modernList.payload?.result?.tools),
    JSON.stringify(legacy.payload?.result?.tools),
    "both protocol eras emit one catalog, byte for byte (assumption D)",
  );
});

test("bridge_status reports the prefix it actually sends, and the prefix survives a restart", async () => {
  const { sessionId, payload } = await legacyInitialize();
  const instructions = payload.result.instructions;

  const status = await legacyRpc(sessionId, "tools/call", { name: "bridge_status", arguments: {} });
  const overview = status.payload?.result?.structuredContent;
  assert.equal(overview?.instructions_bytes, Buffer.byteLength(instructions, "utf8"),
    "instructions_bytes is the bytes on the wire, not a character count");

  const list = await legacyRpc(sessionId, "tools/list", {});
  assert.equal(overview?.catalog_bytes, Buffer.byteLength(JSON.stringify(list.payload?.result?.tools), "utf8"),
    "catalog_bytes is the serialized catalog the same client just received");

  // A prefix that moved between two starts of the same workspace would defeat
  // every client's cache on each reconnect, and nothing else would notice.
  const priorInstructions = instructions;
  const previous = child;
  previous.kill("SIGTERM");
  await delay(400);
  // The dead instance leaves its record behind, and waitForRuntime returns the
  // first record with a port — so without this it would hand back the port
  // nobody is listening on any more.
  rmSync(runtimeFileFor(home, home), { force: true });
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
  routeToken = routeTokenFor(home, home);

  const reopened = await legacyInitialize();
  assert.equal(reopened.payload.result.instructions, priorInstructions,
    "a restart hands out byte-identical instructions");
  const relisted = await legacyRpc(reopened.sessionId, "tools/list", {});
  assert.equal(JSON.stringify(relisted.payload?.result?.tools), JSON.stringify(list.payload?.result?.tools),
    "a restart advertises a byte-identical catalog");
});
