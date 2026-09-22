/**
 * The connect-time shell line, end to end: a real session's instructions name
 * the interpreter behind run_command / start_process / open_shell, and the
 * dialect it coaches agrees with that interpreter. This is the one fact a
 * connecting model cannot infer — and guessing wrong does not error, it
 * mis-guards (`2>nul` under bash writes a file literally named `nul`).
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, existsSync } from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  lastSsePayload, makeRawRequest, startBridge, stopServe,
} from "./lib/bridge-runtime.mjs";

let home;
let workspace;
let child;
let port;
let routeToken;
let instructions = "";

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-shellinst-home-"));
  workspace = mkdtempSync(path.join(tmpdir(), "ob-shellinst-ws-"));
  ({ child, port, routeToken } = await startBridge({ root: workspace, home }));
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shell-inst-test", version: "1" } },
  }), { "content-type": "application/json", accept: "application/json, text/event-stream" });
  instructions = lastSsePayload(res.body)?.result?.instructions ?? "";
});

after(async () => {
  await stopServe(child);
  removeTempDir(home);
  removeTempDir(workspace);
});

test("the instructions name the interpreter of command text, and coach its dialect", () => {
  const m = instructions.match(/interpreted by `([^`]+)` \(`([^`]+)`\)/);
  assert.ok(m, "the shell line is present in the connect-time instructions");
  const [, file, args] = m;
  assert.ok(args.length > 0, "the invocation shape is shown, not just the path");
  assert.match(instructions, /run_command/);
  const base = path.basename(file);
  if (base !== "powershell.exe" && base !== "pwsh.exe") {
    // By-name invocations are PATH-resolved on purpose (that is how the
    // provider lists them); every other value must be a real existing path.
    assert.ok(existsSync(file), `named interpreter exists on this machine: ${file}`);
  }
  const coachedPowerShell = instructions.includes("PowerShell syntax");
  const namedPowerShell = base.toLowerCase().includes("powershell") || base === "pwsh.exe";
  assert.equal(coachedPowerShell, namedPowerShell,
    `the coached dialect disagrees with the named interpreter: ${file}`);
});

// ---------------------------------------------------------------- MCP plumbing
const rawRequest = makeRawRequest(() => port, 8_000);
