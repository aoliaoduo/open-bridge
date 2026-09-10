/**
 * Optional bearer-token gate for the MCP endpoint (orchestration layer).
 *
 * OFF by default: `openBridge.auth.enabled` defaults to false and every path in
 * this module short-circuits to "allowed" so existing installs keep working
 * unchanged. When enabled the gate runs after the Host allowlist and before the
 * route-token/peer handling, so an unauthenticated request never reaches the
 * MCP transport, the peer proxy, or the session table.
 *
 * Records live in VS Code `secrets` (encrypted at rest, never in settings or on
 * disk in the clear). The plaintext secret exists only in the mint response.
 */

import { host } from "../host/host.js";
import { record } from "../bridge/state.js";
import {
  AuthFailureLimiter,
  bearerFrom,
  expiryFrom,
  generateSecret,
  generateTokenId,
  hashSecret,
  isExpired,
  publicTokenView,
  remoteKeyOf,
  verifySecret,
  type AuthTokenRecord,
} from "./auth-core.js";
const AUTH_STORE_KEY = "openBridge.authTokens";
/** Success-path bookkeeping is written at most this often to avoid a secrets write per request. */
const LAST_USED_FLUSH_MS = 30_000;

const limiter = new AuthFailureLimiter();
let cache: AuthTokenRecord[] | undefined;
let lastFlushAt = 0;

export function authEnabled(): boolean {
  return host().config.get<boolean>("auth.enabled", false) === true;
}

/** Configured default lifetime for newly minted tokens; 0 / unset = permanent. */
export function tokenTtlSeconds(): number {
  const raw = host().config.get<number>("auth.tokenTtlSeconds", 0);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

async function readRecords(): Promise<AuthTokenRecord[]> {
  if (cache) return cache;
  const secrets = host().secrets;
  if (!secrets) return (cache = []);
  const raw = await secrets.get(AUTH_STORE_KEY);
  if (typeof raw !== "string" || !raw) return (cache = []);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return (cache = []);
    cache = parsed.filter((item): item is AuthTokenRecord =>
      !!item && typeof item === "object"
      && typeof (item as AuthTokenRecord).id === "string"
      && typeof (item as AuthTokenRecord).hash === "string");
  } catch {
    // Corrupt store: treat as empty rather than locking the operator out.
    cache = [];
  }
  return cache;
}

async function writeRecords(records: AuthTokenRecord[]): Promise<void> {
  cache = records;
  await host().secrets.store(AUTH_STORE_KEY, JSON.stringify(records));
  host().ui.update();
}

export interface MintedToken {
  id: string;
  label: string;
  /** Shown exactly once; never persisted. */
  secret: string;
  created_at: string;
  expires_at: string | null;
  permanent: boolean;
}

/** Mint a new token. `ttlSeconds` from the caller, else the configured default. */
export async function mintToken(options: { label?: string; ttlSeconds?: number | null } = {}): Promise<MintedToken> {
  const now = Date.now();
  const ttl = options.ttlSeconds === undefined ? tokenTtlSeconds() : options.ttlSeconds;
  const secret = generateSecret();
  const record: AuthTokenRecord = {
    id: generateTokenId(),
    label: (options.label ?? "").trim() || `token-${new Date(now).toISOString().slice(0, 10)}`,
    hash: hashSecret(secret),
    createdAt: now,
    expiresAt: expiryFrom(ttl, now),
    lastUsedAt: null,
    useCount: 0,
  };
  const records = [...(await readRecords()), record];
  await writeRecords(records);
  return {
    id: record.id,
    label: record.label,
    secret,
    created_at: new Date(record.createdAt).toISOString(),
    expires_at: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    permanent: record.expiresAt === null,
  };
}

export async function listTokenViews(): Promise<ReturnType<typeof publicTokenView>[]> {
  const now = Date.now();
  return (await readRecords()).map(record => publicTokenView(record, now));
}

/**
 * Revoke by id (exact) or by id prefix, so an operator can paste the first few
 * characters. Already-revoked tokens are left alone; unknown ids throw.
 */
export async function revokeToken(idOrPrefix: string): Promise<{ revoked: string[] }> {
  const needle = idOrPrefix.trim().toLowerCase();
  if (!needle) throw new Error("Provide a token id. Use openBridge.auth.manageTokens to list them.");
  const records = await readRecords();
  const hits = records.filter(record => record.revokedAt === undefined && record.id.toLowerCase().startsWith(needle));
  if (!hits.length) throw new Error(`No active token matches "${idOrPrefix}".`);
  const now = Date.now();
  const next = records.map(record => (hits.includes(record) ? { ...record, revokedAt: now } : record));
  await writeRecords(next);
  return { revoked: hits.map(record => record.id) };
}

/** Revoke every active token. Escape hatch for "I think a token leaked". */
export async function revokeAllTokens(): Promise<{ revoked: string[] }> {
  const now = Date.now();
  const records = await readRecords();
  const hits = records.filter(record => record.revokedAt === undefined);
  await writeRecords(records.map(record => (hits.includes(record) ? { ...record, revokedAt: now } : record)));
  return { revoked: hits.map(record => record.id) };
}

/**
 * Remove token records outright.
 *
 * Revoke keeps the record on purpose: the id stays attributable in the audit
 * trail, and a revoked token must never be re-usable. But that leaves the row
 * sitting in the panel forever with nothing left to do with it, so delete
 * exists for tidying. Deleting an ACTIVE token also revokes it, because the
 * record holding the hash is the only thing making it work.
 */
export async function deleteToken(idOrPrefix: string): Promise<{ deleted: string[] }> {
  const needle = idOrPrefix.trim().toLowerCase();
  if (!needle) throw new Error("Provide a token id. Token ids are listed on the Open Bridge settings page.");
  const records = await readRecords();
  const hits = records.filter(record => record.id.toLowerCase().startsWith(needle));
  if (!hits.length) throw new Error(`No token matches "${idOrPrefix}".`);
  await writeRecords(records.filter(record => !hits.includes(record)));
  return { deleted: hits.map(record => record.id) };
}

/** Delete every already-revoked or already-expired token in one step. */
export async function purgeInactiveTokens(): Promise<{ deleted: string[] }> {
  const now = Date.now();
  const records = await readRecords();
  const hits = records.filter(record => record.revokedAt !== undefined || isExpired(record, now));
  if (!hits.length) return { deleted: [] };
  await writeRecords(records.filter(record => !hits.includes(record)));
  return { deleted: hits.map(record => record.id) };
}

/** How many tokens could still authenticate a request right now. */
export async function usableTokenCount(): Promise<number> {
  const now = Date.now();
  return (await readRecords()).filter(record => record.revokedAt === undefined && !isExpired(record, now)).length;
}

/**
 * Replace a token's secret while keeping its id and history. The previous
 * secret stops working immediately; the new one inherits the current TTL
 * setting (so a rotation can also shorten or drop an expiry).
 */
export async function rotateToken(idOrPrefix: string): Promise<MintedToken> {
  const needle = idOrPrefix.trim().toLowerCase();
  const records = await readRecords();
  const target = records.find(record => record.id.toLowerCase().startsWith(needle));
  if (!target) throw new Error(`No token matches "${idOrPrefix}".`);
  const now = Date.now();
  const secret = generateSecret();
  const updated: AuthTokenRecord = {
    id: target.id,
    label: target.label,
    hash: hashSecret(secret),
    createdAt: target.createdAt,
    expiresAt: expiryFrom(tokenTtlSeconds(), now),
    lastUsedAt: null,
    useCount: 0,
  };
  await writeRecords(records.map(record => (record.id === target.id ? updated : record)));
  return {
    id: updated.id,
    label: updated.label,
    secret,
    created_at: new Date(updated.createdAt).toISOString(),
    expires_at: updated.expiresAt === null ? null : new Date(updated.expiresAt).toISOString(),
    permanent: updated.expiresAt === null,
  };
}

export type AuthGateResult =
  | { ok: true }
  | { ok: false; status: number; reason: string; retryAfterMs?: number };

/**
 * Gate one request. Returns { ok: true } when auth is disabled (the default).
 *
 * Fail-closed when auth is on but no usable token exists. Failing open here
 * would defeat the point of revoking the last token ("I think it leaked") — the
 * request would be admitted before its (revoked) credential was even checked.
 * Lockout is never unrecoverable anyway: the operator owns the machine and can
 * turn `openBridge.auth.enabled` off locally in VS Code settings.
 */
export async function authorizeRequest(
  req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } },
  url: URL,
): Promise<AuthGateResult> {
  if (!authEnabled()) return { ok: true };

  const now = Date.now();
  const records = await readRecords();
  if (!records.some(record => record.revokedAt === undefined && !isExpired(record, now))) {
    warnNoActiveToken();
    // Deliberately not counted as a failure: this is a configuration state, not
    // an attack, and the operator's own client must not get locked out while
    // they fix it.
    return { ok: false, status: 401, reason: "no_active_token" };
  }

  // Rate-limit on the forwarded client identity, NOT the socket address: the
  // ngrok agent runs locally, so every request arrives from 127.0.0.1 and a
  // socket-keyed limiter would let one remote attacker lock the operator out.
  const key = remoteKeyOf(req.headers, req.socket?.remoteAddress);
  const lockedFor = limiter.lockoutRemaining(key, now);
  if (lockedFor > 0) {
    return { ok: false, status: 429, reason: "locked_out", retryAfterMs: lockedFor };
  }

  const presented = bearerFrom(req.headers["authorization"], url);
  const verdict = verifySecret(records, presented.value, now);
  if (!verdict.ok) {
    limiter.recordFailure(key, now);
    return { ok: false, status: 401, reason: verdict.reason };
  }

  limiter.recordSuccess(key);
  await touchToken(verdict.id, now);
  return { ok: true };
}

let lastNoTokenWarningAt = 0;

/** Throttled so a blocked endpoint does not spam the audit log. */
function warnNoActiveToken(): void {
  const now = Date.now();
  if (now - lastNoTokenWarningAt < 60_000) return;
  lastNoTokenWarningAt = now;
  record(
    "bridge",
    "warning",
    "Auth is enabled but no active token exists, so /mcp is refusing every request. "
    + "Mint a token on the Open Bridge settings page (gear icon on the Bridge panel), or turn openBridge.auth.enabled off in settings.",
  );
}

/** Bump lastUsed/useCount, persisting at most every LAST_USED_FLUSH_MS. */
async function touchToken(id: string, now: number): Promise<void> {
  const records = await readRecords();
  const target = records.find(record => record.id === id);
  if (!target) return;
  target.lastUsedAt = now;
  target.useCount += 1;
  if (now - lastFlushAt < LAST_USED_FLUSH_MS) return;
  lastFlushAt = now;
  await host().secrets.store(AUTH_STORE_KEY, JSON.stringify(records));
}

/** Auth state for the panel / get_config / the auth status tool. */
export async function authStatus(): Promise<{
  enabled: boolean;
  default_ttl_seconds: number;
  tokens: Awaited<ReturnType<typeof listTokenViews>>;
  locked_out_keys: number;
}> {
  const now = Date.now();
  limiter.prune(now);
  return {
    enabled: authEnabled(),
    default_ttl_seconds: tokenTtlSeconds(),
    tokens: await listTokenViews(),
    locked_out_keys: limiter.size(),
  };
}
