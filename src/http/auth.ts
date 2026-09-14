/**
 * Optional bearer-token gate for the MCP endpoint (orchestration layer).
 *
 * OFF by default: `openBridge.auth.enabled` defaults to false and every path in
 * this module short-circuits to "allowed" so existing installs keep working
 * unchanged. When enabled the gate runs after the Host allowlist and before the
 * route-token/peer handling, so an unauthenticated request never reaches the
 * MCP transport, the peer proxy, or the session table.
 *
 * Records live in the host secret store (`secrets.json`, chmod 600), hashed at
 * rest. The plaintext secret exists only in the mint/rotate response.
 *
 * Cross-process consistency: instances and the CLI share one data dir, so a
 * module-level cache would freeze another process's mint/revoke out of this
 * one forever — a CLI-minted token answered 401 and a CLI-revoked token kept
 * authenticating until restart. Reads therefore go to the store every time
 * (the store already reloads on mtime change), and the parse of what comes
 * back is memoized by *content*: the cache is keyed on the stored text
 * itself, so an unchanged store costs nothing while any write — ours or
 * another process's — is picked up on the very next read. There is therefore
 * no invalidation entry point, because there is no state that can go stale.
 * Writes are serialized per process and MERGED with the rows on disk: rows
 * with ids we have never seen are kept, so a token minted by another
 * instance milliseconds before our write cannot be deleted by it.
 */

import { host } from "../host/host.js";
import { record } from "../bridge/state.js";
import { oauthChallenge, oauthEnabled, verifyOAuthBearer } from "./oauth.js";
import {
  AuthFailureLimiter,
  bearerFrom,
  buildDigestIndex,
  expiryFrom,
  generateSecret,
  generateTokenId,
  hashSecret,
  isExpired,
  publicTokenView,
  remoteKeyOf,
  verifySecret,
  type AuthTokenRecord,
  type DigestIndex,
} from "./auth-core.js";
const AUTH_STORE_KEY = "openBridge.authTokens";
/** Success-path bookkeeping is written at most this often to avoid a secrets write per request. */
const LAST_USED_FLUSH_MS = 30_000;

const limiter = new AuthFailureLimiter();
let lastFlushAt = 0;
/**
 * In-memory record of `lastUsedAt` / `useCount` bumps that have not yet been
 * persisted. The throttle only applies to the disk flush; every successful
 * call must update the visible counters immediately, otherwise the
 * "when was this token last used" answer the audit log and `token list`
 * depend on is 30 s stale even on a quiet session.
 *
 * Kept as `id -> { lastUsedAt, delta }` rather than `Map<id, AuthTokenRecord>`
 * because the on-disk record is the source of truth for everything else
 * (label / scopes / hash / revocation) and we only need to add the two
 * bookkeeping fields on top.
 */
const pendingBumps = new Map<string, { lastUsedAt: number; delta: number }>();

export function authEnabled(): boolean {
  return host().config.get<boolean>("auth.enabled", false) === true;
}

/** Configured default lifetime for newly minted tokens; 0 / unset = permanent. */
export function tokenTtlSeconds(): number {
  const raw = host().config.get<number>("auth.tokenTtlSeconds", 0);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseRecords(raw: unknown): AuthTokenRecord[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AuthTokenRecord =>
      !!item && typeof item === "object"
      && typeof (item as AuthTokenRecord).id === "string"
      && typeof (item as AuthTokenRecord).hash === "string");
  } catch {
    // Corrupt store: treat as empty rather than locking the operator out.
    return [];
  }
}

/** Fresh read on every call: another process's changes must be visible at once. */
async function readRecords(): Promise<AuthTokenRecord[]> {
  const secrets = host().secrets;
  if (!secrets) return [];
  return parseRecords(await secrets.get(AUTH_STORE_KEY));
}

/**
 * Parsed records plus the digest index, memoized on the store's raw string.
 *
 * Why this keeps cross-process correctness while removing the per-request cost:
 * `SecretStore.get` already reloads from disk whenever the file's mtime moves,
 * so the string it returns is a faithful snapshot of the current store. The
 * cache is therefore keyed on that exact string — a foreign mint or revoke
 * produces different content, so the next request re-parses and rebuilds. A TTL
 * cache would have been faster still and wrong: a CLI-revoked token would keep
 * authenticating for the length of the TTL.
 *
 * Reads stay answerable from disk on every request (the `get` call still
 * happens); what is skipped is re-parsing and re-indexing unchanged bytes, which
 * used to happen once per request. That mattered little with a handful of PATs
 * and matters much more once OAuth access tokens share this gate.
 */
let parsedCache: { raw: string; records: AuthTokenRecord[]; index: DigestIndex } | undefined;

async function readRecordsIndexed(): Promise<{ records: AuthTokenRecord[]; index: DigestIndex }> {
  const secrets = host().secrets;
  if (!secrets) return { records: [], index: new Map() };
  const raw = await secrets.get(AUTH_STORE_KEY);
  if (parsedCache && parsedCache.raw === raw) {
    return { records: parsedCache.records, index: parsedCache.index };
  }
  const records = parseRecords(raw);
  const index = buildDigestIndex(records);
  parsedCache = { raw: raw ?? "", records, index };
  return { records, index };
}

/**
 * Serialize record mutations per process (concurrent tool calls must not
 * interleave read-merge-write), then MERGE with a fresh disk read inside the
 * write: rows the task never saw (another process minted them between our
 * read and our write) survive. Rows the task SAW and dropped stay dropped —
 * otherwise a purge would resurrect the very rows it just deleted.
 */
let recordsWriteTail: Promise<void> = Promise.resolve();

function enqueueRecordWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = recordsWriteTail.then(task, task);
  recordsWriteTail = next.then(() => undefined, () => undefined);
  return next;
}

async function writeMergedRecords(basis: AuthTokenRecord[], next: AuthTokenRecord[]): Promise<void> {
  const onDisk = await readRecords();
  const basisIds = new Set(basis.map(item => item.id));
  const nextIds = new Set(next.map(item => item.id));
  const foreign = onDisk.filter(item => !basisIds.has(item.id) && !nextIds.has(item.id));
  const merged = [...next, ...foreign];
  await host().secrets.store(AUTH_STORE_KEY, JSON.stringify(merged));
  host().ui.update();
}

/** Run one read-transform-write cycle with a fresh disk read inside. */
async function mutateRecords<T>(
  mutate: (records: AuthTokenRecord[]) => { records: AuthTokenRecord[]; result: T },
): Promise<T> {
  return enqueueRecordWrite(async () => {
    const basis = await readRecords();
    const { records, result } = mutate(basis);
    await writeMergedRecords(basis, records);
    return result;
  });
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

function mintedView(entry: AuthTokenRecord, secret: string): MintedToken {
  return {
    id: entry.id,
    label: entry.label,
    secret,
    created_at: new Date(entry.createdAt).toISOString(),
    expires_at: entry.expiresAt === null ? null : new Date(entry.expiresAt).toISOString(),
    permanent: entry.expiresAt === null,
  };
}

/** Mint a new token. `ttlSeconds` from the caller, else the configured default. */
export async function mintToken(options: { label?: string; ttlSeconds?: number | null } = {}): Promise<MintedToken> {
  const now = Date.now();
  const ttl = options.ttlSeconds === undefined ? tokenTtlSeconds() : options.ttlSeconds;
  const secret = generateSecret();
  const entry: AuthTokenRecord = {
    id: generateTokenId(),
    label: (options.label ?? "").trim() || `token-${new Date(now).toISOString().slice(0, 10)}`,
    hash: hashSecret(secret),
    createdAt: now,
    expiresAt: expiryFrom(ttl, now),
    lastUsedAt: null,
    useCount: 0,
  };
  return mutateRecords(records => ({ records: [...records, entry], result: mintedView(entry, secret) }));
}

export async function listTokenViews(): Promise<ReturnType<typeof publicTokenView>[]> {
  const now = Date.now();
  // Apply in-memory bumps so callers (UI, audit) see fresh `last_used_at` /
  // `use_count` even within the throttle window, before the next disk flush.
  return (await readRecords()).map(item => {
    const pending = pendingBumps.get(item.id);
    if (!pending) return publicTokenView(item, now);
    const merged = { ...item, lastUsedAt: pending.lastUsedAt, useCount: item.useCount + pending.delta };
    return publicTokenView(merged, now);
  });
}

/**
 * Revoke by id (exact) or by id prefix, so an operator can paste the first few
 * characters. Already-revoked tokens are left alone; unknown ids throw.
 */
export async function revokeToken(idOrPrefix: string): Promise<{ revoked: string[] }> {
  const needle = idOrPrefix.trim().toLowerCase();
  if (!needle) throw new Error("Provide a token id. Use openBridge.auth.manageTokens to list them.");
  return mutateRecords(records => {
    const now = Date.now();
    const hits = records.filter(item => item.revokedAt === undefined && item.id.toLowerCase().startsWith(needle));
    if (!hits.length) throw new Error(`No active token matches "${idOrPrefix}".`);
    const hitIds = new Set(hits.map(item => item.id));
    return {
      records: records.map(item => (hitIds.has(item.id) ? { ...item, revokedAt: now } : item)),
      result: { revoked: hits.map(item => item.id) },
    };
  });
}

/** Revoke every active token. Escape hatch for "I think a token leaked". */
export async function revokeAllTokens(): Promise<{ revoked: string[] }> {
  return mutateRecords(records => {
    const now = Date.now();
    const hits = records.filter(item => item.revokedAt === undefined);
    const hitIds = new Set(hits.map(item => item.id));
    return {
      records: records.map(item => (hitIds.has(item.id) ? { ...item, revokedAt: now } : item)),
      result: { revoked: hits.map(item => item.id) },
    };
  });
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
  return mutateRecords(records => {
    const hits = records.filter(item => item.id.toLowerCase().startsWith(needle));
    if (!hits.length) throw new Error(`No token matches "${idOrPrefix}".`);
    const hitIds = new Set(hits.map(item => item.id));
    return {
      records: records.filter(item => !hitIds.has(item.id)),
      result: { deleted: hits.map(item => item.id) },
    };
  });
}

/** Delete every already-revoked or already-expired token in one step. */
export async function purgeInactiveTokens(): Promise<{ deleted: string[] }> {
  return mutateRecords(records => {
    const now = Date.now();
    const hits = records.filter(item => item.revokedAt !== undefined || isExpired(item, now));
    const hitIds = new Set(hits.map(item => item.id));
    return {
      records: records.filter(item => !hitIds.has(item.id)),
      result: { deleted: hits.map(item => item.id) },
    };
  });
}

/** How many tokens could still authenticate a request right now. */
export async function usableTokenCount(): Promise<number> {
  const now = Date.now();
  return (await readRecords()).filter(item => item.revokedAt === undefined && !isExpired(item, now)).length;
}

/**
 * Replace a token's secret while keeping its id and history. The previous
 * secret stops working immediately; the new one inherits the current TTL
 * setting (so a rotation can also shorten or drop an expiry).
 */
export async function rotateToken(idOrPrefix: string): Promise<MintedToken> {
  const needle = idOrPrefix.trim().toLowerCase();
  if (!needle) throw new Error("Provide a token id. Token ids are listed on the Open Bridge settings page.");
  return mutateRecords(records => {
    const target = records.find(item => item.id.toLowerCase().startsWith(needle));
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
    return {
      records: records.map(item => (item.id === target.id ? updated : item)),
      result: mintedView(updated, secret),
    };
  });
}

export type AuthGateResult =
  | { ok: true }
  | { ok: false; status: number; reason: string; retryAfterMs?: number; challenge?: string };

/**
 * Gate one request. Returns { ok: true } when auth is disabled (the default).
 *
 * Fail-closed when auth is on but no usable token exists. Failing open here
 * would defeat the point of revoking the last token ("I think it leaked") — the
 * request would be admitted before its (revoked) credential was even checked.
 * Lockout is never unrecoverable anyway: the operator owns the machine and can
 * turn `auth.enabled` off from the local settings page — that surface is
 * loopback-only, so it never needs the credential the operator lost.
 */
export async function authorizeRequest(
  req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } },
  url: URL,
): Promise<AuthGateResult> {
  // OAuth is an independent gate: a valid OAuth access token is admitted whether
  // or not the personal-token gate is on.
  //
  // Turning OAuth on must not disconnect a client that already holds a
  // credential: a presented token is verified below with the personal gate on
  // OR off. What OAuth does close is the URL-only door — the route token in
  // `/mcp/<token>` is a routing key, not a credential (http-listener.ts matches
  // path before this gate runs, and bearerFrom never reads the path), so a
  // request that presents nothing gets the discovery challenge. That header, not
  // the status code, is how an OAuth client learns to authorize. A client that
  // can only be handed a URL keeps working by carrying its token in the query
  // string (`?token=`), which `bearerFrom` already reads.
  const presented = bearerFrom(req.headers["authorization"], url);
  let oauthRejection: AuthGateResult | undefined;
  if (oauthEnabled()) {
    const oauth = await authorizeWithOAuth(req, url);
    if (oauth.ok) return oauth;
    oauthRejection = oauth;
  }
  // Handed to every rejection below: a client whose own token is stale is
  // exactly the one that should be told how to get a new one.
  const oauthChallengeHeader = oauthRejection && !oauthRejection.ok ? oauthRejection.challenge : undefined;

  // Personal gate off: the URL-only client is admitted as before — unless OAuth
  // is on and the request presented nothing, in which case OAuth's rejection
  // (with its discovery challenge) is the answer.
  if (!authEnabled() && (oauthRejection === undefined || presented.via === "none")) {
    return oauthRejection ?? { ok: true };
  }

  const now = Date.now();
  const { records, index } = await readRecordsIndexed();
  if (!records.some(item => item.revokedAt === undefined && !isExpired(item, now))) {
    warnNoActiveToken();
    // Deliberately not counted as a failure: this is a configuration state, not
    // an attack, and the operator's own client must not get locked out while
    // they fix it.
    return { ok: false, status: 401, reason: "no_active_token", challenge: oauthChallengeHeader };
  }

  // Rate-limit on the forwarded client identity, NOT the socket address: the
  // ngrok agent runs locally, so every request arrives from 127.0.0.1 and a
  // socket-keyed limiter would let one remote attacker lock the operator out.
  const key = remoteKeyOf(req.headers, req.socket?.remoteAddress);
  const lockedFor = limiter.lockoutRemaining(key, now);
  if (lockedFor > 0) {
    return { ok: false, status: 429, reason: "locked_out", retryAfterMs: lockedFor };
  }

  const verdict = verifySecret(records, presented.value, now, index);
  if (!verdict.ok) {
    limiter.recordFailure(key, now);
    return { ok: false, status: 401, reason: verdict.reason, challenge: oauthChallengeHeader };
  }

  limiter.recordSuccess(key);
  await touchToken(verdict.id, now);
  return { ok: true };
}

let lastNoTokenWarningAt = 0;

/**
 * The OAuth half of the `/mcp` gate.
 *
 * A 401 here must carry the discovery challenge, or a client that speaks OAuth
 * has no way to find the authorization server — the spec makes that header, not
 * the status code, the entry point to the whole flow.
 */
async function authorizeWithOAuth(
  req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } },
  url: URL,
): Promise<AuthGateResult> {
  const presented = bearerFrom(req.headers["authorization"], url);
  if (presented.via === "none") {
    return { ok: false, status: 401, reason: "oauth_token_required", challenge: oauthChallenge() };
  }
  const verdict = await verifyOAuthBearer(presented.value);
  if (!verdict.ok) {
    return { ok: false, status: 401, reason: "invalid_token", challenge: oauthChallenge("invalid_token") };
  }
  return { ok: true };
}

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
  // In-memory bump is unconditional so `token list` and the audit log see
  // every successful call. The throttle only gates the disk write.
  const pending = pendingBumps.get(id);
  if (pending) {
    pending.lastUsedAt = now;
    pending.delta += 1;
  } else {
    pendingBumps.set(id, { lastUsedAt: now, delta: 1 });
  }
  if (now - lastFlushAt < LAST_USED_FLUSH_MS) return;
  lastFlushAt = now;
  // Drain pending bumps through the merged, serialized path: a stale
  // whole-array store used to delete tokens another instance had minted in
  // the meantime. Failures are swallowed because the in-memory bump already
  // succeeded and the next call will retry the flush.
  const toFlush = Array.from(pendingBumps.entries());
  pendingBumps.clear();
  await mutateRecords(records => {
    for (const [tokenId, { lastUsedAt, delta }] of toFlush) {
      const target = records.find(item => item.id === tokenId);
      if (!target) continue;
      // Use the latest lastUsedAt and the total delta; multiple flushes
      // in flight are guarded against by the throttle above.
      if (lastUsedAt > (target.lastUsedAt ?? 0)) target.lastUsedAt = lastUsedAt;
      target.useCount += delta;
    }
    return { records, result: undefined as void };
  }).catch(() => {
    // Re-queue bumps on failure so they are not silently lost.
    for (const [tokenId, bump] of toFlush) {
      const existing = pendingBumps.get(tokenId);
      if (existing) {
        existing.lastUsedAt = Math.max(existing.lastUsedAt, bump.lastUsedAt);
        existing.delta += bump.delta;
      } else {
        pendingBumps.set(tokenId, bump);
      }
    }
  });
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
