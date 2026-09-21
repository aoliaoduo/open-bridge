import assert from "node:assert/strict";
import test from "node:test";
import { setHost, type Host } from "../src/host/host.js";
import {
  forgetSessionTicket,
  hasLiveSessionTicket,
  rememberSessionTicket,
  resetSessionTicketCache,
  SESSION_IDLE_TIMEOUT_MS,
  sessionTicket,
  touchSessionTicket,
  pruneSessionTickets,
} from "../src/bridge/session-store.js";

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
