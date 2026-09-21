/**
 * The service tool family had zero in-process coverage: the legacy verbs were
 * only exercised through dist-level integration runs, so the guards that live
 * in this module (validation at save time, the honest stop path, the per-call
 * health race) never failed under a test. These tests drive the real exports
 * against a fake host (memory state store, temp storage dir) and, where a
 * process is genuinely needed, a real `node -e` child on loopback.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHost, type Host, type StateStore } from "../src/host/host.js";
import {
  checkHttpTool,
  checkPortTool,
  deleteService,
  listServiceViews,
  listServices,
  probeScope,
  restartService,
  saveService,
  serviceStatus,
  startService,
  stopService,
} from "../src/bridge/service-tools.js";
import { state, type ServiceDefinition } from "../src/bridge/state.js";
import { terminateProcess } from "../src/bridge/processes.js";
import type { AddressInfo } from "node:net";

function memoryStateStore(): StateStore & { dump(): Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    get<T>(key: string, fallback: T): T {
      return (m.has(key) ? m.get(key) : fallback) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      m.set(key, value);
    },
    dump: () => m,
  };
}

let store: ReturnType<typeof memoryStateStore>;
let workspace: string;
let saved: {
  root: string;
  services: Map<string, ServiceDefinition>;
  commands: Map<string, unknown>;
};

const drain = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
};

const KEEP_ALIVE = 'node -e "setInterval(function(){}, 1000)"';

beforeEach(() => {
  store = memoryStateStore();
  workspace = mkdtempSync(join(tmpdir(), "ob-service-"));
  saved = {
    root: state.activeWorkspaceRoot,
    services: state.services,
    commands: state.commands,
  };
  state.services = new Map();
  state.activeWorkspaceRoot = workspace;
  setHost({
    config: { get<T>(_key: string, fallback: T): T { return fallback; }, async update(): Promise<void> {} },
    secrets: { async get() { return undefined; }, async store() {} },
    state: store,
    storageDir: () => join(workspace, ".ob-data"),
    version: () => "test",
    bundledRipgrep: () => undefined,
    projectRoot: () => workspace,
    notify: () => {},
    log: () => {},
    ui: { update: () => {}, refresh: () => {} },
  } as Host);
});

afterEach(async () => {
  for (const service of state.services.values()) {
    if (service.commandId) {
      const proc = state.commands.get(service.commandId);
      if (proc) await terminateProcess(proc as never, "stopped");
    }
  }
  state.services = saved.services;
  state.commands = saved.commands as typeof state.commands;
  state.activeWorkspaceRoot = saved.root;
  rmSync(workspace, { recursive: true, force: true });
});

function tcpServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, close: () => new Promise(done => server.close(() => done())) });
    });
  });
}

function httpServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; port: number; url: string; close: () => Promise<void> }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/`, close: () => new Promise(done => server.close(() => done())) });
    });
  });
}

test("probeScope passes recognised values and never defaults to any", () => {
  assert.equal(probeScope("loopback"), "loopback");
  assert.equal(probeScope("any"), "any");
  assert.equal(probeScope(undefined), "loopback-and-public");
  assert.equal(probeScope(""), "loopback-and-public");
  assert.equal(probeScope("ANY"), "loopback-and-public");
  assert.equal(probeScope("sketchy-value"), "loopback-and-public");
});

test("checkPortTool names a missing port instead of a generic range error", async () => {
  await assert.rejects(() => checkPortTool({}), /Missing "port"/);
});

test("checkPortTool probes a real loopback listener and echoes target", async () => {
  const { port, close } = await tcpServer();
  try {
    const r = await checkPortTool({ host: "127.0.0.1", port, scope: "loopback", timeout_ms: 2000 }) as Record<string, unknown>;
    assert.equal(r.open, true); // TCP probes answer `open` (the HTTP probe field is `ok`)
    assert.equal(r.host, "127.0.0.1");
    assert.equal(r.port, port);
  } finally {
    await close();
  }
});

test("checkHttpTool names a missing url", async () => {
  await assert.rejects(() => checkHttpTool({ url: "   " }), /Missing "url"/);
  await assert.rejects(() => checkHttpTool({}), /Missing "url"/);
});

test("checkHttpTool answers a loopback endpoint", async () => {
  const { url, close } = await httpServer((_req, res) => { res.end("hi"); });
  try {
    const r = await checkHttpTool({ url, scope: "loopback", timeout_ms: 3000 }) as Record<string, unknown>;
    assert.equal(r.ok, true);
  } finally {
    await close();
  }
});

test("saveService validates name, command, port, restart knobs and health_url", async () => {
  await assert.rejects(() => saveService({ name: "  " }), /name is required/);
  await assert.rejects(() => saveService({ name: "a" }), /command is required/);
  await assert.rejects(() => saveService({ name: "a", command: "x", port: 70000 }), /integer between 1 and 65535/);
  await assert.rejects(() => saveService({ name: "a", command: "x", max_restarts: "abc" }), /max_restarts/);
  await assert.rejects(() => saveService({ name: "a", command: "x", health_url: "not-a-url" }), /absolute http\(s\) URL/);
});

test("saveService stores the definition with defaults and persists it", async () => {
  const r = await saveService({ name: "web", command: KEEP_ALIVE, port: 47611 }) as Record<string, unknown>;
  assert.deepEqual(r, { name: "web", saved: true });
  const def = state.services.get("web");
  assert.ok(def);
  assert.equal(def!.group, "default");
  assert.equal(def!.autoRestart, false);
  assert.equal(def!.maxRestarts, 3);
  assert.equal(def!.restartDelayMs, 1000);
  await drain();
  const persisted = store.dump().get(`openBridge.services.${workspace}`) as Record<string, unknown>;
  assert.ok(persisted && persisted.web, "the service snapshot reaches the state store");
});

test("listServices and listServiceViews describe definitions without a live process", async () => {
  await saveService({ name: "web", command: KEEP_ALIVE });
  const listed = listServices() as Array<Record<string, unknown>>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, "web");
  assert.equal(listed[0].command_id, undefined);
  const views = listServiceViews();
  assert.equal(views[0].running, false);
  assert.equal(views[0].command_id, null);
  assert.equal(views[0].port, null);
});

test("start is exclusive: running, already_running, then an honest stop", async () => {
  await assert.rejects(() => startService({ name: "ghost" }), /Unknown service: "ghost"/);
  await saveService({ name: "web", command: KEEP_ALIVE });
  const first = await startService({ name: "web" }) as Record<string, unknown>;
  assert.equal(first.status, "running");
  const id = first.command_id as string;
  const second = await startService({ name: "web" }) as Record<string, unknown>;
  assert.equal(second.status, "already_running");
  assert.equal(second.command_id, id);

  const status = await serviceStatus({ name: "web" }) as Array<Record<string, unknown>>;
  assert.equal(status.length, 1);
  assert.equal(status[0].status, "running");
  assert.equal(status[0].command_id, id);

  const stopped = await stopService({ name: "web" }) as Record<string, unknown>;
  assert.equal(stopped.stopped, true);
  assert.equal(state.services.get("web")!.commandId, undefined);
  await assert.rejects(() => stopService({ name: "ghost" }), /Unknown service/);
  const again = await stopService({ name: "web" }) as Record<string, unknown>;
  assert.equal(again.stopped, false);
  assert.equal(again.status, "stopped");
});

test("restart replaces the process: a new id, the old child really gone", async () => {
  await saveService({ name: "web", command: KEEP_ALIVE });
  const first = await startService({ name: "web" }) as Record<string, unknown>;
  const oldId = first.command_id as string;
  const oldProc = state.commands.get(oldId)!;
  const r = await restartService({ name: "web" }) as Record<string, unknown>;
  assert.equal(r.restarted, true);
  const newId = r.command_id as string;
  assert.notEqual(newId, oldId);
  // Teardown is transactional: restartService returns only after the old tree
  // is really gone, so the old child must already be done here.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(oldProc.done, true);
  await assert.rejects(() => restartService({ name: "ghost" }), /Unknown service/);
});

test("deleteService removes a stopped definition and refuses an unknown name", async () => {
  await saveService({ name: "web", command: KEEP_ALIVE });
  const r = await deleteService({ name: "web" }) as Record<string, unknown>;
  assert.equal(r.deleted, true);
  assert.equal(state.services.has("web"), false);
  await assert.rejects(() => deleteService({ name: "ghost" }), /Unknown service/);
});

test("serviceStatus races the health probe: a slow endpoint reports timed_out", async () => {
  const { url, close } = await httpServer((_req, res) => {
    setTimeout(() => { res.end("slow"); }, 500);
  });
  try {
    await saveService({ name: "slow", command: KEEP_ALIVE, health_url: url });
    await saveService({ name: "plain", command: KEEP_ALIVE });
    const r = await serviceStatus({ timeout_ms: 1 }) as Array<Record<string, unknown>>;
    const byName = new Map(r.map(row => [row.name, row]));
    const health = byName.get("slow")!.health as Record<string, unknown>;
    assert.equal(health.timed_out, true);
    assert.match(health.error as string, /timed out after 1 ms/);
    assert.equal(byName.get("plain")!.health, undefined);
    assert.equal(byName.get("plain")!.status, "stopped");
  } finally {
    await close();
  }
});
