import assert from "node:assert/strict";
import test from "node:test";
import { orphanManagedNgrokPidsFromRows } from "../src/bridge/tunnel/ngrok-runtime.js";

test("only orphaned Bridge-shaped ngrok agents for this domain are reclaimable across port changes", () => {
  const rows = [
    {
      ProcessId: 101,
      ParentProcessId: 999,
      Name: "ngrok.exe",
      CommandLine: '"C:\\Program Files\\ngrok\\ngrok.exe" http 8123 --url https://mine.ngrok-free.dev --log stdout',
    },
    {
      ProcessId: 201,
      ParentProcessId: 202,
      Name: "ngrok.exe",
      CommandLine: "ngrok.exe http 8123 --url https://mine.ngrok-free.dev --log stdout",
    },
    {
      ProcessId: 202,
      ParentProcessId: 1,
      Name: "node.exe",
      CommandLine: "node open-bridge.js serve",
    },
    {
      ProcessId: 301,
      ParentProcessId: 998,
      Name: "ngrok.exe",
      CommandLine: "ngrok.exe http 9000 --url https://mine.ngrok-free.dev --log stdout",
    },
    {
      ProcessId: 351,
      ParentProcessId: 995,
      Name: "ngrok.exe",
      CommandLine: "ngrok.exe http 70000 --url https://mine.ngrok-free.dev --log stdout",
    },
    {
      ProcessId: 361,
      ParentProcessId: 994,
      Name: "ngrok.exe",
      CommandLine: "ngrok.exe http 8123 --url https://mine.ngrok-free.dev",
    },
    {
      ProcessId: 401,
      ParentProcessId: 997,
      Name: "ngrok.exe",
      CommandLine: "ngrok.exe http 8123 --url https://other.ngrok-free.dev --log stdout",
    },
    {
      ProcessId: 501,
      ParentProcessId: 996,
      Name: "other.exe",
      CommandLine: "other.exe http 8123 --url https://mine.ngrok-free.dev --log stdout",
    },
  ];

  assert.deepEqual(
    orphanManagedNgrokPidsFromRows(rows, "mine.ngrok-free.dev"),
    [101, 301],
  );
});
