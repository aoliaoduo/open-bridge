import type { IncomingMessage, ServerResponse } from "node:http";
import { record } from "../bridge/activity.js";
import { AuthFailureLimiter, remoteKeyOf } from "./auth-core.js";
import {
  allowedRedirectHosts,
  MAX_OAUTH_BODY_BYTES,
  oauthError,
  oauthJson,
} from "./oauth-common.js";
import { areRedirectUrisAllowed } from "./oauth-protocol.js";
import {
  generateOAuthSecret,
  listClients,
  registerClient,
  type OAuthClient,
} from "./oauth-store.js";
import { readBodyText } from "./read-body.js";

const registerLimiter = new AuthFailureLimiter(20, 5 * 60_000, 10 * 60_000);
const MAX_REGISTERED_CLIENTS = 200;
const REGISTRATION_FULL_MESSAGE =
  `The registered client list is full (${MAX_REGISTERED_CLIENTS} clients, never pruned automatically; the console cannot remove them yet). `
  + "To reclaim a slot: stop this Bridge, delete the stale entries from the \"clients\" array of the \"openBridge.oauth\" record in secrets.json "
  + "in the data directory (default ~/.open-bridge), and start it again.";

/** RFC 7591 dynamic client registration. */
export async function handleOAuthRegister(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const now = Date.now();
  const key = remoteKeyOf(req.headers, req.socket?.remoteAddress);
  const lockedFor = registerLimiter.lockoutRemaining(key, now);
  if (lockedFor > 0) {
    oauthJson(
      res,
      429,
      {
        error: "registration_limit",
        error_description: "Too many client registrations from this address; retry later.",
      },
      { "retry-after": String(Math.ceil(lockedFor / 1000)) },
    );
    return true;
  }

  if ((await listClients()).length >= MAX_REGISTERED_CLIENTS) {
    oauthError(res, 429, "registration_limit", REGISTRATION_FULL_MESSAGE);
    return true;
  }

  const body = await readBodyText(req, MAX_OAUTH_BODY_BYTES);
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

  if (!areRedirectUrisAllowed(redirectUris, allowedRedirectHosts())) {
    oauthError(
      res,
      400,
      "invalid_redirect_uri",
      "redirect_uris must be non-empty and point at an allowed host.",
    );
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

  const registered = await registerClient(client, { maxClients: MAX_REGISTERED_CLIENTS });
  if (!registered.ok) {
    oauthError(res, 429, "registration_limit", REGISTRATION_FULL_MESSAGE);
    return true;
  }

  registerLimiter.recordFailure(key, Date.now());
  record("oauth", "progress", `Registered OAuth client ${client.client_id}.`);
  oauthJson(res, 201, client);
  return true;
}
