/**
 * File-operation safety, end to end: the three findings of the turn-42 audit,
 * each proved over real HTTP against a real `serve` process.
 *
 *  ① a delete aimed at the workspace root (or at a parent of it, or at the
 *    Bridge's own data directory, or at a drive root) is refused and the project
 *    survives — while a path that merely *lives* outside the workspace is still
 *    deletable, because `unrestrictedFileAccess` is deliberate and unchanged;
 *  ② a missing `path` / `source` / `destination` is an error instead of a file
 *    named "undefined" (`String(undefined)` used to write one);
 *  ③ a declared boolean arriving as a string is read as declared, a legacy
 *    name's `deprecated` note stays out of `structuredContent`, and usage is
 *    counted under the canonical name.
 *
 * The workspace and the data directory are two different temp dirs here on
 * purpose: the guard protects both, and a test that made them the same directory
 * could not tell which one fired.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeTokenFor, waitForRuntime } from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let workspace;
let home;
let child;
let port;
let routeToken;
let sessionId;

before(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "ob-file-guard-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "ob-file-guard-home-"));
  mkdirSync(path.join(workspace, "d"));
  writeFileSync(path.join(workspace, "canary.txt"), "keep me", "utf8");
  writeFileSync(path.join(workspace, "d", "inside.txt"), "inside", "utf8");
  writeFileSync(path.join(path.dirname(workspace), "outside.txt"), "outside the workspace", "utf8");
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", workspace, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime(home, workspace);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(home, workspace); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");
  sessionId = (await openSession()).sessionId;
  assert.ok(sessionId, "MCP session was established");
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

test("a delete aimed at the workspace root is refused, and the project is intact", async () => {
  const result = await callTool("file_op", { op: "delete", path: ".", recursive: true });
  assert.equal(result.isError, true, "deleting the workspace root must fail");
  assert.match(result.text, /Refusing to delete/, "the refusal names itself");
  assert.ok(existsSync(path.join(workspace, "canary.txt")), "canary.txt survived");
  assert.ok(existsSync(path.join(workspace, "d", "inside.txt")), "the subtree survived");
});

test("a delete aimed at a parent of the workspace is refused too", async () => {
  const result = await callTool("file_op", { op: "delete", path: "..", recursive: true });
  assert.equal(result.isError, true, "deleting the workspace's parent must fail");
  assert.match(result.text, /Refusing to delete/);
  assert.ok(existsSync(path.join(workspace, "canary.txt")), "the project survived a parent delete");
});

test("the Bridge's own data directory and a drive root are refused", async () => {
  const storage = await callTool("file_op", { op: "delete", path: home, recursive: true });
  assert.equal(storage.isError, true, "the data directory must be off limits");
  assert.match(storage.text, /data directory/);
  assert.ok(existsSync(path.join(home, "secrets.json")), "the route token survived");

  const drive = await callTool("file_op", { op: "delete", path: path.parse(workspace).root, recursive: true });
  assert.equal(drive.isError, true, "a drive root must be off limits");
  assert.match(drive.text, /drive root/);
});

test("a path outside the workspace is still reachable: the guard is not a sandbox", async () => {
  const outside = path.join(path.dirname(workspace), "outside.txt");
  assert.ok(existsSync(outside), "the outside file is there to begin with");
  const result = await callTool("file_op", { op: "delete", path: outside });
  assert.equal(result.isError, false, `deleting an ordinary outside path must still work: ${result.text}`);
  assert.equal(existsSync(outside), false, "and it really was deleted");
});

test("a missing path or destination is an error, not a file named undefined", async () => {
  const copied = await callTool("copy_file", { source: "canary.txt" });
  assert.equal(copied.isError, true, "copy_file without destination must fail");
  assert.match(copied.text, /Missing "destination"/);

  const deleted = await callTool("delete_file", {});
  assert.equal(deleted.isError, true, "delete_file without path must fail");
  assert.match(deleted.text, /Missing "path"/);

  const family = await callTool("file_op", { op: "copy", source: "canary.txt" });
  assert.equal(family.isError, true, "file_op{op:copy} without destination must fail");
  assert.match(family.text, /Missing "destination"/);

  const created = await callTool("file_op", { op: "create_directory" });
  assert.equal(created.isError, true, "file_op{op:create_directory} without path must fail");
  assert.equal(existsSync(path.join(workspace, "undefined")), false,
    "no operation may create a file named undefined as a stand-in for a missing argument");
});

test("moving a file onto an existing directory is refused instead of deleting it", async () => {
  const result = await callTool("file_op", { op: "move", source: "canary.txt", destination: "d", overwrite: true });
  assert.equal(result.isError, true, "replacing a directory with a file must fail");
  assert.match(result.text, /existing directory/);
  assert.ok(existsSync(path.join(workspace, "d", "inside.txt")), "the directory kept its contents");
  assert.ok(existsSync(path.join(workspace, "canary.txt")), "and the file was not moved anywhere");

  const proper = await callTool("file_op", { op: "move", source: "canary.txt", destination: "d/renamed.txt" });
  assert.equal(proper.isError, false, `naming the file inside the directory still works: ${proper.text}`);
  assert.ok(existsSync(path.join(workspace, "d", "renamed.txt")), "the file landed inside the directory");
});

test("a boolean sent as a string is read as declared", async () => {
  mkdirSync(path.join(workspace, "tree"));
  writeFileSync(path.join(workspace, "tree", "inner.txt"), "inner", "utf8");
  const shallow = await callTool("file_op", { op: "delete", path: "tree", recursive: "false" });
  assert.equal(shallow.isError, true, 'recursive:"false" must mean false, so a non-empty directory cannot go');
  assert.ok(existsSync(path.join(workspace, "tree", "inner.txt")), "the directory and its file survived");

  const deep = await callTool("file_op", { op: "delete", path: "tree", recursive: "true" });
  assert.equal(deep.isError, false, `recursive:"true" must mean true: ${deep.text}`);
  assert.equal(existsSync(path.join(workspace, "tree")), false, "and the tree is gone");
});

test("a legacy name still answers, with its note in the text and not in structuredContent", async () => {
  const payload = await callToolPayload("get_auth_status", {});
  const result = payload.result;
  assert.ok(result.structuredContent, "the legacy name still returns a typed payload");
  assert.equal(Object.prototype.hasOwnProperty.call(result.structuredContent, "deprecated"), false,
    "deprecated is a message to the caller, not part of the declared output schema");
  assert.equal(result.structuredContent.enabled, false, "the typed payload is the canonical one");
  assert.match(JSON.stringify(result.content), /deprecated/, "the text block still carries the note");

  const usage = JSON.parse((await rawRequest("GET", "/api/usage")).body);
  const serialized = JSON.stringify(usage);
  assert.match(serialized, /"bridge_status"/, "usage counts the capability");
  assert.doesNotMatch(serialized, /"get_auth_status"/, "and does not split it across the legacy spelling");
});

test("every file tool still works on ordinary paths", async () => {
  const created = await callTool("file_op", { op: "create_directory", path: "fresh/deep" });
  assert.equal(created.isError, false, `create_directory: ${created.text}`);

  const written = await callTool("write_file", { path: "fresh/deep/a.txt", content: "hello" });
  assert.equal(written.isError, false, `write_file: ${written.text}`);

  const copied = await callTool("copy_file", { source: "fresh/deep/a.txt", destination: "fresh/deep/b.txt" });
  assert.equal(copied.isError, false, `copy_file: ${copied.text}`);

  const info = await callTool("get_file_info", { path: "fresh/deep/b.txt" });
  assert.equal(info.isError, false, `get_file_info: ${info.text}`);

  const removed = await callTool("file_op", { op: "delete", path: "fresh", recursive: true });
  assert.equal(removed.isError, false, `delete: ${removed.text}`);
  assert.equal(existsSync(path.join(workspace, "fresh")), false, "the directory is gone");
});

// ---------------------------------------------------------------- MCP plumbing
function rawRequest(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers, agent: false, signal: AbortSignal.timeout(8_000) },
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
const jsonHeaders = extra => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...extra,
});

async function openSession() {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0", id: rpcId++, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "file-guards", version: "1" } },
  }), jsonHeaders());
  const session = res.headers["mcp-session-id"];
  if (session) {
    await rawRequest("POST", `/mcp/${routeToken}`,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      jsonHeaders({ "mcp-session-id": session }));
  }
  return { sessionId: session, body: res.body };
}

async function callToolPayload(name, args) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    jsonHeaders({ "mcp-session-id": sessionId }));
  assert.equal(res.status, 200, `tools/call ${name} answered`);
  const payload = lastSsePayload(res.body);
  assert.ok(payload?.result, `tools/call ${name} returned a result`);
  return payload;
}

/**
 * One tool call, flattened to what these assertions care about. `text` is the
 * tool's own message rather than the serialized envelope, so the assertions read
 * the error the way a client sees it (no escaped quotes in the way).
 */
async function callTool(name, args) {
  const payload = await callToolPayload(name, args);
  const result = payload.result;
  const text = result.content?.[0]?.text ?? JSON.stringify(result);
  return { isError: result.isError === true, text };
}
