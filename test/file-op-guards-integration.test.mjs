/**
 * File-operation safety, end to end: the three findings of the turn-42 audit,
 * each proved over real HTTP against a real `serve` process.
 *
 * Two findings were added to this file later, because both are only
 * observable at this boundary: the same guard against Windows spellings of
 * the workspace root, and a relative path that walks out of the workspace --
 * the guard never saw that one, it escaped during path resolution.
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
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { createHash } from "node:crypto";
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
  removeTempDir(workspace);
  removeTempDir(home);
});

test("a delete aimed at the workspace root is refused, and the project is intact", async () => {
  const result = await callTool("file_op", { op: "delete", path: ".", recursive: true });
  assert.equal(result.isError, true, "deleting the workspace root must fail");
  assert.match(result.text, /Refusing to delete/, "the refusal names itself");
  assert.ok(existsSync(path.join(workspace, "canary.txt")), "canary.txt survived");
  assert.ok(existsSync(path.join(workspace, "d", "inside.txt")), "the subtree survived");
});

test("a delete aimed at a parent of the workspace is refused too", async () => {
  // Two rules stand in the way here and both have to hold. The relative
  // spelling is refused as a relative path that leaves the workspace (it used to
  // escape during resolution, before the guard was ever consulted); the absolute
  // spelling walks into the guard itself.
  const relative = await callTool("file_op", { op: "delete", path: "..", recursive: true });
  assert.equal(relative.isError, true, "deleting the workspace's parent must fail");
  assert.match(relative.text, /inside the workspace/);

  const absolute = await callTool("file_op", { op: "delete", path: path.dirname(workspace), recursive: true });
  assert.equal(absolute.isError, true, "the absolute spelling of the parent must fail too");
  assert.match(absolute.text, /Refusing to delete/);
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

test("a dropped path never becomes a file called undefined", async () => {
  const trap = path.join(workspace, "undefined");
  writeFileSync(trap, "A REAL FILE", "utf8");

  const written = await callTool("write_file", { content: "CLOBBERED" });
  assert.equal(written.isError, true, "write_file without a path must fail");
  assert.match(written.text, /Missing "path"/);
  assert.equal(readFileSync(trap, "utf8"), "A REAL FILE", "the real file named undefined was not overwritten");

  const info = await callTool("get_file_info", {});
  assert.equal(info.isError, true, "get_file_info without a path must fail");
  assert.match(info.text, /Missing "path"/);

  const edited = await callTool("edit_block", { old_text: "A REAL", new_text: "X" });
  assert.equal(edited.isError, true, "edit_block without a path must fail");
  assert.match(edited.text, /Missing "path"/);
  assert.equal(readFileSync(trap, "utf8"), "A REAL FILE", "and it was not edited either");

  const read = await callTool("read_files", { paths: [null] });
  assert.equal(read.isError, true, "a null entry in paths must fail");
  assert.match(read.text, /non-empty string/);
});

test("an ambiguous old_text is answered with where the matches are", async () => {
  // The zero-match path has fuzzy diagnostics; too-many-matches used to have
  // only a count, leaving the caller to grep for the positions themselves —
  // the exact work they had just asked this tool to do. Real case from this
  // repo: `### Fixed` appears three times in CHANGELOG.md.
  const name = "ambiguous.md";
  writeFileSync(path.join(workspace, name),
    ["# doc", "", "### Fixed", "- one", "", "### Fixed", "- two", "", "### Fixed", "- three", ""].join("\n"));

  const result = await callTool("edit_block", { path: name, old_text: "### Fixed", new_text: "### Broken" });
  assert.equal(result.isError, true, "an ambiguous anchor must not pick one at random");
  assert.match(result.text, /found 3/, "the count is still reported");
  // The half that was missing: which three.
  assert.match(result.text, /Matches start at lines 3, 6, 9\./,
    "the caller is told where, not just how many");
  assert.match(result.text, /make old_text unique/, "and what to do about it");

  // Nothing was written: a rejected edit leaves the file exactly as it was.
  assert.match(readFileSync(path.join(workspace, name), "utf8"), /### Fixed/);
  assert.ok(!readFileSync(path.join(workspace, name), "utf8").includes("Broken"));
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

/**
 * `read_files` promises a sha256 that is either the whole-file digest or null,
 * and the tool contract is that absent facts are explicit nulls — a client must
 * be able to parse by field name. A truncated read used to DROP the key, so
 * `'sha256' in result` silently flipped with file size and the optimistic-write
 * chain (read -> expected_sha256) broke with no error anywhere.
 *
 * This lives at the tool boundary on purpose: the unit tests over
 * `streamReadLines` always saw the internal `sha256: null` and so could never
 * have caught the handler spreading the key away.
 */
test("read_files always carries sha256: a full read digests, a truncated read is null", async () => {
  const body = "line one\nline two\nline three\n";
  writeFileSync(path.join(workspace, "hash.txt"), body, "utf8");
  const whole = createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex");

  const full = await readFilesEntry({ paths: ["hash.txt"] });
  assert.equal(full.sha256, whole, "a full read reports the whole-file digest");
  assert.equal(full.truncated, false);

  const cut = await readFilesEntry({ paths: ["hash.txt"], max_bytes: 4 });
  assert.ok("sha256" in cut, "the key must exist even when the read stopped early");
  assert.equal(cut.sha256, null, "a truncated read cannot speak for the whole file");
  assert.equal(cut.truncated, true);

  // A digest is still reachable after a truncated read - the documented way out.
  const info = await callToolPayload("get_file_info", { path: "hash.txt" });
  const meta = JSON.parse(info.result.content?.[0]?.text ?? "{}");
  assert.equal(meta.sha256, whole, "get_file_info still answers with the whole-file digest");
});

/** The first entry of a read_files call, parsed from the tool's text payload. */
async function readFilesEntry(args) {
  const payload = await callToolPayload("read_files", args);
  const parsed = JSON.parse(payload.result.content?.[0]?.text ?? "[]");
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

test("a relative path cannot walk out of the workspace, whatever the tool", async () => {
  // The escape that started this: apply_patch with "../../ob-escape.txt" created
  // a file outside the workspace and reported success. The path has to be
  // refused while it is still a path.
  writeFileSync(path.join(workspace, "escape-canary.txt"), "still here", "utf8");
  const escaped = path.join(path.dirname(workspace), "ob-escape-relative.txt");
  assert.equal(existsSync(escaped), false, "the escape target must not exist to begin with");

  const patch = ["*** Begin Patch", "*** Add File: ../ob-escape-relative.txt", "+gone", "*** End Patch", ""].join("\n");
  const patched = await callTool("apply_patch", { patch });
  assert.equal(patched.isError, true, "apply_patch must refuse a relative path that leaves the workspace");
  assert.match(patched.text, /inside the workspace/);

  const written = await callTool("write_file", { path: "../ob-escape-relative.txt", content: "gone\n" });
  assert.equal(written.isError, true, "write_file must refuse it too");
  assert.match(written.text, /inside the workspace/);

  const read = await callTool("read_files", { paths: ["../ob-escape-relative.txt"] });
  assert.equal(read.isError, true, "and reading it is not a way around the rule");

  // A working directory is a path like any other: run_command used to accept
  // ".." and run there.
  const ran = await callTool("run_command", { command: "echo escaped", cwd: ".." });
  assert.equal(ran.isError, true, "run_command must refuse a cwd outside the workspace");
  assert.match(ran.text, /inside the workspace/);

  assert.equal(existsSync(escaped), false, "nothing outside the workspace was created");
  assert.ok(existsSync(path.join(workspace, "escape-canary.txt")), "and the project is intact");
});
