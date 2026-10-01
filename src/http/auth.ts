/**
 * Authentication request-gate orchestration.
 *
 * Personal token persistence/CRUD lives in auth-tokens.ts. This module decides
 * whether one /mcp request is admitted by OAuth or the optional personal-token
 * gate, owns brute-force limiting, and exposes the historical auth.ts API.
 */

import { host } from "../host/host.js";
import { record } from "../bridge/activity.js";
import { oauthChallenge, oauthEnabled, verifyOAuthBearer } from "./oauth.js";
import {
  AuthFailureLimiter,
  bearerFrom,
  forwardedIdentity,
  isExpired,
  verifySecret,
} from "./auth-core.js";
import {
  listTokenViews,
  readRecordsIndexed,
  tokenTtlSeconds,
  touchToken,
} from "./auth-tokens.js";

export {
  deleteToken,
  listTokenViews,
  mintToken,
  purgeInactiveTokens,
  revokeAllTokens,
  revokeToken,
  rotateToken,
  tokenTtlSeconds,
  usableTokenCount,
} from "./auth-tokens.js";
export type { MintedToken } from "./auth-tokens.js";

const limiter = new AuthFailureLimiter();
export function authEnabled(): boolean {
  return host().config.get<boolean>("auth.enabled", false) === true;
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
    const oauth = await authorizeWithOAuth(presented);
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
  // Failure accounting applies only to forwarded identities. A direct
  // connection — the local MCP client, a browser debugging the URL, the
  // console's own anonymous auth_gate probe — shares one socket key, and
  // counting its failures let five anonymous health checks in five minutes
  // answer the operator's own client with 429. A caller already on the machine
  // can read secrets.json, so the limiter has nothing to offer there; remote
  // brute force arrives through the tunnel and carries a forwarded identity.
  const identity = forwardedIdentity(req.headers);
  const lockedFor = identity ? limiter.lockoutRemaining(identity, now) : 0;
  if (lockedFor > 0) {
    return { ok: false, status: 429, reason: "locked_out", retryAfterMs: lockedFor };
  }

  const verdict = verifySecret(records, presented.value, now, index);
  if (!verdict.ok) {
    if (identity) limiter.recordFailure(identity, now);
    return { ok: false, status: 401, reason: verdict.reason, challenge: oauthChallengeHeader };
  }

  if (identity) limiter.recordSuccess(identity);
  await touchToken(verdict.id, now);
  return { ok: true };
}

let lastNoTokenWarningAt = 0;

/**
 * The OAuth half of the `/mcp` gate.
 *
 * Takes the credential `authorizeRequest` already extracted — one parse of the
 * Authorization header per request, not one per gate.
 *
 * A 401 here must carry the discovery challenge, or a client that speaks OAuth
 * has no way to find the authorization server — the spec makes that header, not
 * the status code, the entry point to the whole flow.
 */
async function authorizeWithOAuth(presented: ReturnType<typeof bearerFrom>): Promise<AuthGateResult> {
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
