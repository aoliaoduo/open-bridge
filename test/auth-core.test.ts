import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_TOKEN_PREFIX,
  AuthFailureLimiter,
  bearerFrom,
  buildDigestIndex,
  digestEquals,
  expiryFrom,
  generateSecret,
  generateTokenId,
  hashSecret,
  isExpired,
  publicTokenView,
  remoteKeyOf,
  verifySecret,
  type AuthTokenRecord,
} from "../src/http/auth-core.js";

const NOW = 1_700_000_000_000;

function record(overrides: Partial<AuthTokenRecord> = {}): AuthTokenRecord {
  const secret = generateSecret();
  return {
    id: generateTokenId(),
    label: "test",
    hash: hashSecret(secret),
    createdAt: NOW,
    expiresAt: null,
    lastUsedAt: null,
    useCount: 0,
    ...overrides,
  };
}

test("hashSecret is deterministic, prefixed and never the plaintext", () => {
  const secret = generateSecret();
  assert.match(secret, new RegExp(`^${AUTH_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
  assert.equal(hashSecret(secret), hashSecret(secret));
  assert.notEqual(hashSecret(secret), secret);
  assert.notEqual(hashSecret(`${secret}x`), hashSecret(secret));
  assert.match(hashSecret(secret), /^[a-f0-9]{64}$/);
});

test("digestEquals compares digests without throwing on length mismatch", () => {
  const a = hashSecret("one");
  assert.equal(digestEquals(a, a), true);
  assert.equal(digestEquals(a, hashSecret("two")), false);
  assert.equal(digestEquals(a, "ab"), false);
  assert.equal(digestEquals("", ""), false);
});

test("verifySecret accepts a live token and rejects every other shape", () => {
  const secret = generateSecret();
  const live = record({ hash: hashSecret(secret) });
  assert.deepEqual(verifySecret([live], secret, NOW), { ok: true, id: live.id, label: live.label });

  assert.deepEqual(verifySecret([live], undefined, NOW), { ok: false, reason: "missing" });
  assert.deepEqual(verifySecret([live], "", NOW), { ok: false, reason: "missing" });
  assert.deepEqual(verifySecret([live], "plain-text-no-prefix", NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(verifySecret([live], generateSecret(), NOW), { ok: false, reason: "unknown" });
});

test("expired and revoked tokens are distinguishable but never accepted", () => {
  const expiredSecret = generateSecret();
  const expired = record({ hash: hashSecret(expiredSecret), expiresAt: NOW - 1 });
  assert.deepEqual(verifySecret([expired], expiredSecret, NOW), { ok: false, reason: "expired" });
  // expiresAt is exclusive: the instant itself is already expired.
  const atBoundary = record({ hash: hashSecret(expiredSecret), expiresAt: NOW });
  assert.deepEqual(verifySecret([atBoundary], expiredSecret, NOW), { ok: false, reason: "expired" });

  const revokedSecret = generateSecret();
  const revoked = record({ hash: hashSecret(revokedSecret), revokedAt: NOW - 5 });
  assert.deepEqual(verifySecret([revoked], revokedSecret, NOW), { ok: false, reason: "revoked" });
});

test("the digest index answers exactly what the linear scan would", () => {
  // The index is a performance change, not a semantic one, so every verdict the
  // un-indexed path produces must survive the switch unchanged.
  const liveSecret = generateSecret();
  const expiredSecret = generateSecret();
  const revokedSecret = generateSecret();
  const records = [
    record({ hash: hashSecret(liveSecret) }),
    record({ hash: hashSecret(expiredSecret), expiresAt: NOW - 1 }),
    record({ hash: hashSecret(revokedSecret), revokedAt: NOW - 5 }),
    record(),
  ];
  const index = buildDigestIndex(records);

  const probes: unknown[] = [liveSecret, expiredSecret, revokedSecret, generateSecret(), "", undefined, "not-prefixed"];
  for (const probe of probes) {
    assert.deepEqual(
      verifySecret(records, probe, NOW, index),
      verifySecret(records, probe, NOW),
      `indexed and linear verdicts must agree for ${String(probe).slice(0, 12)}`,
    );
  }

  // A revoked record must not be masked by a live one sharing the same digest:
  // grouping preserves the "every record is examined" rule.
  const sharedDigest = hashSecret(liveSecret);
  const withDuplicate = [
    record({ hash: sharedDigest, revokedAt: NOW - 5 }),
    record({ hash: sharedDigest }),
  ];
  const duplicateIndex = buildDigestIndex(withDuplicate);
  assert.equal(duplicateIndex.get(sharedDigest)?.length, 2, "duplicate digests group");
  const viaIndex = verifySecret(withDuplicate, liveSecret, NOW, duplicateIndex);
  assert.deepEqual(viaIndex, verifySecret(withDuplicate, liveSecret, NOW));
  assert.equal(viaIndex.ok, true, "a live duplicate still authenticates");

  // Revoked-only grouping is reported as revoked, not unknown.
  const revokedOnly = [record({ hash: sharedDigest, revokedAt: NOW - 5 })];
  assert.deepEqual(
    verifySecret(revokedOnly, liveSecret, NOW, buildDigestIndex(revokedOnly)),
    { ok: false, reason: "revoked" },
  );
});

test("buildDigestIndex is keyed by digest, never by a readable secret", () => {
  const secret = generateSecret();
  const index = buildDigestIndex([record({ hash: hashSecret(secret) })]);
  assert.equal(index.has(hashSecret(secret)), true);
  assert.equal(index.has(secret), false, "the plaintext secret is never a key");
  assert.equal(index.has(""), false);
});

test("a permanent token has no expiry, a ttl of 0 also means permanent", () => {
  const permanent = record();
  assert.equal(isExpired(permanent, NOW + 10 ** 12), false);
  assert.equal(expiryFrom(0, NOW), null);
  assert.equal(expiryFrom(null, NOW), null);
  assert.equal(expiryFrom(undefined, NOW), null);
  assert.equal(expiryFrom(-5, NOW), null);
  assert.equal(expiryFrom("abc", NOW), null);
  assert.equal(expiryFrom(60, NOW), NOW + 60_000);
  assert.equal(expiryFrom("90", NOW), NOW + 90_000);
});

test("publicTokenView exposes state but never the hash", () => {
  const expiresAt = NOW + 3_600_000;
  const view = publicTokenView(record({ expiresAt, useCount: 7, lastUsedAt: NOW - 1_000 }), NOW);
  assert.equal(view.permanent, false);
  assert.equal(view.expired, false);
  assert.equal(view.use_count, 7);
  assert.equal(view.revoked, false);
  assert.equal(new Date(expiresAt).toISOString(), view.expires_at);
  assert.equal(JSON.stringify(view).includes("hash"), false);
});

test("limiter locks out after the threshold and clears on success", () => {
  const limiter = new AuthFailureLimiter(3, 1_000, 5_000);
  assert.equal(limiter.lockoutRemaining("ip", NOW), 0);
  limiter.recordFailure("ip", NOW);
  limiter.recordFailure("ip", NOW);
  assert.equal(limiter.lockoutRemaining("ip", NOW), 0, "under the threshold");
  limiter.recordFailure("ip", NOW);
  assert.equal(limiter.lockoutRemaining("ip", NOW), 5_000);
  assert.equal(limiter.lockoutRemaining("ip", NOW + 4_999), 1);
  assert.equal(limiter.lockoutRemaining("ip", NOW + 5_000), 0, "lockout expired");

  limiter.recordSuccess("ip");
  assert.equal(limiter.size(), 0);
});

test("limiter forgets failures older than the window and caps tracked keys", () => {
  const limiter = new AuthFailureLimiter(3, 1_000, 5_000, 4);
  limiter.recordFailure("a", NOW);
  limiter.recordFailure("a", NOW + 2_000); // window elapsed -> counter restarts
  limiter.recordFailure("a", NOW + 2_100);
  assert.equal(limiter.lockoutRemaining("a", NOW + 2_100), 0, "window reset the count");

  for (let i = 0; i < 10; i += 1) limiter.recordFailure(`key-${i}`, NOW + 10_000 + i);
  assert.ok(limiter.size() <= 4, `tracked keys must stay capped, got ${limiter.size()}`);
  limiter.prune(NOW + 600_000);
  assert.equal(limiter.size(), 0);
});

test("remoteKeyOf prefers the forwarded client, then real-ip, then the socket", () => {
  assert.equal(remoteKeyOf({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, "127.0.0.1"), "203.0.113.7");
  assert.equal(remoteKeyOf({ "x-forwarded-for": ["198.51.100.2"] }, "127.0.0.1"), "198.51.100.2");
  assert.equal(remoteKeyOf({ "x-real-ip": "198.51.100.9" }, "127.0.0.1"), "198.51.100.9");
  assert.equal(remoteKeyOf({}, "127.0.0.1"), "127.0.0.1");
  assert.equal(remoteKeyOf({}, undefined), "unknown");
  assert.equal(remoteKeyOf({ "x-forwarded-for": "   " }, "10.1.1.1"), "10.1.1.1");
});

test("bearerFrom reads the header first and falls back to a query parameter", () => {
  assert.deepEqual(bearerFrom("Bearer abc", new URL("http://x/mcp")), { value: "abc", via: "header" });
  assert.deepEqual(bearerFrom("bearer  abc  ", new URL("http://x/mcp")), { value: "abc", via: "header" });
  assert.deepEqual(bearerFrom(undefined, new URL("http://x/mcp?token=qt")), { value: "qt", via: "query" });
  assert.deepEqual(bearerFrom(undefined, new URL("http://x/mcp?access_token=at")), { value: "at", via: "query" });
  assert.deepEqual(bearerFrom(undefined, new URL("http://x/mcp")), { via: "none" });
  assert.deepEqual(bearerFrom("Basic abc", new URL("http://x/mcp")), { via: "none" });
});
