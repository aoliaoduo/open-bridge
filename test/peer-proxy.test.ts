/**
 * proxyToPeer's forwarded headers.
 *
 * The peer's Host allowlist (request-policy.ts) expects the peer's OWN
 * address: loopback on its port plus the shared tunnel domain. Forwarding the
 * caller's Host verbatim made every local cross-window proxy request answer
 * 403 from the peer's gate ("Host is not allowed.") — the registry's own
 * documented same-machine path. Tunnel-originated traffic kept working,
 * which is why the break stayed invisible.
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { proxyToPeer } from "../src/http/peers.js";

test("proxyToPeer rewrites Host to the peer's own address", async () => {
  const seen: Record<string, unknown> = {};
  const peer = http.createServer((req, res) => {
    seen.host = req.headers.host;
    seen.method = req.method;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", () => resolve()));
  const peerPort = (peer.address() as { port: number }).port;

  const holder = http.createServer((req, res) => {
    void proxyToPeer(
      { hash: "a".repeat(32), port: peerPort, pid: process.pid, root: "C:\\workspace", at: Date.now() },
      req, res, `/mcp/${"b".repeat(32)}`,
    );
  });
  await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", () => resolve()));
  const holderPort = (holder.address() as { port: number }).port;

  try {
    const status = await new Promise<number>((resolve, reject) => {
      const client = http.request(
        { host: "127.0.0.1", port: holderPort, path: `/mcp/${"b".repeat(32)}`, method: "POST" },
        res => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      client.on("error", reject);
      client.end();
    });
    assert.equal(status, 200, "the relay completes");
    assert.equal(seen.method, "POST");
    assert.equal(
      seen.host,
      `127.0.0.1:${peerPort}`,
      `the peer must see its own Host, not the caller's (got ${String(seen.host)})`,
    );
  } finally {
    peer.close();
    holder.close();
  }
});
