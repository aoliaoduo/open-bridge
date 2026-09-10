import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  NetworkProbeError,
  classifyIpAddress,
  displayProbeUrl,
  isAddressAllowed,
  parseHttpProbeUrl,
  probeHttpHealth,
  probeTcpPort,
  resolveProbeTarget,
  type HostResolver,
} from "../src/network/safe-probe.js";

async function listen<T extends net.Server>(server: T): Promise<{ server: T; port: number }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as AddressInfo).port };
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function assertProbeError(code: NetworkProbeError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof NetworkProbeError && error.code === code;
}

test("classifies IPv4, IPv6, mapped IPv4, and known cloud metadata targets", () => {
  assert.equal(classifyIpAddress("127.0.0.1"), "loopback");
  assert.equal(classifyIpAddress("10.1.2.3"), "private");
  assert.equal(classifyIpAddress("172.31.255.255"), "private");
  assert.equal(classifyIpAddress("192.168.1.1"), "private");
  assert.equal(classifyIpAddress("169.254.169.254"), "link-local");
  assert.equal(classifyIpAddress("100.100.100.200"), "reserved");
  assert.equal(classifyIpAddress("198.51.100.4"), "reserved");
  assert.equal(classifyIpAddress("8.8.8.8"), "public");

  assert.equal(classifyIpAddress("::1"), "loopback");
  assert.equal(classifyIpAddress("::ffff:127.0.0.1"), "loopback");
  assert.equal(classifyIpAddress("::ffff:169.254.169.254"), "link-local");
  assert.equal(classifyIpAddress("fe80::1"), "link-local");
  assert.equal(classifyIpAddress("fd12::1"), "private");
  assert.equal(classifyIpAddress("2001:db8::1"), "reserved");
  assert.equal(classifyIpAddress("2606:4700:4700::1111"), "public");
});

test("default policy allows local development and public health checks, not private or metadata networks", () => {
  assert.equal(isAddressAllowed("loopback"), true);
  assert.equal(isAddressAllowed("public"), true);
  assert.equal(isAddressAllowed("private"), false);
  assert.equal(isAddressAllowed("link-local"), false);
  assert.equal(isAddressAllowed("private", "any"), true);
  assert.equal(isAddressAllowed("link-local", "any"), true);
  assert.equal(isAddressAllowed("public", "loopback"), false);
});

test("URL parsing canonicalizes numeric loopback forms and never exposes query secrets in results", () => {
  const url = parseHttpProbeUrl("http://2130706433:8080/health?token=very-secret#fragment");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.hash, "");
  assert.equal(displayProbeUrl(url), "http://127.0.0.1:8080/health?<redacted>");
  assert.throws(() => parseHttpProbeUrl("ftp://example.test/"), assertProbeError("INVALID_URL"));
  const authed = parseHttpProbeUrl("http://user:pass@example.test/"); assert.equal(authed.username, "user"); assert.equal(displayProbeUrl(authed), "http://example.test/");
  assert.throws(() => parseHttpProbeUrl("http://example.test:0/"), assertProbeError("INVALID_URL"));
});

test("DNS policy examines every answer and bypasses DNS only for a true IP literal", async () => {
  let resolverCalls = 0;
  const resolver: HostResolver = async hostname => {
    resolverCalls += 1;
    assert.equal(hostname, "mixed.test");
    return [
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ];
  };
  await assert.rejects(resolveProbeTarget("mixed.test", { resolve: resolver }), assertProbeError("UNSAFE_TARGET"));
  assert.equal(resolverCalls, 1);

  const literal = await resolveProbeTarget("127.0.0.1", {
    resolve: async () => {
      throw new Error("IP literals must not be sent to a resolver");
    },
  });
  assert.deepEqual(literal.addresses, [{ address: "127.0.0.1", family: 4, kind: "loopback" }]);

  await assert.rejects(
    resolveProbeTarget("metadata.test", {
      scope: "loopback",
      resolve: async () => [{ address: "169.254.169.254", family: 4 }],
    }),
    assertProbeError("UNSAFE_TARGET"),
  );
});

test("TCP probes connect only to a resolved-and-approved numeric address", async () => {
  const listener = await listen(net.createServer());
  try {
    const resolver: HostResolver = async hostname => {
      assert.equal(hostname, "dev-server.test");
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const result = await probeTcpPort("dev-server.test", listener.port, { scope: "loopback", resolve: resolver });
    assert.equal(result.open, true);
    assert.equal(result.host, "dev-server.test");
    assert.equal(result.port, listener.port);

    await assert.rejects(
      probeTcpPort("private.test", listener.port, {
        resolve: async () => [{ address: "10.0.0.10", family: 4 }],
      }),
      assertProbeError("UNSAFE_TARGET"),
    );
    await assert.rejects(probeTcpPort("127.0.0.1", 0), assertProbeError("INVALID_PORT"));
    await assert.rejects(probeTcpPort("127.0.0.1", 65_536), assertProbeError("INVALID_PORT"));
    await assert.rejects(probeTcpPort("127.0.0.1", 80.5), assertProbeError("INVALID_PORT"));
  } finally {
    await close(listener.server);
  }
});

test("HTTP probes do not follow redirects by default, and explicit redirects are revalidated and pinned", async () => {
  let targetHits = 0;
  const target = await listen(http.createServer((request, response) => {
    targetHits += 1;
    assert.equal(request.headers.host, `target.test:${target.port}`);
    response.writeHead(204, { "content-type": "text/plain" });
    response.end("ignored body");
  }));
  const source = await listen(http.createServer((request, response) => {
    assert.equal(request.headers.host, `source.test:${source.port}`);
    response.writeHead(302, { location: `http://target.test:${target.port}/ready?api_key=secret` });
    response.end("redirect body is not buffered");
  }));
  const resolver: HostResolver = async hostname => {
    assert.ok(hostname === "source.test" || hostname === "target.test");
    return [{ address: "127.0.0.1", family: 4 }];
  };

  try {
    const sourceUrl = `http://source.test:${source.port}/health?token=source-secret`;
    const manual = await probeHttpHealth(sourceUrl, { scope: "loopback", resolve: resolver });
    assert.equal(manual.status, 302);
    assert.equal(manual.redirects, 0);
    assert.equal(manual.final_url, "http://source.test:" + source.port + "/health?<redacted>");
    assert.equal(targetHits, 0);

    const followed = await probeHttpHealth(sourceUrl, { scope: "loopback", maxRedirects: 1, resolve: resolver });
    assert.equal(followed.status, 204);
    assert.equal(followed.redirects, 1);
    assert.equal(followed.final_url, `http://target.test:${target.port}/ready?<redacted>`);
    assert.equal(targetHits, 1);
  } finally {
    await close(source.server);
    await close(target.server);
  }
});

test("a redirect to an unsafe address is rejected before a connection is attempted", async () => {
  const source = await listen(http.createServer((_request, response) => {
    response.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    response.end();
  }));
  try {
    await assert.rejects(
      probeHttpHealth(`http://127.0.0.1:${source.port}/`, { scope: "loopback", maxRedirects: 1 }),
      assertProbeError("UNSAFE_TARGET"),
    );
  } finally {
    await close(source.server);
  }
});


test("probe failure-return contracts: refused, HTTP timeout, DNS failure, redirect limit", async () => {
  // Connection refused: bind a listener, close it, probe the now-free port.
  const temp = net.createServer();
  await listen(temp);
  const freedPort = (temp.address() as AddressInfo).port;
  await close(temp);
  const refused = await probeTcpPort("127.0.0.1", freedPort, { scope: "loopback", timeoutMs: 1500 });
  assert.equal(refused.open, false);
  assert.match(refused.error ?? "", /refused|connect/i, refused.error);

  // HTTP timeout: the server accepts and never answers.
  const silentSockets = new Set<net.Socket>();
  const silent = net.createServer(socket => { silentSockets.add(socket); socket.on("close", () => silentSockets.delete(socket)); });
  await listen(silent);
  try {
    const silentPort = (silent.address() as AddressInfo).port;
    const res = await probeHttpHealth(`http://127.0.0.1:${silentPort}/x`, { scope: "loopback", timeoutMs: 400 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.match(res.error ?? "", /timed out/i, res.error);
  } finally {
    // The probe deliberately left the connection open; destroy it so the
    // server's close() callback can fire instead of hanging the suite.
    for (const socket of silentSockets) socket.destroy();
    await close(silent);
  }

  // DNS failure surfaces as a probe failure, not an exception escape.
  const dns = await probeTcpPort("dns-broken.test", 80, {
    scope: "loopback",
    resolve: async () => { throw new Error("no such host"); },
  });
  assert.equal(dns.open, false);
  assert.match(dns.error ?? "", /DNS lookup failed/i, dns.error);

  // Redirect limit: a server redirecting to itself with maxRedirects 1.
  const loop = await listen(http.createServer((_req, res) => {
    res.writeHead(302, { location: "/again" });
    res.end();
  }));
  try {
    const loopPort = (loop.server.address() as AddressInfo).port;
    const hop = await probeHttpHealth(`http://127.0.0.1:${loopPort}/start`, { scope: "loopback", maxRedirects: 1 });
    assert.equal(hop.ok, false);
    assert.match(hop.error ?? "", /exceeded the redirect limit/i, hop.error);
  } finally {
    loop.server.closeAllConnections?.();
    await close(loop.server);
  }
});
