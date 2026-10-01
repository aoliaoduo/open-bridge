/**
 * OAuth 2.1 authorization-server boundary.
 *
 * This module is intentionally thin: discovery/resource identity lives in
 * oauth-common, endpoint implementations live beside it, and the short-lived
 * authorization-code store is isolated from persistent credential storage.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { record } from "../bridge/activity.js";
import {
  acceptedResources,
  handleOAuthMetadata,
  oauthEnabled,
  oauthError,
  oauthIssuer,
  OAUTH_PREFIX,
  protectedResourceMetadataUrl,
} from "./oauth-common.js";
import { handleOAuthAuthorizeGet, handleOAuthAuthorizePost } from "./oauth-authorize.js";
import { handleOAuthRegister } from "./oauth-register.js";
import { handleOAuthRevoke } from "./oauth-revoke.js";
import { handleOAuthToken } from "./oauth-token.js";
import { bearerChallenge, resourceMatches } from "./oauth-protocol.js";
import {
  listClients,
  oauthStatus,
  verifyAccessToken,
} from "./oauth-store.js";

export { oauthEnabled } from "./oauth-common.js";

/** Route one OAuth request; returns true when this subsystem owns the path. */
export async function handleOAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!oauthEnabled()) return false;

  const method = (req.method ?? "GET").toUpperCase();

  // Discovery is public by design: clients need it before they have a token.
  if (method === "GET" && handleOAuthMetadata(url, res)) return true;
  if (!url.pathname.startsWith(OAUTH_PREFIX)) return false;

  try {
    switch (`${method} ${url.pathname}`) {
      case "POST /oauth/register":
        return await handleOAuthRegister(req, res);
      case "GET /oauth/authorize":
        return await handleOAuthAuthorizeGet(url, res);
      case "POST /oauth/authorize":
        return await handleOAuthAuthorizePost(req, res);
      case "POST /oauth/token":
        return await handleOAuthToken(req, res);
      case "POST /oauth/revoke":
        return await handleOAuthRevoke(req, res);
      default:
        oauthError(res, 404, "not_found", `No OAuth endpoint at ${method} ${url.pathname}.`);
        return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record("oauth", "error", `OAuth endpoint failed: ${message}`);
    if (!res.headersSent) {
      oauthError(
        res,
        500,
        "server_error",
        "The authorization server could not complete the request.",
      );
    } else if (!res.writableEnded) {
      res.end();
    }
    return true;
  }
}

/** Verify an OAuth access token presented on /mcp. */
export async function verifyOAuthBearer(
  presented: unknown,
): Promise<{ ok: true; clientId: string } | { ok: false }> {
  if (typeof presented !== "string" || !presented) return { ok: false };
  const grant = await verifyAccessToken(presented, Date.now());
  if (!grant) return { ok: false };
  return resourceMatches(grant.resource, acceptedResources())
    ? { ok: true, clientId: grant.client_id }
    : { ok: false };
}

/** The challenge a 401 carries so a client can discover the authorization server. */
export function oauthChallenge(
  error?: "invalid_token" | "insufficient_scope",
): string {
  return bearerChallenge(protectedResourceMetadataUrl(), error);
}

/** Secret-free console projection of registered OAuth clients and credential counts. */
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
