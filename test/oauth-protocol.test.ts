import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  DEFAULT_ALLOWED_REDIRECT_HOSTS,
  SUPPORTED_GRANT_TYPES,
  authorizationServerMetadata,
  areRedirectUrisAllowed,
  bearerChallenge,
  escapeHtml,
  isRedirectHostAllowed,
  protectedResourceMetadata,
  resolveScopes,
  resourceMatches,
  verifyPkceS256,
} from "../src/http/oauth-protocol.js";

const SCOPES = ["open-bridge"];

/** The S256 challenge for a verifier, as a client computes it. */
const challengeFor = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

test("only S256 PKCE verifies, and only with the matching verifier", () => {
  const verifier = "a".repeat(64);
  const challenge = challengeFor(verifier);
  assert.equal(verifyPkceS256(verifier, challenge, "S256"), true);

  // The wrong verifier, the wrong challenge, and the wrong method all fail.
  assert.equal(verifyPkceS256("b".repeat(64), challenge, "S256"), false);
  assert.equal(verifyPkceS256(verifier, challengeFor("c".repeat(64)), "S256"), false);
  // `plain` is explicitly refused rather than downgraded to: accepting it would
  // let an attacker who saw the authorize request replay the code.
  assert.equal(verifyPkceS256(verifier, verifier, "plain"), false);
  assert.equal(verifyPkceS256(verifier, challenge, "plain"), false);
  assert.equal(verifyPkceS256(verifier, challenge, undefined), false);
  assert.equal(verifyPkceS256(verifier, challenge, "s256"), false);
});

test("PKCE refuses malformed verifiers rather than hashing whatever it is given", () => {
  const good = "a".repeat(64);
  const challenge = challengeFor(good);
  for (const bad of ["", "short", "a".repeat(42), "a".repeat(129), `has space${"a".repeat(50)}`, 42, null, undefined, {}]) {
    assert.equal(verifyPkceS256(bad, challenge, "S256"), false, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(verifyPkceS256(good, "", "S256"), false, "a missing stored challenge never matches");
  assert.equal(verifyPkceS256(good, undefined, "S256"), false);
});

test("a redirect host is matched on the parsed host, not on a substring", () => {
  assert.equal(isRedirectHostAllowed("https://chatgpt.com/connector_platform_oauth_redirect"), true);
  assert.equal(isRedirectHostAllowed("http://localhost:3000/callback"), true);
  assert.equal(isRedirectHostAllowed("http://127.0.0.1:8080/cb"), true);
  assert.equal(isRedirectHostAllowed("http://[::1]:9000/cb"), true);

  // The substring trick: an allowed host appearing inside a hostile URL.
  assert.equal(isRedirectHostAllowed("https://evil.com/?x=chatgpt.com"), false);
  assert.equal(isRedirectHostAllowed("https://chatgpt.com.evil.com/cb"), false);
  assert.equal(isRedirectHostAllowed("https://notchatgpt.com/cb"), false);
  assert.equal(isRedirectHostAllowed("https://evil.com#chatgpt.com"), false, "a fragment is refused");
  assert.equal(isRedirectHostAllowed("not a url"), false);
  assert.equal(isRedirectHostAllowed(""), false);
});

test("registration requires every redirect URI to pass, and at least one", () => {
  assert.equal(areRedirectUrisAllowed(["https://chatgpt.com/cb"]), true);
  assert.equal(areRedirectUrisAllowed(["https://chatgpt.com/cb", "http://localhost:1/cb"]), true);
  // One bad entry poisons the whole registration: a client cannot smuggle a
  // hostile callback in alongside a legitimate one.
  assert.equal(areRedirectUrisAllowed(["https://chatgpt.com/cb", "https://evil.com/cb"]), false);
  assert.equal(areRedirectUrisAllowed([]), false, "no callback means no registration");
  assert.equal(areRedirectUrisAllowed(["https://chatgpt.com/cb"], []), false, "an empty allowlist allows only loopback");
  assert.equal(areRedirectUrisAllowed(["http://localhost:1/cb"], []), true, "loopback survives an empty allowlist");
});

test("the default allowlist covers the known connector callback and loopback", () => {
  assert.ok(DEFAULT_ALLOWED_REDIRECT_HOSTS.includes("chatgpt.com"));
  for (const host of ["localhost", "127.0.0.1"]) {
    assert.ok(DEFAULT_ALLOWED_REDIRECT_HOSTS.includes(host));
  }
});

test("resource binding accepts only this Bridge, tolerating cosmetic differences", () => {
  const expected = ["https://bridge.example.com/mcp/abc123"];
  assert.equal(resourceMatches("https://bridge.example.com/mcp/abc123", expected), true);
  assert.equal(resourceMatches("https://bridge.example.com/mcp/abc123/", expected), true, "trailing slash is cosmetic");

  // A different host, a different path, and a different scheme are all refused:
  // otherwise a token minted here could be replayed against another service.
  assert.equal(resourceMatches("https://evil.example.com/mcp/abc123", expected), false);
  assert.equal(resourceMatches("https://bridge.example.com/mcp/other", expected), false);
  assert.equal(resourceMatches("http://bridge.example.com/mcp/abc123", expected), false);
  assert.equal(resourceMatches("", expected), false);
  assert.equal(resourceMatches(undefined, expected), false);
  assert.equal(resourceMatches(42, expected), false);
});

test("scopes are all-or-nothing: an unknown scope refuses the request", () => {
  assert.deepEqual(resolveScopes(undefined, SCOPES), { ok: true, scopes: SCOPES });
  assert.deepEqual(resolveScopes("", SCOPES), { ok: true, scopes: SCOPES });
  assert.deepEqual(resolveScopes("open-bridge", SCOPES), { ok: true, scopes: ["open-bridge"] });
  assert.deepEqual(resolveScopes("  open-bridge  ", SCOPES), { ok: true, scopes: ["open-bridge"] });
  // Asking for something unsupported is refused rather than silently trimmed, so
  // a client never believes it received a capability it did not.
  assert.deepEqual(resolveScopes("open-bridge admin", SCOPES), { ok: false, scope: "admin" });
  assert.deepEqual(resolveScopes("admin", SCOPES), { ok: false, scope: "admin" });
  assert.deepEqual(resolveScopes("open-bridge open-bridge", SCOPES), { ok: true, scopes: ["open-bridge"] }, "duplicates collapse");
});

test("the bearer challenge names the metadata document so a client can discover", () => {
  const challenge = bearerChallenge("https://bridge.example.com/.well-known/oauth-protected-resource/mcp/abc");
  assert.match(challenge, /^Bearer realm="open-bridge"/);
  assert.match(challenge, /resource_metadata="https:\/\/bridge\.example\.com\/\.well-known\/oauth-protected-resource\/mcp\/abc"/);
  assert.equal(challenge.includes("error="), false, "a plain challenge carries no error");

  const invalid = bearerChallenge("https://x/.well-known", "invalid_token");
  assert.match(invalid, /error="invalid_token"/);
  assert.match(invalid, /resource_metadata=/);
});

test("protected resource metadata points at this Bridge as its own authorization server", () => {
  const metadata = protectedResourceMetadata("https://bridge.example.com/mcp/abc", SCOPES);
  assert.equal(metadata.resource, "https://bridge.example.com/mcp/abc");
  assert.deepEqual(metadata.authorization_servers, ["https://bridge.example.com"]);
  assert.deepEqual(metadata.scopes_supported, SCOPES);
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
});

test("authorization server metadata advertises the endpoints and no-secret clients", () => {
  const metadata = authorizationServerMetadata("https://bridge.example.com", SCOPES);
  assert.equal(metadata.issuer, "https://bridge.example.com");
  assert.equal(metadata.authorization_endpoint, "https://bridge.example.com/oauth/authorize");
  assert.equal(metadata.token_endpoint, "https://bridge.example.com/oauth/token");
  assert.equal(metadata.registration_endpoint, "https://bridge.example.com/oauth/register");
  assert.equal(metadata.revocation_endpoint, "https://bridge.example.com/oauth/revoke");
  // `none` is what lets a public client (no secret) connect at all, and is the
  // reason PKCE is mandatory.
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.grant_types_supported, [...SUPPORTED_GRANT_TYPES]);
  assert.deepEqual(metadata.response_types_supported, ["code"]);
  // A trailing slash on the issuer must not produce a doubled separator.
  assert.equal(authorizationServerMetadata("https://x.example.com/", SCOPES).token_endpoint, "https://x.example.com/oauth/token");
});

test("client-supplied values are escaped before they reach the consent page", () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("it's"), "it&#39;s");
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
  // A closing tag injected through a client_name must not be able to break out.
  assert.equal(escapeHtml('</form><img src=x onerror=1>').includes("<"), false);
});
