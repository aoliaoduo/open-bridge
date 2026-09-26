import assert from "node:assert/strict";
import test from "node:test";
import { setHost, type Host } from "../src/host/host.js";
import {
  flushSessionTickets,
  forgetSessionTicket,
  hasLiveSessionTicket,
  rememberSessionTicket,
  resetSessionTicketCache,
  SESSION_IDLE_TIMEOUT_MS,
  sessionTicket,
  touchSessionTicket,
  pruneSessionTickets,
} from "../src/bridge/sessions/session-store.js";

const bag = new Map<string, unknown>();

function memoryHost(): Host {
  return {
    config: {
      get: <T>(...args: [string, T]): T => args[1],
      update: async (): Promise<void> => undefined,
    },
    secrets: {
      get: async (): Promise<string | undefined> => undefined,
      store: async (): Promise<void> => undefined,
    },
    state: {
      get: <T>(key: string, fallback: T): T => (bag.has(key) ? bag.get(key) as T : fallback),
      update: async (key: string, value: unknown): Promise<void> => {
        bag.set(key, value);
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
}

function countingHost(): { host: Host; writes: () => number } {
  let writes = 0;
  const host = memoryHost();
  const original = host.state.update.bind(host.state);
  host.state.update = async (key: string, value: unknown): Promise<void> => {
    writes += 1;
    await original(key, value);
  };
  return { host, writes: () => writes };
}

setHost(memoryHost());

test("a remembered ticket is live and survives a cache drop", async () => {
  bag.clear();
  resetSessionTicketCache();
  rememberSessionTicket("aa".repeat(16), "arena-agent/1.0");
  await new Promise(r => setTimeout(r, 20));
  assert.equal(hasLiveSessionTicket("aa".repeat(16)), true);
  assert.equal(sessionTicket("aa".repeat(16))?.client, "arena-agent/1.0");
  resetSessionTicketCache();
  assert.equal(hasLiveSessionTicket("aa".repeat(16)), true, "hydrates from the host store");
});

test("a never-issued id is not live", () => {
  resetSessionTicketCache();
  assert.equal(hasLiveSessionTicket("00".repeat(16)), false);
});

test("idle tickets expire", () => {
  bag.clear();
  resetSessionTicketCache();
  const id = "bb".repeat(16);
  const now = 1_000_000;
  rememberSessionTicket(id, undefined, now);
  assert.equal(hasLiveSessionTicket(id, now + SESSION_IDLE_TIMEOUT_MS - 1), true);
  assert.equal(hasLiveSessionTicket(id, now + SESSION_IDLE_TIMEOUT_MS + 1), false);
  pruneSessionTickets(now + SESSION_IDLE_TIMEOUT_MS + 1);
  resetSessionTicketCache();
  assert.equal(hasLiveSessionTicket(id, now + SESSION_IDLE_TIMEOUT_MS + 2), false);
});

test("forget drops the ticket", async () => {
  bag.clear();
  resetSessionTicketCache();
  const id = "cc".repeat(16);
  rememberSessionTicket(id);
  forgetSessionTicket(id);
  await new Promise(r => setTimeout(r, 20));
  resetSessionTicketCache();
  assert.equal(hasLiveSessionTicket(id), false);
});

test("touch refreshes lastUsed", () => {
  bag.clear();
  resetSessionTicketCache();
  const id = "dd".repeat(16);
  rememberSessionTicket(id, undefined, 10);
  touchSessionTicket(id, 50);
  assert.equal(sessionTicket(id)?.lastUsed, 50);
});

test("a prune that removed nothing must not write state", async () => {
  // pruneSessionTickets ran on EVERY /mcp request and used to persist
  // unconditionally in both branches — a whole state.json rewrite per request
  // for a stamp flush touch now schedules itself.
  bag.clear();
  resetSessionTicketCache();
  const { host, writes } = countingHost();
  setHost(host);
  pruneSessionTickets(Date.now());
  await new Promise(r => setTimeout(r, 20));
  assert.equal(writes(), 0, "an idle prune has nothing of its own to save");
  resetSessionTicketCache();
  setHost(memoryHost());
});

test("touch alone never writes; the flush carries the pending stamp", async () => {
  bag.clear();
  resetSessionTicketCache();
  const { host, writes } = countingHost();
  setHost(host);
  const id = "ee".repeat(16);
  rememberSessionTicket(id, undefined, 10);
  await flushSessionTickets();
  const afterRemember = writes();
  assert.ok(afterRemember >= 1, "remember persists immediately");
  touchSessionTicket(id, 99);
  assert.equal(writes(), afterRemember, "a touch schedules, it does not write");
  await flushSessionTickets();
  assert.equal(writes(), afterRemember + 1, "the forced flush lands the pending stamp");
  assert.equal(sessionTicket(id)?.lastUsed, 99, "the in-memory value was intact all along");
  resetSessionTicketCache();
  setHost(memoryHost());
});
