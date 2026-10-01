import type { IncomingMessage, ServerResponse } from "node:http";
import { record } from "../bridge/activity.js";
import {
  MAX_OAUTH_BODY_BYTES,
  oauthError,
  oauthJson,
  parseOAuthForm,
} from "./oauth-common.js";
import { revokeToken } from "./oauth-store.js";
import { readBodyText } from "./read-body.js";

/** RFC 7009 revocation: an unknown token still returns 200. */
export async function handleOAuthRevoke(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBodyText(req, MAX_OAUTH_BODY_BYTES);
  if (body === undefined) {
    oauthError(res, 413, "invalid_request", "Revocation body is too large.");
    return true;
  }

  const token = parseOAuthForm(body).token ?? "";
  if (token) {
    const revoked = await revokeToken(token);
    if (revoked) record("oauth", "progress", "Revoked an OAuth credential.");
  }
  oauthJson(res, 200, {});
  return true;
}
