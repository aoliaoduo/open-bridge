/**
 * Who holds port 443 on this machine's tailnet name, and may we take it?
 *
 * The ngrok path could ask the edge ("is anyone serving this reserved domain?")
 * and got a truthful `free`. Funnel has no such edge to ask: the name belongs to
 * THIS node, and the only holder can be another Bridge instance on this machine
 * that has already written a 443 mount into the daemon's serve config. The
 * daemon's own `funnel status --json` is therefore the evidence, and the rule
 * this file pins is what makes it safe to act on:
 *
 *   - a mount pointing at OUR port is ours (leave it alone);
 *   - a mount pointing at a port that is still listening belongs to a live
 *     instance that is routing traffic right now - following it is correct,
 *     taking it over is a hijack (and the peer's teardown would later kill our
 *     public access, or ours its);
 *   - a mount pointing at a port nobody serves is a leftover from an instance
 *     that died without running `funnel off` - the release HAS happened, and
 *     waiting for the config to disappear would wait forever;
 *   - a CLI that did not answer is never evidence of freedom. Assuming `free`
 *     there is how two instances end up trading the mount back and forth.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  funnelVerdict, parseFunnelBackend, readFunnelConfig, type FunnelBackend,
} from "../src/bridge/funnel-ownership.js";

const DOMAIN = "fixture-machine.tail9999.ts.net";

const config = (proxyPort: number, hostKey = `${DOMAIN}:443`): string => JSON.stringify({
  TCP: { "443": { HTTPS: true } },
  Web: { [hostKey]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${proxyPort}` } } } },
  AllowFunnel: { [hostKey]: true },
});

test("a mount for this hostname reports the backend port it points at", () => {
  assert.deepEqual(parseFunnelBackend(config(18080), DOMAIN), { port: 18080, funnel: true });
});

test("no mount for this hostname - including an empty serve config - is not a holder", () => {
  assert.equal(parseFunnelBackend("{}", DOMAIN), undefined, "a node with no config holds nothing");
  assert.equal(parseFunnelBackend(config(18080, "other-machine.tail1234.ts.net:443"), DOMAIN), undefined,
    "a mount belonging to another hostname is not this node's 443 mount");
  assert.equal(parseFunnelBackend("", DOMAIN), undefined);
});

test("the teardown question ignores the hostname and asks whose port the 443 mount points at", () => {
  // A stop must not switch off a peer's funnel, so it compares ports, not names:
  // one node has one name, and the mount that exists is the one in question.
  assert.deepEqual(parseFunnelBackend(config(18080, "renamed-machine.tail9999.ts.net:443")),
    { port: 18080, funnel: true });
  assert.equal(parseFunnelBackend(JSON.stringify({ Web: { "x:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:18080" } } } } })),
    undefined, "a non-443 mount is a tailnet-only serve, not the funnel");
});

test("mine, other, free and unknown are decided by the mount and the listener", () => {
  const mount = (port: number): { kind: "config"; backend: FunnelBackend } =>
    ({ kind: "config", backend: { port, funnel: true } });
  assert.equal(funnelVerdict(mount(18080), 18080, true), "mine");
  assert.equal(funnelVerdict(mount(18080), 18081, true), "other", "a live backend we do not own");
  assert.equal(funnelVerdict(mount(18080), 18081, false), "free", "a dead backend is a release");
  assert.equal(funnelVerdict({ kind: "config" }, 18081, false), "free", "no mount at all: nobody holds 443");
  assert.equal(funnelVerdict({ kind: "unreadable", reason: "boom" }, 18081, false), "unknown",
    "a CLI that did not answer proves nothing");
});

test("an unreadable CLI is reported as such, never as a missing config", async () => {
  const read = await readFunnelConfig("definitely-not-tailscale", DOMAIN, 300);
  assert.equal(read.kind, "unreadable");
  assert.match(read.reason, /failed|ENOENT|not found/i);
});
