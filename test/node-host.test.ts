/**
 * Unit tests for the file-backed Node host: config coercion/persistence,
 * state store, secret store permissions, and the project-root contract.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost, nodeHost } from "../src/host/node-host.js";
import { CONFIG_DEFAULTS } from "../src/bridge/config-defaults.js";

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

test("state sync-get reads from cache; update persists", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  assert.deepEqual(host.state.get("missing", { a: 1 }), { a: 1 });
  await host.state.update("openBridge.todos.x", { todos: [1, 2] });
  assert.deepEqual(host.state.get("openBridge.todos.x", null), { todos: [1, 2] });
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

test("log writes land in logs/bridge.log", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  host.log("hello from test");
  await new Promise(resolve => setTimeout(resolve, 100));
  const content = readFileSync(nodeHost().bridgeLog.path(), "utf8");
  assert.ok(content.includes("hello from test"));
});

test("config get returns a copy: mutating it cannot corrupt the store or CONFIG_DEFAULTS", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  const dirs = host.config.get<string[]>("allowedDirectories", []);
  dirs.push("/evil");
  assert.deepEqual(host.config.get<string[]>("allowedDirectories", []), []);
  await host.config.update("allowedDirectories", ["/a"]);
  const stored = host.config.get<string[]>("allowedDirectories", []);
  stored.push("/evil");
  assert.deepEqual(host.config.get<string[]>("allowedDirectories", []), ["/a"]);
});

test("config update snapshots the value instead of aliasing the caller's object", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  const mine: string[] = ["/a"];
  await host.config.update("allowedDirectories", mine);
  mine.push("/evil");
  assert.deepEqual(host.config.get<string[]>("allowedDirectories", []), ["/a"]);
});

test("state get returns a copy", async () => {
  const { host } = installNodeHost({ homeDir: home, version: "0.0.0-test" });
  await host.state.update("k", { list: [1] });
  const snap = host.state.get<{ list: number[] }>("k", { list: [] });
  snap.list.push(2);
  assert.deepEqual(host.state.get<{ list: number[] }>("k", { list: [] }), { list: [1] });
});

test("CONFIG_DEFAULTS is deeply frozen", () => {
  assert.ok(Object.isFrozen(CONFIG_DEFAULTS));
  assert.ok(Object.isFrozen(CONFIG_DEFAULTS.allowedDirectories));
  assert.ok(Object.isFrozen(CONFIG_DEFAULTS["oauth.allowedRedirectHosts"]));
  assert.throws(() => {
    (CONFIG_DEFAULTS.allowedDirectories as string[]).push("/evil");
  });
  assert.throws(() => {
    (CONFIG_DEFAULTS as Record<string, unknown>).port = 1;
  });
});

test("an unparsable config.json is reported, not silently defaulted", () => {
  writeFileSync(path.join(home, "config.json"), "{ this is not json");
  const captured: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => { captured.push(String(line)); };
  try {
    installNodeHost({ homeDir: home, version: "0.0.0-test" });
  } finally {
    console.error = original;
  }
  assert.ok(
    captured.some(line => line.includes("config.json") && line.includes("could not be parsed")),
    `expected a parse-failure warning on stderr, got: ${JSON.stringify(captured)}`,
  );
});
