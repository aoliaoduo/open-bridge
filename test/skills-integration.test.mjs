/**
 * Skills, end to end: connection-time discovery and explicit refresh through
 * the ordinary MCP catalog and file tools.
 *
 * What only a real instance can show: the *instructions* a connecting client
 * actually receives carry the skill index, and `list_skills` comes back
 * through the normal catalog with annotations, a skill added **after** the
 * handshake still shows up on the next call (the property instructions cannot
 * have), and reading a skill goes through the ordinary file tools — no new path,
 * no new permission.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import {mkdtempSync, mkdirSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRpcId, jsonHeaders, lastSsePayload, makeOpenSession, makeRawRequest,
  startBridge, stopServe,
} from "./lib/bridge-runtime.mjs";

let home;
let workspace;
let child;
let port;
let routeToken;
let sessionId;
let instructions = "";

function writeSkill(dir, name, description, body = "Do the thing.\n") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}`);
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-skills-home-"));
  workspace = mkdtempSync(path.join(tmpdir(), "ob-skills-ws-"));
  writeSkill(path.join(workspace, "skills", "release"), "release", "Cut a release the way this project does it");
  writeSkill(path.join(home, "skills", "global-style"), "global-style", "User-level conventions");

  ({ child, port, routeToken } = await startBridge({ root: workspace, home }));
  const opened = await openSession();
  sessionId = opened.sessionId;
  instructions = opened.instructions;
});

after(async () => {
  await stopServe(child);
  removeTempDir(home);
  removeTempDir(workspace);
});

test("the connecting client is told which skills exist, and that the file is the source of truth", () => {
  assert.match(instructions, /# Available skills/);
  assert.match(instructions, /- release — Cut a release the way this project does it/);
  assert.match(instructions, /skills[\\/]release[\\/]SKILL\.md/);
  assert.match(instructions, /- global-style — User-level conventions/, "user-level skills are indexed too");
  assert.match(instructions, /read_files/, "and the model is told to read the file, not guess");
});

test("list_skills is in the catalog, annotated read-only", async () => {
  const tools = (await mcpCall("tools/list", {})).payload.result.tools;
  const skillTool = tools.find(tool => tool.name === "list_skills");
  assert.ok(skillTool, "list_skills is advertised");
  assert.equal(skillTool.annotations.readOnlyHint, true);
  assert.equal(skillTool.annotations.openWorldHint, false);
  assert.equal(typeof skillTool.inputSchema, "object");
});

test("list_skills reports both skills, contents-free", async () => {
  const result = JSON.parse(await callToolText("list_skills", {}));
  // User-level skills also come from the machine's real ~/.agents/skills, so the
  // total is not asserted here — membership is what this test is about.
  const names = result.skills.map(skill => skill.name);
  assert.ok(result.count >= 2, `count ${result.count}`);
  assert.ok(names.includes("release") && names.includes("global-style"), names.join(","));
  assert.equal(result.shadowed, 0);
  assert.ok(Array.isArray(result.scanned_dirs) && result.scanned_dirs.length >= 2);
  assert.equal(result.skills.every(skill => typeof skill.description === "string" && skill.path.endsWith("SKILL.md")), true);
  assert.equal(JSON.stringify(result).includes("Do the thing."), false, "the body is not inlined into the index");
});

test("a skill is read with the existing file tools — no new access path", async () => {
  const target = path.join(workspace, "skills", "release", "SKILL.md").replace(/\\/g, "\\\\");
  const read = JSON.parse(await callToolText("read_files", { paths: [target] }));
  const entry = Array.isArray(read) ? read[0] : read.items?.[0] ?? read;
  assert.match(JSON.stringify(entry), /Do the thing\./);
});

test("a skill added mid-session appears on the next call, without reconnecting", async () => {
  const baseline = JSON.parse(await callToolText("list_skills", {})).count;
  writeSkill(path.join(workspace, "skills", "hotfix"), "hotfix", "Emergency path");
  const result = JSON.parse(await callToolText("list_skills", {}));
  assert.equal(result.count, baseline + 1, "exactly the new skill was added");
  assert.ok(result.skills.some(skill => skill.name === "hotfix"), "the fresh scan sees it");
});

// ---------------------------------------------------------------- MCP plumbing
const rawRequest = makeRawRequest(() => port, 8_000);
const rpcId = createRpcId();

const openSessionBase = makeOpenSession({ request: rawRequest, routeToken: () => routeToken, clientName: "skills-test", nextId: rpcId });
async function openSession() {
  const opened = await openSessionBase();
  return { sessionId: opened.sessionId, instructions: lastSsePayload(opened.body)?.result?.instructions ?? "" };
}

async function mcpCall(method, params) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`,
    JSON.stringify({ jsonrpc: "2.0", id: rpcId(), method, params }),
    jsonHeaders({ "mcp-session-id": sessionId }));
  return { status: res.status, payload: lastSsePayload(res.body), body: res.body };
}

/** The first text block of a tool result (run_command/list_skills both answer that way). */
async function callToolText(name, args) {
  const { status, payload } = await mcpCall("tools/call", { name, arguments: args });
  assert.equal(status, 200, `tools/call ${name} answered`);
  const blocks = payload?.result?.content ?? [];
  const text = blocks.find(block => block.type === "text")?.text;
  assert.ok(text, `${name} returned text`);
  return text;
}