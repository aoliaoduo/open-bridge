import type { IncomingMessage, ServerResponse } from "node:http";
import { hashSecret } from "./auth-core.js";
import { consumeAuthorizationCode } from "./oauth-code-store.js";
import {
  acceptedResources,
  MAX_OAUTH_BODY_BYTES,
  oauthError,
  oauthJson,
  parseOAuthForm,
} from "./oauth-common.js";
import { resourceMatches, verifyPkceS256 } from "./oauth-protocol.js";
import {
  ACCESS_TOKEN_TTL_MS,
  consumeRefreshToken,
  findClient,
  generateOAuthSecret,
  REFRESH_TOKEN_TTL_MS,
  saveTokenPair,
  type OAuthClient,
} from "./oauth-store.js";
import { readBodyText } from "./read-body.js";

export async function handleOAuthToken(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBodyText(req, MAX_OAUTH_BODY_BYTES);
  if (body === undefined) {
    oauthError(res, 413, "invalid_request", "Token body is too large.");
    return true;
  }

  const params = parseOAuthForm(body);
  const grantType = params.grant_type ?? "";
  const client = params.client_id ? await findClient(params.client_id) : undefined;
  if (!client) {
    oauthError(res, 401, "invalid_client", "Unknown client_id.");
    return true;
  }

  if (grantType === "authorization_code") {
    return handleAuthorizationCode(params, client, res);
  }
  if (grantType === "refresh_token") {
    return handleRefreshGrant(params, client, res);
  }

  oauthError(
    res,
    400,
    "unsupported_grant_type",
    `Unsupported grant_type: ${grantType || "(missing)"}`,
  );
  return true;
}

async function handleAuthorizationCode(
  params: Record<string, string>,
  client: OAuthClient,
  res: ServerResponse,
): Promise<boolean> {
  const now = Date.now();
  const code = params.code ?? "";
  const entry = consumeAuthorizationCode(code, now);
  if (!entry) {
    oauthError(
      res,
      400,
      "invalid_grant",
      "The authorization code is invalid, expired, or already used.",
    );
    return true;
  }

  if (
    entry.clientId !== client.client_id
    || entry.redirectUri !== (params.redirect_uri ?? "")
    || !resourceMatches(params.resource ?? entry.resource, [entry.resource])
    || !resourceMatches(entry.resource, acceptedResources())
  ) {
    oauthError(
      res,
      400,
      "invalid_grant",
      "The authorization code does not match this client, redirect_uri or resource.",
    );
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

async function handleRefreshGrant(
  params: Record<string, string>,
  client: OAuthClient,
  res: ServerResponse,
): Promise<boolean> {
  const now = Date.now();
  const presented = params.refresh_token ?? "";
  if (!presented) {
    oauthError(res, 400, "invalid_request", "refresh_token is required.");
    return true;
  }

  const grant = await consumeRefreshToken(hashSecret(presented), now);
  if (!grant) {
    oauthError(
      res,
      400,
      "invalid_grant",
      "The refresh token is invalid, expired, or already used.",
    );
    return true;
  }
  if (grant.client_id !== client.client_id) {
    oauthError(res, 400, "invalid_grant", "The refresh token was not issued to this client.");
    return true;
  }
  if (
    !resourceMatches(params.resource ?? grant.resource, [grant.resource])
    || !resourceMatches(grant.resource, acceptedResources())
  ) {
    oauthError(res, 400, "invalid_grant", "The refresh token is bound to a different resource.");
    return true;
  }

  return issueTokens(client, grant.scopes, grant.resource, res, now);
}

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
      hash: hashSecret(accessToken),
      client_id: client.client_id,
      scopes,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      resource,
    },
    refresh: {
      hash: hashSecret(refreshToken),
      client_id: client.client_id,
      scopes,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      resource,
    },
  });

  oauthJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });
  return true;
}
