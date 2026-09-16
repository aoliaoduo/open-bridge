/**
 * Which configurations count as "a public tunnel is in play" — the question that
 * decides whether this instance advertises itself into OTHER builds' peer
 * registries (and therefore whether their tunnel can route our token here).
 *
 * The inline check this replaces asked only about ngrok, so an instance running
 * the Tailscale funnel published itself into its own registry file and nowhere
 * else: on a machine where two instances share the single 443 funnel — which is
 * the tailscale equivalent of ngrok Free's one-domain budget, and therefore the
 * case the sharing exists for — neither one could see the other. `publishSelf`
 * then had no peer row to advertise, `follower` never happened, and the shape of
 * the bug was silence: nothing in the log says "I did not publish".
 *
 * The rule itself is small enough to state exactly, so it is stated once, here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { tunnelInPlay } from "../src/bridge/peer-registry.js";

test("ngrok needs a domain to be a tunnel: without one there is nothing to serve", () => {
  assert.equal(tunnelInPlay("ngrok", "fixture.ngrok-free.dev", ""), true);
  assert.equal(tunnelInPlay("ngrok", "   ", ""), false, "whitespace is not a domain");
  assert.equal(tunnelInPlay("ngrok", "", ""), false);
});

test("tailscale is a tunnel too, on its own domain", () => {
  assert.equal(tunnelInPlay("tailscale", "", "machine.tail1234.ts.net"), true);
  assert.equal(tunnelInPlay("tailscale", "", ""), false, "before discovery there is no address yet");
  assert.equal(tunnelInPlay("tailscale", "", "  "), false);
});

test("the domains are not interchangeable: each provider reads its own", () => {
  // `--no-tunnel` with an ngrok domain still stored must publish nothing, and a
  // leftover ngrok domain must not make a tailscale instance look unpublished —
  // or the other way round, which would advertise us while the machine serves
  // nothing public.
  assert.equal(tunnelInPlay("none", "fixture.ngrok-free.dev", "machine.tail1234.ts.net"), false);
  assert.equal(tunnelInPlay("tailscale", "fixture.ngrok-free.dev", ""), false);
  assert.equal(tunnelInPlay("ngrok", "", "machine.tail1234.ts.net"), false);
});

test("an unknown provider value is not a tunnel", () => {
  assert.equal(tunnelInPlay("tailscal", "", "machine.tail1234.ts.net"), false);
  assert.equal(tunnelInPlay("", "", ""), false);
});
