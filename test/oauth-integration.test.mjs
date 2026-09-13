/**
 * OAuth 2.1 integration test: boots the real `open-bridge serve` process with
 * OAuth enabled and drives the complete authorization-code + PKCE flow over
 * HTTP, exactly as a remote MCP client does.
 *
 * The point of this suite is that OAuth is a *subsystem*, not a middleware
 * ordering: discovery must lead to registration, registration to consent,
 * consent to a code, the code to tokens, and the tokens to an authenticated
 * `tools/list`. A break anywhere in that chain leaves a client unable to
 * connect, and no unit test can see it.
 *
 * The negative cases matter as much as the happy path, because each one is a
 * real attack: a code replayed after use, a redirect URI that is not registered,
 * a `plain` PKCE challenge, an unknown scope, and a token bound to another
 * resource.
 */

import assert from "node:assert/strict";
import {test, before, after} from "node:test";
import {spawn} from "node:child_process";
import http from "node:http";
import {createHash} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {routeTokenFor, waitForRuntime} from "./lib/bridge-runtime.mjs";
import {setTimeout as delay} from "node:timers/promises";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

let home;
let child;
let port;
let routeToken;
/** The owner credential the consent page expects: the route token, by default. */
let ownerToken;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "ob-oauth-"));
  child = spawn(process.execPath, [
    path.join(ROOT, "bin", "open-bridge.js"),
    "serve", "--no-tunnel", "--port", "0", "--root", home, "--home", home,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const runtime = await waitForRuntime(home, home);
  port = runtime.port;
  for (let i = 0; i < 40 && !routeToken; i += 1) {
    try { routeToken = routeTokenFor(home, home); } catch { await delay(250); }
  }
  assert.ok(routeToken, "route token was persisted");
  ownerToken = routeToken;

  // Switch OAuth on through the same console action the settings page uses.
  // OAuth is off by default (like the bearer gate), so the flow below only
  // exists once an operator has opted in.
  const res = await rawRequest("POST", "/api/settings/action", JSON.stringify({
    command: "setConfig", key: "oauth.enabled", value: true,
  }), { "content-type": "application/json", "x-open-bridge-console": routeToken });
  assert.equal(res.status, 200, `enabling oauth failed: ${res.body}`);
  assert.equal(JSON.parse(res.body).ok, true, `enabling oauth failed: ${res.body}`);
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await delay(300);
  rmSync(home, { recursive: true, force: true });
});

function rawRequest(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers, agent: false, signal: AbortSignal.timeout(15_000) },
      res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const form = fields => new URLSearchParams(fields).toString();
const formHeaders = extra => ({ "content-type": "application/x-www-form-urlencoded", ...extra });
const pkce = verifier => createHash("sha256").update(verifier, "ascii").digest("base64url");
const VERIFIER = "v".repeat(64);
const REDIRECT = "http://localhost:8765/callback";

/** Register a client the way a remote MCP client does, returning its id. */
async function registerClient(redirectUris = [REDIRECT], clientName = "oauth-test") {
  const res = await rawRequest("POST", "/oauth/register", JSON.stringify({
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }), { "content-type": "application/json" });
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null, raw: res };
}

/** Run the consent form and return the redirect Location it produced. */
async function authorize(clientId, overrides = {}, headers = {}) {
  const fields = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: pkce(VERIFIER),
    code_challenge_method: "S256",
    scope: "open-bridge",
    state: "the-state",
    resource: `http://127.0.0.1:${port}/mcp/${routeToken}`,
    owner_token: ownerToken,
    ...overrides,
  };
  const res = await rawRequest("POST", "/oauth/authorize", form(fields), formHeaders(headers));
  return { status: res.status, location: res.headers.location, body: res.body };
}

/** Exchange an authorization code for tokens. */
async function token(fields) {
  const res = await rawRequest("POST", "/oauth/token", form(fields), formHeaders());
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

let rpcId = 1;
const rpc = (method, params) => ({ jsonrpc: "2.0", id: rpcId++, method, params: params ?? {} });

/** Open a 2025-era session with the OAuth token, exactly as a client would. */
async function openSessionWith(accessToken) {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "oauth-integration-test", version: "1" },
  })), {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
  });
  const sessionId = res.headers["mcp-session-id"];
  if (sessionId) {
    await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "mcp-session-id": sessionId,
    });
  }
  return { status: res.status, sessionId, body: res.body };
}

/** Handshake then list tools: the full path a real client takes. */
async function listToolsWith(accessToken) {
  const opened = await openSessionWith(accessToken);
  if (opened.status !== 200) return opened;
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("tools/list", {})), {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "mcp-session-id": opened.sessionId,
  });
  return { status: res.status, headers: res.headers, body: res.body };
}

test("discovery advertises the authorization server without a token", async () => {
  const prm = await rawRequest("GET", "/.well-known/oauth-protected-resource", null, {});
  assert.equal(prm.status, 200, "protected resource metadata is public");
  const metadata = JSON.parse(prm.body);
  assert.match(metadata.resource, /\/mcp$/);
  // The regression this pins: the discovery document is unauthenticated and
  // public, so the route token must never appear in it. It used to be the LAST
  // path segment of `resource`, and the same value is accepted as the consent
  // password — one anonymous GET handed an attacker both the token and the
  // approval credential, and the authorize -> code -> token -> run_command
  // chain followed from there.
  assert.equal(
    prm.body.includes(routeToken),
    false,
    "the protected-resource metadata must not disclose the route token",
  );
  assert.ok(Array.isArray(metadata.authorization_servers) && metadata.authorization_servers.length > 0);
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);

  const as = await rawRequest("GET", "/.well-known/oauth-authorization-server", null, {});
  assert.equal(as.status, 200, "authorization server metadata is public");
  const asMetadata = JSON.parse(as.body);
  assert.equal(asMetadata.issuer, `http://127.0.0.1:${port}`);
  assert.match(asMetadata.registration_endpoint, /\/oauth\/register$/);
  assert.match(asMetadata.token_endpoint, /\/oauth\/token$/);
  // A public client (no secret) must be able to use this server, which is only
  // safe because PKCE is mandatory.
  assert.deepEqual(asMetadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(asMetadata.code_challenge_methods_supported, ["S256"]);
});

test("an unauthenticated /mcp request carries the discovery challenge", async () => {
  const res = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("tools/list", {})), {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  assert.equal(res.status, 401);
  const challenge = res.headers["www-authenticate"] ?? "";
  assert.match(challenge, /^Bearer/);
  // The header, not the status code, is how an OAuth client finds the AS.
  assert.match(challenge, /resource_metadata="/);
  assert.match(challenge, /\.well-known\/oauth-protected-resource/);
});

test("registration refuses a redirect URI that is not an allowed host", async () => {
  const res = await registerClient(["https://evil.example.com/steal"]);
  assert.equal(res.status, 400);
  // Read the error off `body` (the parsed JSON); `raw` is the untouched response.
  assert.equal(res.body.error, "invalid_redirect_uri");

  // A hostile callback hidden alongside a legitimate one must poison the whole
  // registration rather than be quietly dropped.
  const mixed = await registerClient(["https://chatgpt.com/connector_platform_oauth_redirect", "https://evil.example.com/steal"]);
  assert.equal(mixed.status, 400);

  // And a substring that merely contains an allowed host is not an allowed host.
  const substring = await registerClient(["https://evil.example.com/?x=chatgpt.com"]);
  assert.equal(substring.status, 400);

  assert.equal((await registerClient([])).status, 400, "no callback means no registration");
});

test("the full authorization-code flow yields a token that authenticates /mcp", async () => {
  const registered = await registerClient();
  assert.equal(registered.status, 201, registered.raw.body);
  const clientId = registered.body.client_id;
  assert.match(clientId, /^ob-/);
  // A public client gets no secret; PKCE is what proves possession.
  assert.equal(registered.body.token_endpoint_auth_method, "none");

  const consent = await authorize(clientId);
  assert.equal(consent.status, 302, `consent should redirect, got ${consent.status}: ${consent.body.slice(0, 200)}`);
  const location = new URL(consent.location);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "the-state", "state is echoed back");
  const code = location.searchParams.get("code");
  assert.ok(code);

  const exchanged = await token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: `http://127.0.0.1:${port}/mcp/${routeToken}`,
  });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal(exchanged.body.token_type, "Bearer");
  assert.ok(exchanged.body.access_token);
  assert.ok(exchanged.body.refresh_token);
  assert.equal(exchanged.body.scope, "open-bridge");

  // The whole point: the minted token opens /mcp.
  const listed = await listToolsWith(exchanged.body.access_token);
  assert.equal(listed.status, 200, listed.body.slice(0, 300));
  assert.match(listed.body, /"tools"/);
});

test("an authorization code is single-use", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId);
  const code = new URL(consent.location).searchParams.get("code");

  const first = await token({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: VERIFIER,
    resource: `http://127.0.0.1:${port}/mcp/${routeToken}`,
  });
  assert.equal(first.status, 200);

  // Replaying the same code must fail even with everything else correct.
  const replay = await token({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: VERIFIER,
    resource: `http://127.0.0.1:${port}/mcp/${routeToken}`,
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");
});

test("a wrong PKCE verifier is refused, and consumes the code", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId);
  const code = new URL(consent.location).searchParams.get("code");

  const wrong = await token({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: "w".repeat(64),
    resource: `http://127.0.0.1:${port}/mcp/${routeToken}`,
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "invalid_grant");

  // The failed attempt must not leave the code usable with the right verifier.
  const retry = await token({
    grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: REDIRECT, code_verifier: VERIFIER,
    resource: `http://127.0.0.1:${port}/mcp/${routeToken}`,
  });
  assert.equal(retry.status, 400, "a code is consumed by the attempt, not by success");
});

test("a plain PKCE challenge is refused at the consent step", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId, { code_challenge_method: "plain", code_challenge: VERIFIER });
  // The error travels back to the client's callback, per the spec.
  assert.equal(consent.status, 302);
  const location = new URL(consent.location);
  assert.equal(location.searchParams.get("error"), "invalid_request");
  assert.match(location.searchParams.get("error_description") ?? "", /S256/);
  assert.equal(location.searchParams.has("code"), false);
});

test("an unregistered redirect_uri is refused rather than redirected to", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId, { redirect_uri: "https://evil.example.com/steal" });
  // This is an open-redirect guard: the server must not bounce the client to a
  // URI it never registered, so it answers directly instead of redirecting.
  assert.equal(consent.status, 400);
  assert.equal(JSON.parse(consent.body).error, "invalid_request");
  assert.equal(consent.location, undefined);
});

test("an unsupported scope is refused", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId, { scope: "open-bridge admin" });
  const location = new URL(consent.location);
  assert.equal(location.searchParams.get("error"), "invalid_scope");
});

test("a token for another resource is refused", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId, { resource: "https://other.example.com/mcp" });
  const location = new URL(consent.location);
  assert.equal(location.searchParams.get("error"), "invalid_target");
});

test("a wrong owner credential re-renders the form instead of authorizing", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId, { owner_token: "definitely-not-the-token" });
  // No redirect, no code: the operator simply retypes.
  assert.equal(consent.status, 401);
  assert.equal(consent.location, undefined);
  assert.match(consent.body, /口令不正确/);
});

test("failures from a forwarded client identity do not lock the operator out", async () => {
  // Behind the ngrok agent every request arrives from 127.0.0.1, so keying the
  // consent limiter on the SOCKET address let one anonymous attacker POST a few
  // wrong owner_tokens and lock the operator out of their own consent page —
  // the correct password then answered 429 too, and the attacker could re-trip
  // it every window. /oauth/authorize is public by design, so no credential was
  // needed. The limiter must key on the forwarded identity, exactly as the
  // bearer gate's limiter does.
  const clientId = (await registerClient()).body.client_id;
  const attacker = { "x-forwarded-for": "203.0.113.9" };

  // Five failures is the limiter's window; each is refused with the retry form.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await authorize(clientId, { owner_token: `wrong-${attempt}` }, attacker);
    assert.equal(res.status, 401, `attacker attempt ${attempt + 1} was refused, not granted`);
  }
  // The attacker is now locked out...
  const blocked = await authorize(clientId, { owner_token: "wrong-again" }, attacker);
  assert.equal(blocked.status, 429, "the attacker's own identity is rate-limited");

  // ...while the operator, whose forwarded address is different, still gets in.
  const operator = await authorize(clientId, {}, { "x-forwarded-for": "198.51.100.7" });
  assert.equal(
    operator.status,
    302,
    `the operator can still authorize from their own address: ${String(operator.body).slice(0, 200)}`,
  );
  assert.ok(operator.location, "and receives the authorization code redirect");
});

test("a refresh token rotates, and the old one stops working", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId);
  const code = new URL(consent.location).searchParams.get("code");
  const resource = `http://127.0.0.1:${port}/mcp/${routeToken}`;
  const initial = await token({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource });
  assert.equal(initial.status, 200);

  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: initial.body.refresh_token,
    client_id: clientId,
    resource,
  });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.ok(refreshed.body.access_token);
  assert.notEqual(refreshed.body.refresh_token, initial.body.refresh_token, "a new refresh token is issued");

  // Replaying the consumed refresh token must fail: this is the rotation.
  const replay = await token({
    grant_type: "refresh_token",
    refresh_token: initial.body.refresh_token,
    client_id: clientId,
    resource,
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");

  // The rotated access token still works.
  const listed = await listToolsWith(refreshed.body.access_token);
  assert.equal(listed.status, 200);
});

test("a revoked access token stops authenticating", async () => {
  const clientId = (await registerClient()).body.client_id;
  const consent = await authorize(clientId);
  const code = new URL(consent.location).searchParams.get("code");
  const resource = `http://127.0.0.1:${port}/mcp/${routeToken}`;
  const issued = await token({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource });
  assert.equal(issued.status, 200);
  assert.equal((await listToolsWith(issued.body.access_token)).status, 200);

  const revoked = await rawRequest("POST", "/oauth/revoke", form({ token: issued.body.access_token, client_id: clientId }), formHeaders());
  assert.equal(revoked.status, 200, "revocation always answers 200, per RFC 7009");
  assert.equal((await listToolsWith(issued.body.access_token)).status, 401);

  // Revoking an unknown token is not an error, so a caller cannot probe.
  const unknown = await rawRequest("POST", "/oauth/revoke", form({ token: "oba_not-a-real-token" }), formHeaders());
  assert.equal(unknown.status, 200);
});

/**
 * OAuth is additive for anything that presents a credential: the audit that
 * added this test found the opposite — with the personal gate still off (the
 * default), the OAuth rejection was returned before the presented token was
 * examined, so a client holding a perfectly good token died the moment an
 * operator switched OAuth on. That is precisely the "never disconnects a
 * client" promise README makes.
 */
test("a personal token still authenticates /mcp while OAuth is on", async () => {
  const secret = await mintPersonalToken("url-only");

  const viaHeader = await listToolsWith(secret);
  assert.equal(viaHeader.status, 200, viaHeader.body.slice(0, 300));

  // The query form is the only credential door a client that can be handed
  // nothing but a URL has — and the one the README points such clients at. It
  // carries a whole session, so the handshake goes through it too.
  const opened = await rawRequest("POST", `/mcp/${routeToken}?token=${secret}`, JSON.stringify(rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "url-only-client", version: "1" },
  })), {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  assert.equal(opened.status, 200, opened.body.slice(0, 300));
  const sessionId = opened.headers["mcp-session-id"];
  assert.ok(sessionId, "the query-credential session handshook");
  const listed = await rawRequest("POST", `/mcp/${routeToken}?token=${secret}`, JSON.stringify(rpc("tools/list", {})), {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": sessionId,
  });
  assert.equal(listed.status, 200, listed.body.slice(0, 300));
  assert.match(listed.body, /"tools"/);
});

test("with the personal gate on, both credential kinds are accepted", async () => {
  const secret = await mintPersonalToken("coexist");
  // registerClient takes a LIST of redirect URIs; passing the bare string
  // registered nothing, and the consent POST then had no client to authorize.
  const clientId = (await registerClient([REDIRECT], "coexist")).body.client_id;
  const consent = await authorize(clientId);
  const code = new URL(consent.location).searchParams.get("code");
  const exchanged = await token({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: `http://127.0.0.1:${port}/mcp/${routeToken}`,
  });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));

  const gate = async enabled => {
    const res = await rawRequest("POST", "/api/settings/action", JSON.stringify({
      command: "setAuthEnabled", enabled,
    }), { "content-type": "application/json", "x-open-bridge-console": routeToken });
    assert.equal(res.status, 200, `setAuthEnabled(${enabled}) failed: ${res.body}`);
  };

  await gate(true);
  try {
    assert.equal((await listToolsWith(secret)).status, 200, "the personal token still works");
    assert.equal((await listToolsWith(exchanged.body.access_token)).status, 200, "the OAuth token still works");
    const anonymous = await rawRequest("POST", `/mcp/${routeToken}`, JSON.stringify(rpc("tools/list", {})), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    assert.equal(anonymous.status, 401);
    // Both gates on: the challenge must still point at the authorization
    // server, otherwise an OAuth client has no way in.
    assert.match(anonymous.headers["www-authenticate"] ?? "", /resource_metadata=/);
  } finally {
    await gate(false);
  }
});

/** Mint a personal token through the same console action the page uses. */
async function mintPersonalToken(label) {
  const res = await rawRequest("POST", "/api/settings/action", JSON.stringify({
    command: "createToken", label, ttlSeconds: 0,
  }), { "content-type": "application/json", "x-open-bridge-console": routeToken });
  assert.equal(res.status, 200, `minting a token failed: ${res.body}`);
  const secret = JSON.parse(res.body)?.secret?.secret;
  assert.ok(secret, `no one-time secret in ${res.body.slice(0, 200)}`);
  return secret;
}

test("the console can read the OAuth client list without seeing any secret", async () => {
  const res = await rawRequest("GET", "/api/oauth", null, {});
  assert.equal(res.status, 200);
  const view = JSON.parse(res.body).oauth;
  assert.equal(view.enabled, true, "OAuth reports as enabled after the console action");
  assert.ok(Array.isArray(view.clients) && view.clients.length > 0);
  assert.ok(view.clients.every(client => client.client_id.startsWith("ob-")));
  assert.equal(view.ownerSource, "route_token", "the owner credential defaults to the route token");
  assert.ok(view.counts.clients > 0);
  // No hash or token material may appear anywhere in the console projection.
  assert.equal(/[a-f0-9]{64}/.test(res.body), false, "no digests are exposed");
  assert.equal(res.body.includes(ownerToken), false, "the owner credential never leaves the server");
});
