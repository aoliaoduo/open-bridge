import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { bridgeTokenFromPath, findPeerForToken, peerHash, probePublicBridge, proxyToPeer, publishPeer, readPeers, withdrawPeer, type PeerRecord } from "../src/http/peers.js";

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

function record(token: string, port: number, pid: number): PeerRecord { return { hash: peerHash(token), port, pid, root: "C:/work", at: Date.now() }; }
async function registryPath(): Promise<string> { return path.join(await mkdtemp(path.join(tmpdir(), "open-bridge-peers-")), "bridge-peers.json"); }
async function liveChild(): Promise<{ pid: number; child: ReturnType<typeof spawn>; stop: () => void }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15_000)"], { windowsHide: true });
  return { pid: child.pid ?? -1, child, stop: () => { try { child.kill(); } catch {} } };
}

test("only the two bridge path shapes are routable", () => {
  assert.deepEqual(bridgeTokenFromPath(`/mcp/${TOKEN_A}`), { kind: "mcp", token: TOKEN_A });
  assert.deepEqual(bridgeTokenFromPath(`/healthz/${TOKEN_A.toUpperCase()}`), { kind: "healthz", token: TOKEN_A });
  assert.equal(bridgeTokenFromPath(`/mcp/${TOKEN_A}/../../windows`), undefined);
  assert.equal(bridgeTokenFromPath(`/mcp/${"f".repeat(31)}`), undefined);
  assert.equal(bridgeTokenFromPath(`/mcp/gg${TOKEN_A.slice(0, 30)}`), undefined);
  assert.equal(bridgeTokenFromPath(`/admin/${TOKEN_A}`), undefined);
  assert.equal(bridgeTokenFromPath("/"), undefined);
});

test("route path casing is canonicalized so MCP calls can never become healthz routes", () => {
  // The router compares exact lowercase paths; a case-variant "/MCP/…" must
  // still be classified as an MCP route (the old ternary classified it as
  // healthz and proxied the call to the peer's health endpoint instead).
  assert.deepEqual(bridgeTokenFromPath(`/MCP/${TOKEN_A}`), { kind: "mcp", token: TOKEN_A });
  assert.deepEqual(bridgeTokenFromPath(`/Healthz/${TOKEN_A}`), { kind: "healthz", token: TOKEN_A });
});

test("the shared registry stores a digest, never the token itself", async () => {
  const file = await registryPath();
  const peer = await liveChild();
  try {
    await publishPeer(file, { token: TOKEN_A, port: 41_001, pid: process.pid, root: "C:/self", at: Date.now() });
    await publishPeer(file, { token: TOKEN_B, port: 41_002, pid: peer.pid, root: "C:/peer", at: Date.now() });
    const rows = JSON.parse(await readFile(file, "utf8"));
    rows.push({ hash: "nope", port: 41_003, pid: process.pid, root: "", at: 0 });
    await writeFile(file, JSON.stringify(rows), "utf8");
    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes(TOKEN_A) && !raw.includes(TOKEN_B), "registry leaked a route token");
    assert.ok(raw.includes(peerHash(TOKEN_A)), "registry should carry the token digest");
    assert.deepEqual((await readPeers(file)).map(row => row.port), [41_001, 41_002]);
    assert.equal(await findPeerForToken(file, TOKEN_A), undefined);
    assert.equal((await findPeerForToken(file, TOKEN_B))?.port, 41_002);
    await withdrawPeer(file, TOKEN_B);
    assert.deepEqual((await readPeers(file)).map(row => row.port), [41_001]);
    assert.equal(await findPeerForToken(file, TOKEN_B), undefined);
    await writeFile(file, "[{\"hash\":\"");
    assert.deepEqual(await readPeers(file), []);
  } finally { peer.stop(); }
});

test("a dead process entry is dropped on read", async () => {
  const file = await registryPath();
  const child = await liveChild();
  const pid = child.pid;
  // Await the actual exit instead of a fixed sleep: a fixed delay flakes on
  // loaded machines (and can pass before the kill took effect).
  const exited = new Promise<void>(resolve => child.child.once("exit", () => resolve()));
  child.stop();
  await exited;
  await publishPeer(file, { token: TOKEN_B, port: 41_009, pid, root: "C:/gone", at: Date.now() });
  assert.deepEqual(await readPeers(file), []);
});

test("the public probe tells mine, other and free apart", async () => {
  const real = globalThis.fetch;
  const answer = (status: number, body: string) => { globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch; };
  try {
    answer(200, '{"ok":true}');
    assert.equal(await probePublicBridge("shared.example", TOKEN_A), "mine");
    answer(404, '{"error":"Not found"}');
    assert.equal(await probePublicBridge("shared.example", TOKEN_A), "other");
    answer(404, "<html>url not found</html>");
    assert.equal(await probePublicBridge("shared.example", TOKEN_A), "free");
    answer(502, "bad gateway");
    assert.equal(await probePublicBridge("shared.example", TOKEN_A), "free");
    globalThis.fetch = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    assert.equal(await probePublicBridge("shared.example", TOKEN_A), "free");
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => { urls.push(String(input)); return new Response("", { status: 404 }) as Response; }) as typeof fetch;
    await probePublicBridge("shared.example", TOKEN_B);
    assert.deepEqual(urls, [`https://shared.example/healthz/${TOKEN_B}`]);
  } finally { globalThis.fetch = real; }
});

test("the proxy hands a peer request over untouched and streams the reply back", async () => {
  const seen: { url?: string; host?: string | undefined; method?: string; body?: string } = {};
  const peerServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const wanted = bridgeTokenFromPath(url.pathname);
    seen.url = req.url; seen.host = req.headers.host; seen.method = req.method;
    if (wanted?.token !== TOKEN_A) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Not found" })); return; }
    let body = "";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-peer-marker": "yes", connection: "keep-alive" });
    res.write("data: one\n\n");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => { seen.body = body; setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 40); });
  });
  await new Promise<void>(resolve => peerServer.listen(0, "127.0.0.1", resolve));
  const peerPort = (peerServer.address() as { port: number }).port;
  const frontServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = bridgeTokenFromPath(url.pathname)?.token ?? "";
    void proxyToPeer(record(token, peerPort, process.pid), req, res, `${url.pathname}${url.search}`);
  });
  await new Promise<void>(resolve => frontServer.listen(0, "127.0.0.1", resolve));
  const frontPort = (frontServer.address() as { port: number }).port;
  try {
    const chunks: string[] = [];
    const text = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: frontPort, method: "POST", path: `/mcp/${TOKEN_A}?id=7`, headers: { host: "shared.ngrok-free.dev", "content-type": "text/plain" } }, res => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers["content-type"], "text/event-stream");
        assert.equal(res.headers["x-peer-marker"], "yes");
        res.setEncoding("utf8");
        res.on("data", chunk => chunks.push(String(chunk)));
        res.on("end", () => resolve(chunks.join("")));
      });
      req.on("error", reject);
      req.end("hello");
    });
    assert.equal(text, "data: one\n\ndata: two\n\n");
    assert.ok(chunks.length >= 2, `expected streamed chunks, got ${chunks.length}`);
    assert.equal(seen.url, `/mcp/${TOKEN_A}?id=7`);
    assert.equal(seen.host, "shared.ngrok-free.dev");
    assert.equal(seen.method, "POST");
    assert.equal(seen.body, "hello");
    const miss = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: frontPort, method: "GET", path: `/mcp/${TOKEN_B}` }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(miss.status, 404);
    assert.match(miss.body, /Not found/);
  } finally {
    frontServer.close();
    peerServer.close();
  }
});

function startFront(peerPort: number, port: number): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = bridgeTokenFromPath(url.pathname)?.token ?? "";
    void proxyToPeer(record(token, peerPort, process.pid), req, res, `${url.pathname}${url.search}`);
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ port: (server.address() as { port: number }).port, close: () => server.close() })));
}

test("a peer that dies mid-response tears the client connection down (no silent hang)", async () => {
  // Regression guard for the abnormal-end wiring: the peer writes headers and
  // one SSE frame, then destroys its socket (like a window closing mid-stream).
  // The client must see a broken transfer, not a 200 that never finishes.
  const peerServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("data: one\n\n");
    setTimeout(() => { try { res.socket?.destroy(); } catch {} }, 60);
  });
  await new Promise<void>(resolve => peerServer.listen(0, "127.0.0.1", resolve));
  const peerPort = (peerServer.address() as { port: number }).port;
  const front = await startFront(peerPort, 0);
  try {
    const outcome = await new Promise<"ended" | "aborted">(resolve => {
      let settled = false;
      const fin = (value: "ended" | "aborted"): void => { if (!settled) { settled = true; resolve(value); } };
      const req = http.request({ host: "127.0.0.1", port: front.port, method: "GET", path: `/mcp/${TOKEN_A}` }, res => {
        res.setEncoding("utf8");
        res.on("data", () => { /* stream began */ });
        res.on("end", () => fin("ended"));
        res.on("aborted", () => fin("aborted"));
        res.on("error", () => fin("aborted"));
        // 'close' fires after 'end' too; res.complete tells them apart.
        res.on("close", () => fin(res.complete ? "ended" : "aborted"));
      });
      req.on("error", () => fin("aborted"));
      req.end();
    });
    assert.equal(outcome, "aborted", "peer death mid-stream must not look like a clean end");
  } finally {
    front.close();
    peerServer.close();
  }
});

test("a peer that is unreachable answers 502 and settles", async () => {
  // Refuse by pointing at a port with no listener (bind then close it).
  const holder = http.createServer();
  await new Promise<void>(resolve => holder.listen(0, "127.0.0.1", resolve));
  const freedPort = (holder.address() as { port: number }).port;
  await new Promise<void>(resolve => holder.close(() => resolve()));
  const front = await startFront(freedPort, 0);
  try {
    const status = await new Promise<number | undefined>(resolve => {
      const req = http.request({ host: "127.0.0.1", port: front.port, method: "GET", path: `/mcp/${TOKEN_A}` }, res => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", () => resolve(undefined));
      req.end();
    });
    assert.equal(status, 502);
  } finally {
    front.close();
  }
});
