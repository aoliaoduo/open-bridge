import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost } from "../src/host/node-host.js";
import { buildSettingsState } from "../src/server/settings-handler.js";
import { state } from "../src/bridge/state.js";

let home: string;
let previousServer: typeof state.server;
let previousSessions: typeof state.sessions;
let previousModernLastUsed: number;
let previousModernSince: number;
let previousModernInFlight: number;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-settings-state-"));
  installNodeHost({ homeDir: home, projectRoot: home, version: "0.0.0-test" });
  previousServer = state.server;
  previousSessions = state.sessions;
  previousModernLastUsed = state.modernLastUsed;
  previousModernSince = state.modernSince;
  previousModernInFlight = state.modernInFlight;

  state.server = {} as typeof state.server;
  state.sessions = new Map();
  state.modernLastUsed = 0;
  state.modernSince = 0;
  state.modernInFlight = 0;
});

afterEach(() => {
  state.server = previousServer;
  state.sessions = previousSessions;
  state.modernLastUsed = previousModernLastUsed;
  state.modernSince = previousModernSince;
  state.modernInFlight = previousModernInFlight;
  rmSync(home, { recursive: true, force: true });
});

test("settings status reports active stateless MCP work instead of ready", async () => {
  state.modernSince = Date.now() - 1_000;
  state.modernLastUsed = Date.now();
  state.modernInFlight = 1;

  const settings = await buildSettingsState();
  assert.deepEqual(settings.status, { kind: "active" });
});
