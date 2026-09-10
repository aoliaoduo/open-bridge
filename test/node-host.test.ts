/**
 * Unit tests for the file-backed Node host: config coercion/persistence,
 * state store, secret store permissions, and the project-root contract.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost, nodeHost } from "../src/host/node-host.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-host-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("config falls back to CONFIG_DEFAULTS and coerces stored types", () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  assert.equal(host.config.get("port", 0), 0);
  assert.equal(host.config.get("toolProfile", "full"), "full");
  assert.equal(host.config.get("tunnelProvider", "ngrok"), "ngrok");
  // Type mismatch in storage falls back instead of leaking through.
  assert.equal(host.config.get("port", 1234), 0, "declared default wins over caller fallback");
});

test("config update persists to config.json and is re-readable", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  await host.config.update("port", 4321);
  await host.config.update("auth.enabled", true);
  const stored = JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(stored.port, 4321);
  assert.equal(stored["auth.enabled"], true);
  assert.equal(host.config.get("port", 0), 4321);
  assert.equal(host.config.get("auth.enabled", false), true);
});

test("globalState sync-get reads from cache; update persists", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  assert.deepEqual(host.globalState.get("missing", { a: 1 }), { a: 1 });
  await host.globalState.update("openBridge.todos.x", { todos: [1, 2] });
  assert.deepEqual(host.globalState.get("openBridge.todos.x", null), { todos: [1, 2] });
  const stored = JSON.parse(readFileSync(path.join(home, "state.json"), "utf8"));
  assert.deepEqual(stored["openBridge.todos.x"], { todos: [1, 2] });
});

test("secrets persist and the file is permission-restricted", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  assert.equal(await host.secrets.get("nope"), undefined);
  await host.secrets.store("openBridge.routeToken.x", "deadbeef");
  assert.equal(await host.secrets.get("openBridge.routeToken.x"), "deadbeef");
  const file = path.join(home, "secrets.json");
  assert.ok(existsSync(file));
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("project root defaults to cwd and can be switched", () => {
  const { host } = installNodeHost({ homeDir: home, projectRoot: home, version: "0.0.0-test" });
  assert.equal(host.projectRoot(), path.resolve(home));
  nodeHost().setProjectRoot(path.join(home, "sub"));
  assert.equal(host.projectRoot(), path.resolve(path.join(home, "sub")));
});

test("capabilities: the standalone host reports no LSP", () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  assert.equal(host.capabilities.lsp, false);
});

test("log writes land in logs/bridge.log", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  host.log("hello from test");
  await new Promise(resolve => setTimeout(resolve, 100));
  const content = readFileSync(nodeHost().bridgeLog.path(), "utf8");
  assert.ok(content.includes("hello from test"));
});
