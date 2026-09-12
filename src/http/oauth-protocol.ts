/**
 * The protocol decisions of the OAuth 2.1 authorization server, kept pure.
 *
 * Everything here is a function of its arguments: no host, no secret store, no
 * filesystem, no clock beyond a `now` the caller passes. That is deliberate —
 * these are the rules an attacker probes (PKCE verification, redirect matching,
 * resource binding, scope checks), and they must be testable without booting a
 * server, exactly like `auth-core.ts`.
 *
 * The corresponding *effects* (minting, persisting, rendering the consent page)
 * live in `oauth.ts`, which calls into these.
 *
 * Design notes worth stating explicitly:
 *
 *  - **PKCE is required, never optional.** MCP clients are public clients (they
 *    run on someone's laptop or in a browser), so a client secret proves
 *    nothing. `S256` only: the spec permits `plain`, and accepting it would let
 *    an attacker who observes the authorize request replay the code.
 *  - **Redirect URIs are matched exactly**, after the host allowlist has already
 *    been applied at registration. A prefix or loopback-port wildcard is how
 *    open-redirect bugs get introduced; there is no need for one here because
 *    the client tells us its exact callback up front.
 *  - **A code is bound to the client, the redirect URI, and the resource.** A
 *    code presented by a different client, or for a different resource, is
 *    refused even if it is otherwise valid — that binding is what stops a code
 *    intercepted from one flow being spent in another.
 */

import { createHash } from "node:crypto";

/** Hosts a dynamically registered client may point its callback at. */
export const DEFAULT_ALLOWED_REDIRECT_HOSTS: readonly string[] = Object.freeze([
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/** Loopback hosts are always permitted: a client running on this machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The two grant types this server supports. */
export const SUPPORTED_GRANT_TYPES: readonly string[] = Object.freeze(["authorization_code", "refresh_token"]);

/** Only the authorization-code flow. */
const SUPPORTED_RESPONSE_TYPES: readonly string[] = Object.freeze(["code"]);

/**
 * A redirect URI is acceptable when its host is explicitly allowed.
 *
 * The check is on the parsed host, not on a string prefix: `https://evil.com/?x=chatgpt.com`
 * contains an allowed host as a substring but is not one.
 */
export function isRedirectHostAllowed(redirectUri: string, allowedHosts: readonly string[] = DEFAULT_ALLOWED_REDIRECT_HOSTS): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  // A fragment is forbidden by the spec on a redirect URI, and an embedded
  // fragment is a common trick to smuggle a second parameter past naive readers.
  if (parsed.hash) return false;
  const host = parsed.host;
  const hostname = parsed.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname) || LOOPBACK_HOSTS.has(host)) return true;
  return allowedHosts.some(allowed => {
    const candidate = allowed.toLowerCase();
    return hostname === candidate || host === candidate;
  });
}

/** Every registered redirect URI must pass the host allowlist. */
export function areRedirectUrisAllowed(redirectUris: readonly string[], allowedHosts?: readonly string[]): boolean {
  if (redirectUris.length === 0) return false;
  return redirectUris.every(uri => isRedirectHostAllowed(uri, allowedHosts));
}

/**
 * Verify a PKCE `code_verifier` against the stored `code_challenge`.
 *
 * Only `S256` is accepted. A missing challenge, a missing verifier, or a
 * `plain` challenge all fail: this server never issues a code that could be
 * redeemed without proving possession of the verifier.
 *
 * Comparison is on the base64url-encoded digest. Both sides are already
 * fixed-length hex-free strings of the same width, and the digest is not a
 * secret, so an early-exit compare on it is safe; the *code* comparison against
 * the stored hash is the constant-time one.
 */
export function verifyPkceS256(codeVerifier: unknown, codeChallenge: unknown, method: unknown): boolean {
  if (typeof codeVerifier !== "string" || codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  if (typeof codeChallenge !== "string" || codeChallenge.length === 0) return false;
  // Reject `plain` (and anything else) outright rather than falling back to it.
  if (method !== "S256") return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) return false;
  const computed = createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
  return computed === codeChallenge;
}

/**
 * Is this `resource` parameter the Bridge itself?
 *
 * RFC 8707: the client names the resource it wants a token for, and the server
 * must refuse anything else, or a token minted here could be replayed against
 * an unrelated service. The comparison canonicalizes a trailing slash and the
 * scheme/host case, which are the differences that actually appear in practice
 * when a client echoes back a URL it was given.
 */
export function resourceMatches(candidate: unknown, expected: readonly string[]): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const normalize = (value: string): string => {
    try {
      const parsed = new URL(value);
      parsed.hash = "";
      // A trailing slash on the origin is not a different resource.
      const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}`;
    } catch {
      return value.replace(/\/+$/, "");
    }
  };
  const wanted = normalize(candidate);
  return expected.some(value => normalize(value) === wanted);
}

/**
 * Which of the requested scopes may be granted.
 *
 * The Bridge exposes exactly one scope; an unrecognised scope is refused rather
 * than silently dropped, so a client cannot believe it received something it did
 * not. An empty request grants the single supported scope, because a client that
 * omits `scope` is asking for the default.
 */
export function resolveScopes(requested: unknown, supported: readonly string[]): { ok: true; scopes: string[] } | { ok: false; scope: string } {
  const list = typeof requested === "string" && requested.trim()
    ? requested.trim().split(/\s+/)
    : [...supported];
  for (const scope of list) {
    if (!supported.includes(scope)) return { ok: false, scope };
  }
  // De-duplicate while preserving the client's order.
  return { ok: true, scopes: [...new Set(list)] };
}

/** The `WWW-Authenticate` challenge for a request that needs a token. */
export function bearerChallenge(resourceMetadataUrl: string, error?: "invalid_token" | "insufficient_scope"): string {
  const parts = ['Bearer realm="open-bridge"'];
  if (error) parts.push(`error="${error}"`);
  parts.push(`resource_metadata="${resourceMetadataUrl}"`);
  return parts.join(", ");
}

/**
 * RFC 9728 Protected Resource Metadata for this Bridge.
 *
 * `authorization_servers` points at the Bridge's own origin: it is both the
 * resource server and the authorization server, which the spec allows and which
 * keeps the whole flow on one host.
 */
export function protectedResourceMetadata(resource: string, scopesSupported: readonly string[]) {
  return {
    resource,
    authorization_servers: [new URL(resource).origin],
    scopes_supported: [...scopesSupported],
    bearer_methods_supported: ["header"],
  };
}

/**
 * RFC 8414 Authorization Server Metadata.
 *
 * `token_endpoint_auth_methods_supported` advertises `none`, which is what makes
 * a public client (no secret) able to use this server at all — and is why PKCE
 * is mandatory rather than optional.
 */
export function authorizationServerMetadata(issuer: string, scopesSupported: readonly string[]) {
  const base = issuer.replace(/\/+$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: [...scopesSupported],
    response_types_supported: [...SUPPORTED_RESPONSE_TYPES],
    grant_types_supported: [...SUPPORTED_GRANT_TYPES],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** HTML-escape for the consent page: client-supplied values are interpolated. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
