/**
 * selfProbe — the loopback self-request the Bridge uses to check itself.
 *
 * What has to hold: it answers like a client (status + body), it never rejects
 * (a probe that throws would turn a health check into a crash), it honours its
 * timeout, and — the reason it exists at all — it leaves no connection pooled
 * in the process that is about to shut down.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { selfProbe } from "../src/bridge/self-probe.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  // `AddressInfo` is a type-only export of node:net — a value import would fail at
  // runtime, and this file is not covered by tsconfig, so nothing would catch it.
  return (server.address() as { port: number }).port;
}

test("selfProbe reads the status and the body of a local answer", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const port = await listen(server);
  try {
    const result = await selfProbe(port, "/healthz/token-under-test");
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { ok: true, path: "/healthz/token-under-test" });
  } finally {
    server.close();
  }
});

test("selfProbe carries method, headers and body (the bearer-gate probe needs a real POST)", async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    req.on("end", () => {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(`${req.method} ${String(req.headers["content-type"] ?? "")} ${Buffer.concat(chunks).toString("utf8")}`);
    });
  });
  const port = await listen(server);
  try {
    const result = await selfProbe(port, "/mcp/x", { method: "POST", headers: { "content-type": "application/json" }, body: '{"ping":1}' });
    assert.equal(result.ok, false, "401 is a valid answer, not a failure of the probe");
    assert.equal(result.status, 401);
    assert.equal(result.body, 'POST application/json {"ping":1}');
  } finally {
    server.close();
  }
});

test("a server that never answers is resolved as a timeout, not left pending", async () => {
  const server = createServer(() => { /* deliberately never responds */ });
  const port = await listen(server);
  try {
    const startedAt = Date.now();
    const result = await selfProbe(port, "/healthz/x", { timeoutMs: 250 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.match(result.body, /timed out after 250 ms/);
    assert.ok(Date.now() - startedAt < 5_000, "the budget is honoured, not the default");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a garbage timeout falls back to the default instead of firing immediately", async () => {
  // Number("abc") is NaN; Math.max(0, NaN) is NaN too, and a NaN timer is the
  // classic "crashes at ~0 ms" bug. The probe must not turn an unreachable
  // listener into an instant false negative.
  const server = createServer((_req, res) => { res.writeHead(200); res.end("{}", "utf8"); });
  const port = await listen(server);
  try {
    for (const bad of [Number.NaN, 0, -5, "abc"]) {
      const result = await selfProbe(port, "/healthz/x", { timeoutMs: bad as unknown as number });
      assert.equal(result.ok, true, `timeoutMs=${String(bad)} must fall back to the default, not fail the probe`);
    }
  } finally {
    server.close();
  }
});

test("nothing is left connected after the probe returns", async () => {
  // This is the whole point of the module: the process must not be holding a
  // keep-alive socket to itself when shutdown destroys the listening side.
  const sockets: Set<{ destroyed: boolean }> = new Set();
  const server = createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
  server.on("connection", socket => {
    sockets.add(socket as { destroyed: boolean });
    socket.on("close", () => sockets.delete(socket as { destroyed: boolean }));
  });
  const port = await listen(server);
  try {
    await selfProbe(port, "/healthz/x");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(sockets.size, 0, `selfProbe left ${sockets.size} connection(s) open against its own server`);
  } finally {
    server.close();
  }
});
