/**
 * Pure authentication primitives for the optional bearer-token gate.
 *
 * Design note — why a hashed personal access token rather than full OAuth:
 * OAuth 2.1 + PKCE exists so an external authorization server can delegate
 * access on behalf of many principals. Here the operator is the only principal
 * and the client is a single MCP connector, so the correct ceiling is the model
 * GitHub / Cloudflare / Tailscale use for machine access: locally minted tokens,
 * hashed at rest, compared in constant time, individually revocable, optionally
 * expiring, attributable in the audit log. Tokens are never stored in plaintext
 * and the whole gate is off by default.
 *
 * This module deliberately imports nothing (no vscode, no fs) so the security
 * decisions stay unit-testable in plain node.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Token secrets are prefixed so a leaked value is recognisable in logs. */
export const AUTH_TOKEN_PREFIX = "ob_";

/** Consecutive failures from one remote key before it is locked out. */
export const AUTH_MAX_FAILURES = 5;
/** How long a remote key stays locked out once it trips the limit. */
export const AUTH_LOCKOUT_MS = 5 * 60_000;
/** Failure counter resets when the previous failure is older than this. */
export const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;
/**
 * Hard cap on tracked remote keys. Only reached when the client can influence
 * its own remote key (a spoofed x-forwarded-for), so the map must not be
 * unbounded even though legitimate traffic never fills it.
 */
export const AUTH_MAX_TRACKED_KEYS = 1_000;

export interface AuthTokenRecord {
  /** Short public identifier used by revoke/rotate and the audit log. */
  id: string;
  label: string;
  /** sha256 hex of the secret. The secret itself is never persisted. */
  hash: string;
  createdAt: number;
  /** Epoch ms, or null for a permanent token. */
  expiresAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
  revokedAt?: number;
}

export type AuthFailureReason = "missing" | "malformed" | "unknown" | "expired" | "revoked" | "locked_out";

export type AuthVerdict =
  | { ok: true; id: string; label: string }
  | { ok: false; reason: AuthFailureReason };

/** sha256 of the presented secret. Deterministic; used for lookup and storage. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A fresh 256-bit secret. `ob_` + 43 base64url chars. */
export function generateSecret(): string {
  return `${AUTH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** A short, non-secret identifier (8 hex chars) for list/revoke/audit. */
export function generateTokenId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Timing-safe comparison of two sha256 hex digests. A length mismatch is a
 * plain false: timingSafeEqual throws on differing lengths, and the length of a
 * digest is not a secret.
 */
export function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** A permanent token (expiresAt === null) never expires. */
export function isExpired(record: AuthTokenRecord, now: number): boolean {
  return record.expiresAt !== null && now >= record.expiresAt;
}

/**
 * Resolve a presented secret against the stored records.
 *
 * Every record is compared (no early exit on the first mismatch) so the work
 * does not depend on where, or whether, a match occurs. Revoked and expired
 * matches are reported distinctly so the operator can tell a stale token from a
 * wrong one, but neither grants access.
 */
export function verifySecret(records: readonly AuthTokenRecord[], secret: unknown, now: number): AuthVerdict {
  if (typeof secret !== "string" || secret.length === 0) return { ok: false, reason: "missing" };
  if (!secret.startsWith(AUTH_TOKEN_PREFIX)) return { ok: false, reason: "malformed" };
  const digest = hashSecret(secret);
  let sawRevoked = false;
  let sawExpired = false;
  let matched: AuthTokenRecord | undefined;
  for (const record of records) {
    if (!digestEquals(record.hash, digest)) continue;
    if (record.revokedAt !== undefined) sawRevoked = true;
    else if (isExpired(record, now)) sawExpired = true;
    else matched ??= record;
  }
  if (matched) return { ok: true, id: matched.id, label: matched.label };
  if (sawRevoked) return { ok: false, reason: "revoked" };
  if (sawExpired) return { ok: false, reason: "expired" };
  return { ok: false, reason: "unknown" };
}

/** Public projection of a token record: never exposes the hash. */
export function publicTokenView(record: AuthTokenRecord, now: number): {
  id: string; label: string; created_at: string; expires_at: string | null;
  permanent: boolean; expired: boolean; revoked: boolean; last_used_at: string | null; use_count: number;
} {
  return {
    id: record.id,
    label: record.label,
    created_at: new Date(record.createdAt).toISOString(),
    expires_at: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    permanent: record.expiresAt === null,
    expired: isExpired(record, now),
    revoked: record.revokedAt !== undefined,
    last_used_at: record.lastUsedAt === null ? null : new Date(record.lastUsedAt).toISOString(),
    use_count: record.useCount,
  };
}

interface FailureEntry {
  count: number;
  windowStartedAt: number;
  lockedUntil: number;
}

/**
 * Per-remote-key failure limiter. In-memory only: a restart clearing the
 * counters is acceptable, and persisting attacker-controlled keys is not.
 * Borrowed from the one auth weakness devspace did NOT solve — an unlimited
 * password prompt — with the bound tightened by a hard cap on tracked keys.
 */
export class AuthFailureLimiter {
  private readonly entries = new Map<string, FailureEntry>();

  constructor(
    private readonly maxFailures: number = AUTH_MAX_FAILURES,
    private readonly windowMs: number = AUTH_FAILURE_WINDOW_MS,
    private readonly lockoutMs: number = AUTH_LOCKOUT_MS,
    private readonly maxKeys: number = AUTH_MAX_TRACKED_KEYS,
  ) {}

  /** Remaining lockout in ms, or 0 when the key may attempt again. */
  lockoutRemaining(key: string, now: number): number {
    const entry = this.entries.get(key);
    if (!entry || entry.lockedUntil <= now) return 0;
    return entry.lockedUntil - now;
  }

  recordFailure(key: string, now: number): void {
    const entry = this.entries.get(key);
    if (!entry || now - entry.windowStartedAt > this.windowMs) {
      this.evictIfFull(now);
      this.entries.set(key, { count: 1, windowStartedAt: now, lockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= this.maxFailures) {
      entry.lockedUntil = now + this.lockoutMs;
      entry.count = 0;
      entry.windowStartedAt = now;
    }
  }

  /** A successful authentication clears that key's history immediately. */
  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  /** Drop entries that can no longer matter (bounded memory). */
  prune(now: number): void {
    for (const [key, entry] of this.entries) {
      const idleSince = Math.max(entry.windowStartedAt + this.windowMs, entry.lockedUntil);
      if (now > idleSince) this.entries.delete(key);
    }
  }

  size(): number {
    return this.entries.size;
  }

  reset(): void {
    this.entries.clear();
  }

  private evictIfFull(now: number): void {
    if (this.entries.size < this.maxKeys) return;
    this.prune(now);
    if (this.entries.size < this.maxKeys) return;
    // Still full: drop the oldest window. Cheap and bounded; the alternative is
    // unbounded growth driven by a spoofable header.
    const oldest = [...this.entries.entries()].sort((a, b) => a[1].windowStartedAt - b[1].windowStartedAt)[0];
    if (oldest) this.entries.delete(oldest[0]);
  }
}

/** Normalize a ttl (seconds) into an absolute expiry. 0 / null / undefined = permanent. */
export function expiryFrom(ttlSeconds: unknown, now: number): number | null {
  if (ttlSeconds === null || ttlSeconds === undefined) return null;
  const seconds = typeof ttlSeconds === "number" ? ttlSeconds : Number(ttlSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return now + Math.floor(seconds) * 1000;
}

/**
 * Best-effort client identity for rate limiting. `x-forwarded-for` is trusted
 * only because a locked-out legitimate client never accumulates failures, and
 * the tracked-key map is capped regardless.
 */
export function remoteKeyOf(headers: Record<string, unknown>, socketAddress?: string): string {
  const raw = headers["x-forwarded-for"];
  const forwarded = Array.isArray(raw) ? raw[0] : raw;
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]!.trim();
    if (first) return first;
  }
  const real = headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  return socketAddress || "unknown";
}

/**
 * Extract a bearer secret from `Authorization: Bearer <token>`, falling back to
 * an `?token=` / `?access_token=` query parameter for clients that cannot set
 * headers (some hosted MCP connectors only accept a URL).
 */
export function bearerFrom(headerValue: unknown, url: URL): { value?: string; via: "header" | "query" | "none" } {
  if (typeof headerValue === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
    if (match && match[1]) return { value: match[1].trim(), via: "header" };
  }
  for (const name of ["token", "access_token"]) {
    const value = url.searchParams.get(name);
    if (value) return { value: value.trim(), via: "query" };
  }
  return { via: "none" };
}
