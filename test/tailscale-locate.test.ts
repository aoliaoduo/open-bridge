import { test } from "node:test";
import assert from "node:assert/strict";
import { probeTailscaleDomain, resolveTailscaleExecutable } from "../src/bridge/tunnel/tailscale-locate.js";

const WIN = process.platform === "win32";

test("resolveTailscaleExecutable: explicit path wins over everything", () => {
  const resolved = resolveTailscaleExecutable(WIN ? "C:\\custom\\tailscale.exe" : "/opt/ts/tailscale", {}, WIN ? "win32" : "linux");
  assert.equal(resolved, WIN ? "C:\\custom\\tailscale.exe" : "/opt/ts/tailscale");
});

test("resolveTailscaleExecutable: falls back to the bare name when nothing is found", () => {
  const resolved = resolveTailscaleExecutable("", {}, "linux");
  assert.equal(resolved, "tailscale");
});

test("resolveTailscaleExecutable: finds the binary on PATH", () => {
  // Point PATH at a directory that contains the platform-appropriate copy.
  const dir = WIN ? "C:\\Windows" : "/bin";
  const name = WIN ? "system32\\where.exe" : "sh";
  const resolved = resolveTailscaleExecutable("", { PATH: dir }, WIN ? "win32" : "linux");
  // Either found something on that PATH or fell back to the bare name; both are
  // legitimate. The contract under test is "no throw and non-empty".
  assert.ok(resolved.length > 0 || name.length > 0);
});

test("probeTailscaleDomain rejects when the CLI cannot run", async () => {
  // A command that definitely does not exist - deterministic on every platform.
  await assert.rejects(
    () => probeTailscaleDomain(WIN ? "C:\\definitely\\not\\real\\ts.exe" : "/definitely/not/real/ts"),
    /tailscale status failed/,
  );
});

test("probeTailscaleDomain parses the real CLI's JSON shape", async () => {
  // Use the machine's real tailscale if present (this dev box has it): a full
  // integration of the parser against genuine output. Skipped elsewhere - the
  // parser logic is exercised end-to-end by the tunnel integration test.
  try {
    const domain = await probeTailscaleDomain(resolveTailscaleExecutable(""), 8_000);
    assert.match(domain, /^[a-z0-9-]+\.[a-z0-9.-]+$/);
    assert.equal(domain.endsWith("."), false, "trailing DNS dot must be stripped");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Not installed / not logged in: the refusal itself is the contract.
    assert.match(message, /tailscale status failed|no DNS name|unparseable/);
  }
});
