/**
 * Service starts must not report "running" before the child has actually
 * spawned. Bulk starts preserve the result of a good sibling when another
 * saved service cannot launch.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installNodeHost } from "../src/host/node-host.js";
import { startAllServices, startService } from "../src/bridge/service-tools.js";
import { terminateProcess } from "../src/bridge/processes.js";
import { state, type ServiceDefinition } from "../src/bridge/state.js";

let home: string;

function service(cwd: string): ServiceDefinition {
  return {
    command: "node -e \"setTimeout(() => {}, 60000)\"",
    cwd,
    env: {},
    group: "launch-contract",
    autoRestart: false,
    maxRestarts: 0,
    restartDelayMs: 0,
  };
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ob-svc-start-"));
  installNodeHost({ homeDir: home, version: "0.0.0-test" });
  state.services.clear();
  state.commands.clear();
});

afterEach(async () => {
  await Promise.all([...state.commands.values()].map(command => terminateProcess(command, "stopped")));
  state.services.clear();
  state.commands.clear();
  rmSync(home, { recursive: true, force: true });
});

test("start_service refuses a saved service whose child cannot spawn", async () => {
  state.services.set("broken", service("definitely-missing-service-cwd"));

  await assert.rejects(startService({ name: "broken" }), /Command failed to start:/);
  assert.equal(state.services.get("broken")?.commandId, undefined,
    "a failed child is never advertised as the service's running command");
});

test("start_all keeps a successful sibling and reports the failed launch in its row", async () => {
  state.services.set("healthy", service("."));
  state.services.set("broken", service("definitely-missing-service-cwd"));

  const rows = await startAllServices({ group: "launch-contract", parallel: true }) as Array<{
    name: string; status?: string; error?: string;
  }>;
  assert.deepEqual(rows.map(row => row.name), ["healthy", "broken"]);
  assert.equal(rows[0]?.status, "running", "the healthy sibling still starts");
  assert.match(rows[1]?.error ?? "", /Command failed to start:/,
    "the broken sibling is represented by its own result row");
});
