import assert from "node:assert/strict";
import test from "node:test";
import { isDeterministicNetworkFailure } from "../src/network/net-failure.js";

test("certificate-chain failures count as deterministic (retrying cannot heal)", () => {
  for (const code of [
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_UNTRUSTED",
    "CERT_REVOKED",
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ENOTFOUND",
    "ECONNREFUSED",
  ]) {
    assert.equal(isDeterministicNetworkFailure(Object.assign(new Error("x"), { code })), true, code);
  }
});

test("transient resolver failures (EAI_AGAIN) stay non-deterministic", () => {
  assert.equal(isDeterministicNetworkFailure(Object.assign(new Error("x"), { code: "EAI_AGAIN" })), false);
});

test("deterministic codes are found through the cause chain", () => {
  const inner = Object.assign(new Error("inner"), { code: "UNABLE_TO_GET_ISSUER_CERT" });
  assert.equal(isDeterministicNetworkFailure({ cause: inner }), true);
});
