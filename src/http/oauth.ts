/**
 * The OAuth 2.1 authorization server, mounted on the Bridge's own `node:http`
 * server. No Express, no router framework — the endpoints are matched here.
 *
 * ## Why the Bridge runs its own authorization server
 *
 * The route token in `/mcp/<token>` already authenticates a client that can only
 * be handed a URL. What it cannot do is **hand one client its own credential**,
 * revocable without disturbing any other client, and it is not the handshake the
 * MCP spec describes. Running an AS on the same origin as the AS metadata says
 * it is keeps the whole flow on one host and needs no third-party identity
 * provider — appropriate for a tool the operator runs on their own machine.
 *
 * ## Endpoints
 *
 * | Path | Purpose |
 * | --- | --- |
 * | `/.well-known/oauth-protected-resource[/…]` | RFC 9728 metadata (resource server) |
 * | `/.well-known/oauth-authorization-server` | RFC 8414 metadata (authorization server) |
 * | `/oauth/register` | RFC 7591 dynamic client registration |
 * | `/oauth/authorize` | consent page (GET) and consent submission (POST) |
 * | `/oauth/token` | authorization-code + refresh-token exchange |
 * | `/oauth/revoke` | RFC 7009 revocation |
 *
 * ## The consent credential
 *
 * Approving a client requires proving the operator is the one at the browser.
 * The credential is the **route token** — the same secret already used to open
 * the console. That choice is deliberate:
 *
 *  - it is already a proven operator credential, so no new secret has to be
 *    invented, delivered or remembered;
 *  - the per-client benefit of this whole subsystem is preserved, because the
 *    tokens that get minted are per-client and individually revocable. The shared
 *    secret authenticates the *human approving*, not the client;
 *  - `OPEN_BRIDGE_OAUTH_OWNER` overrides it for an operator who would rather not
 *    type the route token into a browser on a machine with a screen recorder.
 *
 * Brute force is bounded by the same failure limiter the bearer gate uses.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { host } from "../host/host.js";
import { record, state } from "../bridge/state.js";
import {
  AUTH_CODE_TTL_MS,
  ACCESS_TOKEN_TTL_MS,
  OAUTH_SCOPE,
  REFRESH_TOKEN_TTL_MS,
  consumeRefreshToken,
  findClient,
  generateOAuthSecret,
  hashOAuthSecret,
  listClients,
  oauthStatus,
  registerClient,
  revokeToken,
  saveTokenPair,
  verifyAccessToken,
  type OAuthClient,
} from "./oauth-store.js";
import {
  DEFAULT_ALLOWED_REDIRECT_HOSTS,
  areRedirectUrisAllowed,
  authorizationServerMetadata,
  bearerChallenge,
  escapeHtml,
  protectedResourceMetadata,
  resolveScopes,
  resourceMatches,
  verifyPkceS256,
} from "./oauth-protocol.js";
import { AuthFailureLimiter, digestEquals } from "./auth-core.js";

/** Path prefix for the endpoints this module owns. */
const OAUTH_PREFIX = "/oauth/";
const WELL_KNOWN_PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";
const WELL_KNOWN_AUTHORIZATION_SERVER = "/.well-known/oauth-authorization-server";

/** The scopes this Bridge exposes. All tools, or nothing. */
const SUPPORTED_SCOPES: readonly string[] = Object.freeze([OAUTH_SCOPE]);

/** Body cap for OAuth form posts: these are small by construction. */
const MAX_OAUTH_BODY_BYTES = 64 * 1024;

export function oauthEnabled(): boolean {
  return host().config.get<boolean>("oauth.enabled", false) === true;
}

/** Hosts a client may register as its callback target. */
function allowedRedirectHosts(): readonly string[] {
  const configured = host().config.get<unknown>("oauth.allowedRedirectHosts", []);
  if (Array.isArray(configured) && configured.every(entry => typeof entry === "string") && configured.length > 0) {
    return configured as string[];
  }
  return DEFAULT_ALLOWED_REDIRECT_HOSTS;
}

/**
 * The issuer: the public origin when the Bridge is exposed, otherwise loopback.
 *
 * Derived per request rather than cached, because a tunnel can come up or go
 * down while the server runs and a stale issuer would make discovery point at a
 * host that no longer answers.
 */
function oauthIssuer(): string {
  const publicUrl = state.tunnelUrl;
  if (publicUrl) {
    try {
      return new URL(publicUrl).origin;
    } catch {
      // Fall through to loopback: a malformed tunnel URL must not break discovery.
    }
  }
  return state.port ? `http://127.0.0.1:${state.port}` : `http://127.0.0.1`;
}

/** The `resource` value this Bridge expects a token to be bound to. */
function oauthResource(): string {
  return `${oauthIssuer()}/mcp/${state.routeToken}`;
}

/** RFC 9728 says the well-known path has the resource's path appended. */
function protectedResourceMetadataUrl(): string {
  const resourcePath = new URL(oauthResource()).pathname;
  return `${oauthIssuer()}${WELL_KNOWN_PROTECTED_RESOURCE}${resourcePath}`;
}

/**
 * Authorization codes, in memory only.
 *
 * Five-minute lifetime, and losing them on restart costs a client one
 * re-authorization — much better than persisting a replay window.
 */
interface PendingCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

const pendingCodes = new Map<string, PendingCode>();

function pruneCodes(now: number): void {
  for (const [code, entry] of pendingCodes) {
    if (entry.expiresAt <= now) pendingCodes.delete(code);
  }
}

/** Bounds consent-page guessing. Separate from the bearer gate's limiter. */
const ownerLimiter = new AuthFailureLimiter();

// ---------------------------------------------------------------------------
// Small HTTP helpers (kept local: nothing here belongs in the app-shell path)
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // Discovery and token requests are made cross-origin by the client's
    // redirect handler, so these endpoints must be reachable from a browser.
    "access-control-allow-origin": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

/** An OAuth error response, per RFC 6749 §5.2. */
function oauthError(res: ServerResponse, status: number, error: string, description?: string): void {
  json(res, status, description ? { error, error_description: description } : { error });
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    // The consent page renders operator-supplied and client-supplied text.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit = MAX_OAUTH_BODY_BYTES): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > limit) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse an `application/x-www-form-urlencoded` body, or a JSON query for GET. */
function parseForm(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params) result[key] = value;
  return result;
}

// ---------------------------------------------------------------------------
// The owner credential
// ---------------------------------------------------------------------------

/** The operator secret that approves a client. Env override, else route token. */
function ownerCredential(): string {
  const fromEnv = process.env.OPEN_BRIDGE_OAUTH_OWNER;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return state.routeToken;
}

/** Constant-time comparison of the submitted consent credential. */
function ownerMatches(submitted: unknown): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const expected = ownerCredential();
  if (!expected) return false;
  // Hash both sides so the comparison width is independent of the input length.
  return digestEquals(hashOAuthSecret(submitted), hashOAuthSecret(expected));
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

function handleMetadata(url: URL, res: ServerResponse): boolean {
  const issuer = oauthIssuer();
  if (url.pathname === WELL_KNOWN_AUTHORIZATION_SERVER) {
    // `authorizationServerMetadata` asserts the issuer; a mismatch would make a
    // strict client refuse the document, so the check happens at build time.
    json(res, 200, authorizationServerMetadata(issuer, SUPPORTED_SCOPES));
    return true;
  }
  if (url.pathname === WELL_KNOWN_PROTECTED_RESOURCE || url.pathname.startsWith(`${WELL_KNOWN_PROTECTED_RESOURCE}/`)) {
    json(res, 200, protectedResourceMetadata(oauthResource(), SUPPORTED_SCOPES));
    return true;
  }
  return false;
}

/** RFC 7591 dynamic client registration. */
async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readBody(req);
  if (body === undefined) {
    oauthError(res, 413, "invalid_client_metadata", "Registration body is too large.");
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    oauthError(res, 400, "invalid_client_metadata", "Registration body is not JSON.");
    return true;
  }
  const metadata = (parsed ?? {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((value): value is string => typeof value === "string")
    : [];

  // Every callback must clear the host allowlist, and there must be at least
  // one: an open registration endpoint plus a wildcard redirect is the classic
  // way an attacker gets a code delivered to themselves.
  if (!areRedirectUrisAllowed(redirectUris, allowedRedirectHosts())) {
    oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be non-empty and point at an allowed host.");
    return true;
  }

  const client: OAuthClient = {
    client_id: `ob-${generateOAuthSecret("").replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`,
    ...(typeof metadata.client_name === "string" && metadata.client_name.trim()
      ? { client_name: metadata.client_name.trim().slice(0, 200) }
      : {}),
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
  await registerClient(client);
  record("oauth", "progress", `Registered OAuth client ${client.client_id}.`);
  json(res, 201, client);
  return true;
}

/** The consent page shown before a client is authorized. */
function consentPage(params: Record<string, string>, client: OAuthClient, error?: string): string {
  const hidden = [
    "response_type", "client_id", "redirect_uri", "code_challenge",
    "code_challenge_method", "scope", "state", "resource",
  ].map(name => `<input type="hidden" name="${name}" value="${escapeHtml(params[name] ?? "")}">`).join("\n      ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 Open Bridge</title>
<style>
 body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:34rem;margin:10vh auto;padding:0 1.25rem;color:#111}
 h1{font-size:1.15rem;margin:0 0 .25rem}
 .who{color:#555;margin:0 0 1.25rem}
 dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem .9rem;margin:0 0 1.25rem;font-size:.9rem}
 dt{color:#666}
 dd{margin:0;word-break:break-all}
 .warn{background:#fff6e5;border:1px solid #f0d18a;border-radius:8px;padding:.75rem .9rem;margin:0 0 1.25rem;font-size:.9rem}
 label{display:block;margin:0 0 .4rem;font-weight:600}
 input[type=password]{width:100%;padding:.6rem .7rem;border:1px solid #bbb;border-radius:8px;font:inherit}
 button{margin-top:1rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#111;color:#fff;font:inherit;font-weight:600;cursor:pointer}
 .err{color:#b00020;margin:.75rem 0 0}
</style>
</head>
<body>
  <h1>授权 Open Bridge</h1>
  <p class="who">${escapeHtml(client.client_name ?? client.client_id)} 请求访问这台机器上的工作区。</p>
  <dl>
    <dt>客户端</dt><dd>${escapeHtml(client.client_id)}</dd>
    <dt>权限</dt><dd>${escapeHtml(params.scope || OAUTH_SCOPE)}</dd>
    <dt>资源</dt><dd>${escapeHtml(params.resource ?? "")}</dd>
    <dt>回调</dt><dd>${escapeHtml(params.redirect_uri ?? "")}</dd>
  </dl>
  <p class="warn">授权后，该客户端可以读写此工作区的文件、执行命令并管理进程——与你自己在本机操作同级。只授权你信任的客户端。</p>
  <form method="post" action="/oauth/authorize">
      ${hidden}
    <label for="owner">操作员口令（即控制台的路由令牌）</label>
    <input id="owner" name="owner_token" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">授权</button>
  </form>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
</body>
</html>`;
}

/** GET /oauth/authorize — validate the request, then render consent. */
async function handleAuthorizeGet(url: URL, res: ServerResponse): Promise<boolean> {
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) params[key] = value;

  const clientId = params.client_id ?? "";
  const client = clientId ? await findClient(clientId) : undefined;
  if (!client) {
    oauthError(res, 400, "invalid_request", "Unknown client_id. Register the client first.");
    return true;
  }
  // The redirect URI must be one this client actually registered, matched
  // exactly. Missing this is the open-redirect bug.
  if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri)) {
    oauthError(res, 400, "invalid_request", "redirect_uri does not match a registered value for this client.");
    return true;
  }
  if (params.response_type !== "code") {
    redirectWithError(res, params.redirect_uri, params.state, "unsupported_response_type");
    return true;
  }
  if (params.code_challenge_method !== "S256" || !params.code_challenge) {
    // PKCE is required; a `plain` challenge is refused rather than downgraded.
    redirectWithError(res, params.redirect_uri, params.state, "invalid_request", "PKCE with code_challenge_method=S256 is required.");
    return true;
  }
  // The resource must be this Bridge, so a token minted here cannot be replayed
  // against another service (RFC 8707).
  if (!resourceMatches(params.resource, [oauthResource()])) {
    redirectWithError(res, params.redirect_uri, params.state, "invalid_target", "Invalid or missing resource parameter.");
    return true;
  }
  const scopeVerdict = resolveScopes(params.scope, SUPPORTED_SCOPES);
  if (!scopeVerdict.ok) {
    // Once the redirect URI is known-good, the spec requires errors to travel
    // back to the client's callback rather than being answered here: only that
    // way does the client learn its request failed instead of hanging.
    redirectWithError(res, params.redirect_uri, params.state, "invalid_scope", `Unsupported scope: ${scopeVerdict.scope}`);
    return true;
  }

  html(res, 200, consentPage(params, client));
  return true;
}

/** Bounce an error back to the client's callback, as the spec requires. */
function redirectWithError(res: ServerResponse, redirectUri: string, stateValue: string | undefined, error: string, description?: string): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (description) target.searchParams.set("error_description", description);
  if (stateValue) target.searchParams.set("state", stateValue);
  res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
  res.end();
}

/** POST /oauth/authorize — check the owner credential, then issue a code. */
async function handleAuthorizePost(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readBody(req);
  if (body === undefined) {
    oauthError(res, 413, "invalid_request", "Consent body is too large.");
    return true;
  }
  const params = parseForm(body);
  const client = params.client_id ? await findClient(params.client_id) : undefined;
  if (!client) {
    oauthError(res, 400, "invalid_request", "Unknown client_id.");
    return true;
  }
  if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri)) {
    oauthError(res, 400, "invalid_request", "redirect_uri does not match a registered value for this client.");
    return true;
  }

  // Rate-limit the credential itself, keyed by the caller, so a wrong password
  // cannot be ground down. Reuses the bearer gate's limiter shape.
  const key = typeof req.socket?.remoteAddress === "string" ? req.socket.remoteAddress : "unknown";
  const now = Date.now();
  const lockedFor = ownerLimiter.lockoutRemaining(key, now);
  if (lockedFor > 0) {
    html(res, 429, consentPage(params, client, "尝试过于频繁，请稍后再试。"));
    return true;
  }
  if (!ownerMatches(params.owner_token)) {
    ownerLimiter.recordFailure(key, now);
    record("oauth", "warning", `Rejected a consent attempt for client ${client.client_id}.`);
    // Re-render the form with the error rather than a bare 401, so the operator
    // can simply retype instead of going back and restarting the flow.
    html(res, 401, consentPage(params, client, "口令不正确。"));
    return true;
  }
  ownerLimiter.recordSuccess(key);

  if (params.response_type !== "code"
    || params.code_challenge_method !== "S256"
    || !params.code_challenge) {
    redirectWithError(res, params.redirect_uri, params.state, "invalid_request", "PKCE with code_challenge_method=S256 is required.");
    return true;
  }
  // Checked separately so the client is told which parameter was wrong. The
  // consent form re-carries the resource in a hidden field, so this only fires
  // when the original request was already wrong — but a wrong answer here would
  // send the operator chasing PKCE for a resource problem.
  if (!resourceMatches(params.resource, [oauthResource()])) {
    redirectWithError(res, params.redirect_uri, params.state, "invalid_target", "Invalid or missing resource parameter.");
    return true;
  }
  const scopeVerdict = resolveScopes(params.scope, SUPPORTED_SCOPES);
  if (!scopeVerdict.ok) {
    // Same rule as every other post-validation error: the redirect URI is
    // known-good by now, so the failure travels back to the client's callback.
    redirectWithError(res, params.redirect_uri, params.state, "invalid_scope", `Unsupported scope: ${scopeVerdict.scope}`);
    return true;
  }

  pruneCodes(now);
  const code = generateOAuthSecret("obc_");
  pendingCodes.set(code, {
    code,
    clientId: client.client_id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    scopes: scopeVerdict.scopes,
    resource: params.resource ?? oauthResource(),
    expiresAt: now + AUTH_CODE_TTL_MS,
  });
  record("oauth", "progress", `Authorized OAuth client ${client.client_id}.`);

  const target = new URL(params.redirect_uri);
  target.searchParams.set("code", code);
  if (params.state) target.searchParams.set("state", params.state);
  res.writeHead(302, { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end();
  return true;
}

/** POST /oauth/token — the authorization-code and refresh-token grants. */
async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readBody(req);
  if (body === undefined) {
    oauthError(res, 413, "invalid_request", "Token body is too large.");
    return true;
  }
  const params = parseForm(body);
  const grantType = params.grant_type ?? "";
  const clientId = params.client_id ?? "";
  const client = clientId ? await findClient(clientId) : undefined;
  if (!client) {
    // `invalid_client` is the spec's answer for an unknown public client too.
    oauthError(res, 401, "invalid_client", "Unknown client_id.");
    return true;
  }

  if (grantType === "authorization_code") return handleAuthorizationCode(params, client, res);
  if (grantType === "refresh_token") return handleRefreshGrant(params, client, res);
  oauthError(res, 400, "unsupported_grant_type", `Unsupported grant_type: ${grantType || "(missing)"}`);
  return true;
}

async function handleAuthorizationCode(params: Record<string, string>, client: OAuthClient, res: ServerResponse): Promise<boolean> {
  const now = Date.now();
  pruneCodes(now);
  const code = params.code ?? "";
  const entry = code ? pendingCodes.get(code) : undefined;
  if (!entry) {
    // Unknown, expired, or already spent all answer the same way.
    oauthError(res, 400, "invalid_grant", "The authorization code is invalid, expired, or already used.");
    return true;
  }
  // Single-use: consume before any other check, so a failed attempt cannot be
  // retried with a corrected verifier against the same code.
  pendingCodes.delete(code);

  // The code is bound to the client, the redirect URI and the resource. A
  // mismatch means the code was intercepted from a different flow.
  if (entry.clientId !== client.client_id
    || entry.redirectUri !== (params.redirect_uri ?? "")
    || !resourceMatches(params.resource ?? entry.resource, [entry.resource])
    || !resourceMatches(entry.resource, [oauthResource()])) {
    oauthError(res, 400, "invalid_grant", "The authorization code does not match this client, redirect_uri or resource.");
    return true;
  }
  if (entry.expiresAt <= now) {
    oauthError(res, 400, "invalid_grant", "The authorization code has expired.");
    return true;
  }
  if (!verifyPkceS256(params.code_verifier, entry.codeChallenge, "S256")) {
    oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
    return true;
  }
  return issueTokens(client, entry.scopes, entry.resource, res, now);
}

async function handleRefreshGrant(params: Record<string, string>, client: OAuthClient, res: ServerResponse): Promise<boolean> {
  const now = Date.now();
  const presented = params.refresh_token ?? "";
  if (!presented) {
    oauthError(res, 400, "invalid_request", "refresh_token is required.");
    return true;
  }
  // Consumption is the rotation: the presented token is deleted in the same
  // step that reads it, so a replay finds nothing and is refused.
  const grant = await consumeRefreshToken(hashOAuthSecret(presented), now);
  if (!grant) {
    oauthError(res, 400, "invalid_grant", "The refresh token is invalid, expired, or already used.");
    return true;
  }
  if (grant.client_id !== client.client_id) {
    oauthError(res, 400, "invalid_grant", "The refresh token was not issued to this client.");
    return true;
  }
  if (!resourceMatches(params.resource ?? grant.resource, [grant.resource])
    || !resourceMatches(grant.resource, [oauthResource()])) {
    oauthError(res, 400, "invalid_grant", "The refresh token is bound to a different resource.");
    return true;
  }
  return issueTokens(client, grant.scopes, grant.resource, res, now);
}

/** Mint an access/refresh pair. The one place secrets are created. */
async function issueTokens(
  client: OAuthClient,
  scopes: string[],
  resource: string,
  res: ServerResponse,
  now: number,
): Promise<boolean> {
  const accessToken = generateOAuthSecret("oba_");
  const refreshToken = generateOAuthSecret("obr_");
  await saveTokenPair({
    access: {
      hash: hashOAuthSecret(accessToken),
      client_id: client.client_id,
      scopes,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      resource,
    },
    refresh: {
      hash: hashOAuthSecret(refreshToken),
      client_id: client.client_id,
      scopes,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      resource,
    },
  });
  json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });
  return true;
}

/** POST /oauth/revoke — RFC 7009. Always 200, per the spec, even for a miss. */
async function handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const body = await readBody(req);
  if (body === undefined) {
    oauthError(res, 413, "invalid_request", "Revocation body is too large.");
    return true;
  }
  const params = parseForm(body);
  const token = params.token ?? "";
  // An unknown token is not an error: reporting one would let a caller probe
  // which tokens exist.
  if (token) {
    const revoked = await revokeToken(token);
    if (revoked) record("oauth", "progress", "Revoked an OAuth credential.");
  }
  json(res, 200, {});
  return true;
}

/**
 * Route one request. Returns true when this module answered it.
 *
 * Mounted from the server's extra-route hook, so it is consulted before the MCP
 * endpoint and the 404 — and only for the paths it owns.
 */
export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!oauthEnabled()) return false;

  const method = (req.method ?? "GET").toUpperCase();
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
    });
    res.end();
    return true;
  }

  // Discovery documents are read-only and unauthenticated by design: a client
  // must be able to find the authorization server before it has a token.
  if (method === "GET" && handleMetadata(url, res)) return true;

  if (!url.pathname.startsWith(OAUTH_PREFIX)) return false;

  try {
    switch (`${method} ${url.pathname}`) {
      case "POST /oauth/register":
        return await handleRegister(req, res);
      case "GET /oauth/authorize":
        return await handleAuthorizeGet(url, res);
      case "POST /oauth/authorize":
        return await handleAuthorizePost(req, res);
      case "POST /oauth/token":
        return await handleToken(req, res);
      case "POST /oauth/revoke":
        return await handleRevoke(req, res);
      default:
        oauthError(res, 404, "not_found", `No OAuth endpoint at ${method} ${url.pathname}.`);
        return true;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    record("oauth", "error", `OAuth endpoint failed: ${message}`);
    if (!res.headersSent) oauthError(res, 500, "server_error", "The authorization server could not complete the request.");
    else if (!res.writableEnded) res.end();
    return true;
  }
}

/**
 * Verify a bearer token presented on `/mcp`. Returns the client id on success.
 *
 * Separate from the personal-token gate in `auth.ts`: both may be enabled, and a
 * request is admitted if either accepts it.
 */
export async function verifyOAuthBearer(presented: unknown): Promise<{ ok: true; clientId: string } | { ok: false }> {
  if (typeof presented !== "string" || !presented) return { ok: false };
  const grant = await verifyAccessToken(presented, Date.now());
  if (!grant) return { ok: false };
  // The token must have been issued for this resource, not merely be valid.
  return resourceMatches(grant.resource, [oauthResource()])
    ? { ok: true, clientId: grant.client_id }
    : { ok: false };
}

/** The challenge a 401 must carry so a client can discover how to authenticate. */
export function oauthChallenge(error?: "invalid_token" | "insufficient_scope"): string {
  return bearerChallenge(protectedResourceMetadataUrl(), error);
}

/** Console surface: which clients are registered and how many credentials live. */
export async function oauthConsoleView(): Promise<{
  enabled: boolean;
  issuer: string;
  clients: Awaited<ReturnType<typeof listClients>>;
  counts: Awaited<ReturnType<typeof oauthStatus>>;
  ownerSource: "env" | "route_token";
}> {
  return {
    enabled: oauthEnabled(),
    issuer: oauthIssuer(),
    clients: await listClients(),
    counts: await oauthStatus(),
    ownerSource: process.env.OPEN_BRIDGE_OAUTH_OWNER ? "env" : "route_token",
  };
}
