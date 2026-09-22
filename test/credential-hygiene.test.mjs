import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { credentialFindings, scanRepository } from "../scripts/check-credentials.mjs";

test("credential guard catches random routes even on an example host without echoing values", () => {
  const token = randomBytes(16).toString("hex");
  for (const source of [`https://bridge.example.invalid/mcp/${token}`, `routeToken: "${token}"`]) {
    const findings = credentialFindings("fixture.ts", source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].rule, "literal-route-credential");
    assert.equal(JSON.stringify(findings).includes(token), false);
  }
});

test("credential guard allows conspicuously synthetic fixtures and symbolic placeholders", () => {
  for (const token of ["a".repeat(32), "b".repeat(32), "0".repeat(32), "0123456789abcdef".repeat(2), "<route-token>"]) {
    assert.deepEqual(credentialFindings("fixture.ts", `https://bridge.example.invalid/mcp/${token}`), []);
  }
});

test("credential guard catches private keys without returning their text", () => {
  const source = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  assert.deepEqual(credentialFindings("key.txt", source), [{ file: "key.txt", line: 1, rule: "private-key" }]);
});

test("repository scan includes staged private files and untracked source but respects ignores", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ob-credential-check-"));
  try {
    execFileSync("git", ["init", "--quiet", root]);
    mkdirSync(path.join(root, "test"));
    writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
    mkdirSync(path.join(root, "ignored"));
    const source = `routeToken: "${randomBytes(16).toString("hex")}"`;
    writeFileSync(path.join(root, "ignored", "private.txt"), source);
    writeFileSync(path.join(root, "test", "new.ts"), source);
    writeFileSync(path.join(root, ".env"), "PLACEHOLDER=1\n");
    execFileSync("git", ["-C", root, "add", ".env"]);
    const findings = scanRepository(root);
    assert.deepEqual(findings.map(({ file }) => file).sort(), [".env", "test/new.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publishable repository sources do not contain route credentials or private files", () => {
  assert.deepEqual(scanRepository(), [], "credential locations only; never echo matched content");
});
