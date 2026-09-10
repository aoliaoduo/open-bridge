import assert from "node:assert/strict";
import test from "node:test";
import { bridgeAllowedHosts, isAllowedBridgeHost, validateNgrokDomain } from "../src/http/request-policy.js";

test("allows only the loopback listener and configured tunnel host", () => {
  assert.deepEqual(bridgeAllowedHosts(43123, "Bridge.Example.ngrok-free.dev"), [
    "127.0.0.1:43123",
    "localhost:43123",
    "bridge.example.ngrok-free.dev",
    "bridge.example.ngrok-free.dev:443",
  ]);
  assert.equal(isAllowedBridgeHost("LOCALHOST:43123", 43123, "bridge.example.ngrok-free.dev"), true);
  assert.equal(isAllowedBridgeHost("bridge.example.ngrok-free.dev", 43123, "bridge.example.ngrok-free.dev"), true);
  assert.equal(isAllowedBridgeHost("attacker.example", 43123, "bridge.example.ngrok-free.dev"), false);
  assert.equal(isAllowedBridgeHost(undefined, 43123, "bridge.example.ngrok-free.dev"), false);
});

test("rejects invalid listener ports", () => {
  assert.throws(() => bridgeAllowedHosts(0), /between 1 and 65535/);
  assert.throws(() => bridgeAllowedHosts(65_536), /between 1 and 65535/);
});

test("normalizes a valid ngrok hostname and rejects URL-shaped values", () => {
  assert.equal(validateNgrokDomain(" Bridge.Example.ngrok-free.dev "), "bridge.example.ngrok-free.dev");
  for (const invalid of ["", ".example.test", "example.test.", "example..test", "https://example.test", "example.test/path"]) {
    assert.throws(() => validateNgrokDomain(invalid), /valid hostname/);
  }
});
