/**
 * Persistence for the OAuth 2.1 authorization server.
 *
 * ## Why this exists at all
 *
 * The standalone Bridge authenticates `/mcp` with a route token that lives in
 * the URL, which is exactly what a client that can only be given a URL needs.
 * OAuth adds one thing that a shared token cannot: **a credential issued per
 * client, individually revocable, without disturbing any other client.** That is
 * the whole return on this subsystem, and it is the standard MCP handshake, so
 * clients that insist on it can connect.
 *
 * ## What is stored, and what is not
 *
 * Secrets are hashed the same way `auth-core.ts` hashes personal tokens: sha256,
 * never the plaintext, compared in constant time. That applies to access tokens,
 * refresh tokens, and authorization codes. A leaked `oauth.json` therefore does
 * not hand anyone a working credential.
 *
 * Authorization codes are deliberately **in-memory only**. They live five
 * minutes by spec, and persisting them would add a durable artifact whose only
 * use is a replay window — losing them on restart is the safer failure.
 *
 * ## Refresh rotation
 *
 * A refresh token is single-use. `consumeRefreshToken` deletes the presented
 * refresh token and returns the grant it represented, in one synchronous step,
 * so a replayed token finds nothing and is refused. The new pair is written by
 * the caller. A crash between the two loses the grant (the client re-authorizes)
 * rather than admitting a replay — fail-closed, per the project's posture.
 *
 * This module is host-dependent (it writes through `SecretStore`), so unlike
 * `auth-core.ts` it cannot be exercised without a host; the pure decisions
 * (expiry, rotation bookkeeping) are kept separate and testable.
 */

import { createHash, randomBytes } from "node:crypto";
import { host } from "../host/host.js";

/** Secret store key holding the OAuth document. */
export const OAUTH_STORE_KEY = "openBridge.oauth";

/** Registered clients, keyed by client_id. */
export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
  client_id_issued_at: number;
}

export interface OAuthAccessToken {
  /** sha256 hex of the token. The token itself is never stored. */
  hash: string;
  client_id: string;
  scopes: string[];
  expiresAt: number;
  /** The RFC 8707 resource this token was issued for. */
  resource: string;
  revokedAt?: number;
}

export interface OAuthRefreshToken {
  hash: string;
  client_id: string;
  scopes: string[];
  expiresAt: number;
  resource: string;
}

export interface OAuthDocument {
  clients: OAuthClient[];
  accessTokens: OAuthAccessToken[];
  refreshTokens: OAuthRefreshToken[];
}

const EMPTY: OAuthDocument = { clients: [], accessTokens: [], refreshTokens: [] };

/** Access token lifetime. Short by design: a stolen token ages out quickly. */
export const ACCESS_TOKEN_TTL_MS = 3_600_000;
/** Refresh token lifetime: 30 days, long enough to be useful between sessions. */
export const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000;
/** Authorization code lifetime, per the spec's recommendation. */
export const AUTH_CODE_TTL_MS = 5 * 60_000;

/** The single scope this Bridge exposes. All tools, or nothing. */
export const OAUTH_SCOPE = "open-bridge";

export function hashOAuthSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A 256-bit opaque secret, prefixed so a leaked value is recognisable. */
export function generateOAuthSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/**
 * Constant-time digest comparison.
 *
 * A length mismatch is a plain false: `timingSafeEqual` throws on differing
 * lengths, and the length of a sha256 hex digest is not a secret.
 */
export function oauthDigestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseDocument(raw: unknown): OAuthDocument {
  if (typeof raw !== "string" || !raw) return { ...EMPTY };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY };
    const doc = parsed as Partial<OAuthDocument>;
    return {
      clients: Array.isArray(doc.clients) ? doc.clients.filter(isClient) : [],
      accessTokens: Array.isArray(doc.accessTokens) ? doc.accessTokens.filter(isAccessToken) : [],
      refreshTokens: Array.isArray(doc.refreshTokens) ? doc.refreshTokens.filter(isRefreshToken) : [],
    };
  } catch {
    // A corrupt store means "no clients authorized yet", never a crash: the
    // operator re-authorizes their client, which is a recoverable position.
    return { ...EMPTY };
  }
}

function isClient(value: unknown): value is OAuthClient {
  const candidate = value as OAuthClient;
  return !!candidate && typeof candidate.client_id === "string" && Array.isArray(candidate.redirect_uris);
}

function isAccessToken(value: unknown): value is OAuthAccessToken {
  const candidate = value as OAuthAccessToken;
  return !!candidate && typeof candidate.hash === "string" && typeof candidate.expiresAt === "number";
}

function isRefreshToken(value: unknown): value is OAuthRefreshToken {
  const candidate = value as OAuthRefreshToken;
  return !!candidate && typeof candidate.hash === "string" && typeof candidate.expiresAt === "number";
}

/**
 * Serialize all mutations through one tail so two concurrent authorizations
 * cannot interleave a read-modify-write and lose a client.
 */
let writeTail: Promise<void> = Promise.resolve();

async function readDocument(): Promise<OAuthDocument> {
  const secrets = host().secrets;
  if (!secrets) return { ...EMPTY };
  return parseDocument(await secrets.get(OAUTH_STORE_KEY));
}

/**
 * Run one read-transform-write cycle.
 *
 * The read happens inside the serialized tail, so each mutation sees the
 * previous one's result. This store is per-instance rather than shared across
 * processes the way the CLI-facing token store is: the OAuth endpoints only ever
 * run inside a serving Bridge, so there is no second writer to merge with.
 */
async function mutate<T>(transform: (doc: OAuthDocument) => { doc: OAuthDocument; result: T }): Promise<T> {
  const next = writeTail.then(async () => {
    const current = await readDocument();
    const { doc, result } = transform(current);
    await host().secrets.store(OAUTH_STORE_KEY, JSON.stringify(doc));
    return result;
  });
  writeTail = next.then(() => undefined, () => undefined);
  return next;
}

/** Drop expired tokens and revoked rows. Cheap, and keeps the document bounded. */
function pruneDocument(doc: OAuthDocument, now: number): OAuthDocument {
  return {
    clients: doc.clients,
    accessTokens: doc.accessTokens.filter(token => token.revokedAt === undefined && token.expiresAt > now),
    refreshTokens: doc.refreshTokens.filter(token => token.expiresAt > now),
  };
}

export async function findClient(clientId: string): Promise<OAuthClient | undefined> {
  const doc = await readDocument();
  return doc.clients.find(client => client.client_id === clientId);
}

export async function registerClient(client: OAuthClient): Promise<OAuthClient> {
  return mutate(doc => ({
    doc: { ...pruneDocument(doc, Date.now()), clients: [...doc.clients, client] },
    result: client,
  }));
}

/** Persist a freshly minted access/refresh pair, pruning on the way through. */
export async function saveTokenPair(tokens: {
  access: { hash: string; client_id: string; scopes: string[]; expiresAt: number; resource: string };
  refresh: { hash: string; client_id: string; scopes: string[]; expiresAt: number; resource: string };
}): Promise<void> {
  await mutate(doc => {
    const pruned = pruneDocument(doc, Date.now());
    return {
      doc: {
        clients: pruned.clients,
        accessTokens: [...pruned.accessTokens, tokens.access],
        refreshTokens: [...pruned.refreshTokens, tokens.refresh],
      },
      result: undefined,
    };
  });
}

/**
 * Consume a refresh token, returning its grant exactly once.
 *
 * The removal and the read are one synchronous step inside the serialized
 * mutation, so two concurrent presentations of the same token cannot both
 * succeed: the second finds nothing. Returns `undefined` for an unknown, expired
 * or already-consumed token — the caller answers `invalid_grant` for all three,
 * deliberately not distinguishing them.
 */
export async function consumeRefreshToken(
  presentedHash: string,
  now: number,
): Promise<OAuthRefreshToken | undefined> {
  return mutate(doc => {
    const pruned = pruneDocument(doc, now);
    const match = pruned.refreshTokens.find(token => oauthDigestEquals(token.hash, presentedHash));
    if (!match) {
      return { doc: pruned, result: undefined };
    }
    return {
      doc: { ...pruned, refreshTokens: pruned.refreshTokens.filter(token => token !== match) },
      result: match,
    };
  });
}

/** Verify a presented access token. Returns the grant, or undefined. */
export async function verifyAccessToken(
  presentedSecret: string,
  now: number,
): Promise<OAuthAccessToken | undefined> {
  const doc = await readDocument();
  const digest = hashOAuthSecret(presentedSecret);
  // Every candidate with the same digest is examined (no early exit), matching
  // auth-core's rule. In practice a digest collision means the same secret.
  let matched: OAuthAccessToken | undefined;
  for (const token of doc.accessTokens) {
    if (!oauthDigestEquals(token.hash, digest)) continue;
    if (token.revokedAt !== undefined) continue;
    if (token.expiresAt <= now) continue;
    matched ??= token;
  }
  return matched;
}

/** Revoke whatever the presented token is: an access token or a refresh token. */
export async function revokeToken(presentedSecret: string): Promise<boolean> {
  const digest = hashOAuthSecret(presentedSecret);
  return mutate(doc => {
    let found = false;
    const accessTokens = doc.accessTokens.map(token => {
      if (!oauthDigestEquals(token.hash, digest) || token.revokedAt !== undefined) return token;
      found = true;
      return { ...token, revokedAt: Date.now() };
    });
    const remainingRefresh = doc.refreshTokens.filter(token => {
      if (!oauthDigestEquals(token.hash, digest)) return true;
      found = true;
      return false;
    });
    return { doc: { ...doc, accessTokens, refreshTokens: remainingRefresh }, result: found };
  });
}

/** Public view of the registered clients, for the console. Never exposes hashes. */
export async function listClients(): Promise<Array<Pick<OAuthClient, "client_id" | "client_name" | "redirect_uris" | "client_id_issued_at">>> {
  const doc = await readDocument();
  return doc.clients.map(client => ({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    client_id_issued_at: client.client_id_issued_at,
  }));
}

/** Counts for the console: how many credentials are live right now. */
export async function oauthStatus(): Promise<{ clients: number; activeAccessTokens: number; activeRefreshTokens: number }> {
  const doc = await readDocument();
  const now = Date.now();
  return {
    clients: doc.clients.length,
    activeAccessTokens: doc.accessTokens.filter(token => token.revokedAt === undefined && token.expiresAt > now).length,
    activeRefreshTokens: doc.refreshTokens.filter(token => token.expiresAt > now).length,
  };
}
