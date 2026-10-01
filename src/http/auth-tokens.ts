/**
 * Personal bearer-token persistence and lifecycle.
 *
 * Records are hashed at rest in the Host secret store. Reads stay cross-process
 * fresh, mutations merge against disk, and usage counters are throttled without
 * making the visible in-memory counters stale.
 */

import { host } from "../host/host.js";
import {
  buildDigestIndex,
  expiryFrom,
  generateSecret,
  generateTokenId,
  hashSecret,
  isExpired,
  mergeRecordsWithDisk,
  publicTokenView,
  type AuthTokenRecord,
  type DigestIndex,
} from "./auth-core.js";
const AUTH_STORE_KEY = "openBridge.authTokens";
/** Success-path bookkeeping is written at most this often to avoid a secrets write per request. */
const LAST_USED_FLUSH_MS = 30_000;

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

export async function readRecordsIndexed(): Promise<{ records: AuthTokenRecord[]; index: DigestIndex }> {
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
  // mergeRecordsWithDisk settles revocation/expiry in favour of disk: a CLI
  // revoke landing between our read (basis) and write must survive the
  // write-back. Rows the write itself deleted or purged are absent from
  // `next` and stay deleted, while foreign mints survive untouched.
  const merged = mergeRecordsWithDisk(basis, next, onDisk);
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

/** Bump lastUsed/useCount, persisting at most every LAST_USED_FLUSH_MS. */
export async function touchToken(id: string, now: number): Promise<void> {
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
