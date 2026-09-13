import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setHost, type Host } from "../src/host/host.js";
import { SERVICES_STATE_PREFIX, state } from "../src/bridge/state.js";
import { loadServices } from "../src/bridge/services.js";

const store = new Map<string, unknown>();

function memoryHost(backing: Map<string, unknown>): Host {
  return {
    config: {
      get: <T>(...args: [string, T]): T => args[1],
      update: async (): Promise<void> => undefined,
    },
    secrets: {
      get: async (): Promise<string | undefined> => undefined,
      store: async (): Promise<void> => undefined,
    },
    globalState: {
      get: <T>(key: string, fallback: T): T => (backing.has(key) ? (backing.get(key) as T) : fallback),
      update: async (key: string, value: unknown): Promise<void> => {
        backing.set(key, value);
      },
    },
    storageDir: () => "",
    version: () => "test",
    bundledRipgrep: () => undefined,
    projectRoot: () => "",
    notify: (): void => undefined,
    log: (): void => undefined,
    ui: { update: (): void => undefined, refresh: (): void => undefined },
    capabilities: { lsp: false },
  };
}

// Unit-test files run in their own process, so installing a memory host here
// cannot leak into any other file's tests.
setHost(memoryHost(store));

const serviceKey = `${SERVICES_STATE_PREFIX}${state.activeWorkspaceRoot || "unbound"}`;

beforeEach(() => {
  store.clear();
  state.services.clear();
});

test("garbage restart knobs fall back to defaults instead of becoming NaN", () => {
  store.set(serviceKey, {
    bad: { command: "node server.js", maxRestarts: "abc", restartDelayMs: "soon" },
    negative: { command: "node other.js", maxRestarts: -5, restartDelayMs: -1 },
  });
  loadServices();
  const bad = state.services.get("bad");
  assert.ok(bad);
  assert.equal(bad.maxRestarts, 3);
  assert.equal(bad.restartDelayMs, 1000);
  const negative = state.services.get("negative");
  assert.ok(negative);
  assert.equal(negative.maxRestarts, 3);
  assert.equal(negative.restartDelayMs, 1000);
});

test("valid knobs and numeric strings load as before", () => {
  store.set(serviceKey, {
    tuned: { command: "x", maxRestarts: 7, restartDelayMs: 250 },
    quoted: { command: "y", maxRestarts: "5", restartDelayMs: "500" },
  });
  loadServices();
  assert.equal(state.services.get("tuned")?.maxRestarts, 7);
  assert.equal(state.services.get("tuned")?.restartDelayMs, 250);
  assert.equal(state.services.get("quoted")?.maxRestarts, 5);
  assert.equal(state.services.get("quoted")?.restartDelayMs, 500);
});

test("one corrupt entry cannot abort the load of the rest", () => {
  store.set(serviceKey, {
    bad: { command: "x", maxRestarts: { nope: true } },
    good: { command: "y", maxRestarts: 2 },
    nocmd: { maxRestarts: 2 },
  });
  loadServices();
  assert.equal(state.services.get("bad")?.maxRestarts, 3);
  assert.equal(state.services.get("good")?.maxRestarts, 2);
  assert.equal(state.services.has("nocmd"), false);
});
