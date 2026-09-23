/**
 * `connectivity`'s probe scope.
 *
 * The tool's `scope` argument selects which network locations a health probe may
 * reach, and the classifier behind it (src/network/safe-probe.ts) is what keeps
 * a probe away from LAN hosts, cloud-metadata addresses and other special
 * ranges. That classifier is only as good as the scope handed to it.
 *
 * The bug this pins: `probeScope` returned `"any"` — the most permissive scope —
 * for a missing or unrecognised value. Omitting `scope` is the ordinary case
 * (the schema invites it, and the description never mentioned the argument), so
 * the SSRF classifier was switched off by default:
 *
 *   connectivity { target: "http", url: "http://169.254.169.254/latest/meta-data/" }
 *
 * reached the metadata address. A security default must fail closed, and
 * `connectivity` is a security boundary by the project's own rule.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { probeScope } from "../src/bridge/tools/service-tools.js";
import { DEFAULT_PROBE_NETWORK_SCOPE, isAddressAllowed } from "../src/network/safe-probe.js";

test("an omitted scope gets the safe default, never the permissive one", () => {
  assert.equal(probeScope(undefined), DEFAULT_PROBE_NETWORK_SCOPE);
  assert.notEqual(probeScope(undefined), "any", "absence must not mean 'allow everything'");
  assert.equal(DEFAULT_PROBE_NETWORK_SCOPE, "loopback-and-public");
});

test("an unrecognised scope is treated exactly like an absent one", () => {
  for (const value of [null, "", "   ", "LAN", "private", "loop-back", 42, true, {}, ["any"], { scope: "any" }]) {
    assert.equal(
      probeScope(value),
      DEFAULT_PROBE_NETWORK_SCOPE,
      `${JSON.stringify(value)} must fall back to the default`,
    );
  }
});

test("the four documented scopes are still accepted verbatim", () => {
  assert.equal(probeScope("any"), "any", "the explicit opt-in still works");
  assert.equal(probeScope("loopback"), "loopback");
  assert.equal(probeScope("public"), "public");
  assert.equal(probeScope("loopback-and-public"), "loopback-and-public");
});

test("the default actually refuses the address the bug reached", () => {
  // The end-to-end consequence, stated where the classifier decides it: with the
  // default scope, a link-local metadata address and an RFC1918 host are both
  // refused, while the two normal probe targets still pass.
  const scope = probeScope(undefined);
  assert.equal(isAddressAllowed("link-local", scope), false, "169.254.0.0/16 (cloud metadata) is refused");
  assert.equal(isAddressAllowed("private", scope), false, "RFC1918 / ULA is refused");
  assert.equal(isAddressAllowed("loopback", scope), true, "a local dev server still works");
  assert.equal(isAddressAllowed("public", scope), true, "a public health endpoint still works");
});
