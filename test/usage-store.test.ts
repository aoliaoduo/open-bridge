/**
 * Usage-stat persistence.
 *
 * Every counted tool call used to schedule a full state.json rewrite (cross-
 * process lock, re-read, stringify, fsync, rename) — two whole-document
 * writes per MCP request once session-ticket pruning was counted too. The
 * counters are loss-tolerant, so they now coalesce into a debounced write;
 * the reset stays immediate so a stale snapshot cannot resurrect old totals.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { setHost, type Host } from "../src/host/host.js";
import { state } from "../src/bridge/state.js";
import {
  flushUsageStats,
  persistUsageStats,
  resetUsageStats,
} from "../src/bridge/usage-store.js";

function countingHost(): { host: Host; writes: () => number } {
  let writes = 0;
  const host: Host = {
    config: {
      get: <T>(...args: [string, T]): T => args[1],
      update: async (): Promise<void> => undefined,
    },
    secrets: {
      get: async (): Promise<string | undefined> => undefined,
      store: async (): Promise<void> => undefined,
    },
    state: {
      get: <T>(_key: string, fallback: T): T => fallback,
      update: async (): Promise<void> => {
        writes += 1;
      },
    },
    storageDir: () => "",
    version: () => "test",
    bundledRipgrep: () => undefined,
    projectRoot: () => "",
    notify: (): void => undefined,
    log: (): void => undefined,
    ui: { update: (): void => undefined, refresh: (): void => undefined },
  };
  return { host, writes: () => writes };
}

const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

test("counted calls coalesce into one debounced write; reset stays immediate", async () => {
  const { host, writes } = countingHost();
  setHost(host);
  try {
    persistUsageStats();
    persistUsageStats();
    await delay(30);
    assert.equal(writes(), 0, "a counted call must not write the whole state document");
    await flushUsageStats();
    assert.equal(writes(), 1, "the debounced flush lands once");

    resetUsageStats();
    await delay(30);
    assert.equal(writes(), 2, "reset writes immediately, not on the debounce");
    assert.equal(state.usage.calls, 0);
  } finally {
    await flushUsageStats();
    setHost({
      config: { get: <T>(...args: [string, T]): T => args[1], update: async (): Promise<void> => undefined },
      secrets: { get: async (): Promise<string | undefined> => undefined, store: async (): Promise<void> => undefined },
      state: { get: <T>(_key: string, fallback: T): T => fallback, update: async (): Promise<void> => undefined },
      storageDir: () => "",
      version: () => "test",
      bundledRipgrep: () => undefined,
      projectRoot: () => "",
      notify: (): void => undefined,
      log: (): void => undefined,
      ui: { update: (): void => undefined, refresh: (): void => undefined },
    });
  }
});
