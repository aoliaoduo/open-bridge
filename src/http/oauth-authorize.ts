import type { IncomingMessage, ServerResponse } from "node:http";
import { record } from "../bridge/activity.js";
import { state } from "../bridge/runtime-state.js";
import { AuthFailureLimiter, digestEquals, hashSecret, remoteKeyOf } from "./auth-core.js";
import { issueAuthorizationCode } from "./oauth-code-store.js";
import {
  acceptedResources,
  MAX_OAUTH_BODY_BYTES,
  oauthError,
  oauthHtml,
  oauthResource,
  parseOAuthForm,
  SUPPORTED_SCOPES,
} from "./oauth-common.js";
import {
  escapeHtml,
  resolveScopes,
  resourceMatches,
} from "./oauth-protocol.js";
import { findClient, OAUTH_SCOPE, type OAuthClient } from "./oauth-store.js";
import { readBodyText } from "./read-body.js";

const ownerLimiter = new AuthFailureLimiter();

function ownerCredential(): string {
  const fromEnv = process.env.OPEN_BRIDGE_OAUTH_OWNER;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return state.routeToken;
}

function ownerMatches(submitted: unknown): boolean {
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const expected = ownerCredential();
  if (!expected) return false;
  return digestEquals(hashSecret(submitted), hashSecret(expected));
}

function consentPage(
  params: Record<string, string>,
  client: OAuthClient,
  error?: string,
): string {
  const hidden = [
    "response_type", "client_id", "redirect_uri", "code_challenge",
    "code_challenge_method", "scope", "state", "resource",
  ].map(name => `<input type="hidden" name="${name}" value="${escapeHtml(params[name] ?? "")}">`)
    .join("\n      ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 Open Bridge</title>
<style>
 body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:34rem;margin:10vh auto;padding:0 1.25rem;color:#111}
 h1{font-size:1.15rem;margin:0 0 .25rem}
 .who{color:#555;margin:0 0 1.25rem}
 dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem .9rem;margin:0 0 1.25rem;font-size:.9rem}
 dt{color:#666}
 dd{margin:0;word-break:break-all}
 .warn{background:#fff6e5;border:1px solid #f0d18a;border-radius:8px;padding:.75rem .9rem;margin:0 0 1.25rem;font-size:.9rem}
 label{display:block;margin:0 0 .4rem;font-weight:600}
 input[type=password]{width:100%;padding:.6rem .7rem;border:1px solid #bbb;border-radius:8px;font:inherit}
 button{margin-top:1rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#111;color:#fff;font:inherit;font-weight:600;cursor:pointer}
 .err{color:#b00020;margin:.75rem 0 0}
</style>
</head>
<body>
  <h1>授权 Open Bridge</h1>
  <p class="who">${escapeHtml(client.client_name ?? client.client_id)} 请求访问这台机器上的工作区。</p>
  <dl>
    <dt>客户端</dt><dd>${escapeHtml(client.client_id)}</dd>
    <dt>权限</dt><dd>${escapeHtml(params.scope || OAUTH_SCOPE)}</dd>
    <dt>资源</dt><dd>${escapeHtml(params.resource ?? "")}</dd>
    <dt>回调</dt><dd>${escapeHtml(params.redirect_uri ?? "")}</dd>
  </dl>
  <p class="warn">授权后，该客户端可以读写此工作区的文件、执行命令并管理进程——与你自己在本机操作同级。只授权你信任的客户端。</p>
  <form method="post" action="/oauth/authorize">
      ${hidden}
    <label for="owner">操作员口令（即控制台的路由令牌）</label>
    <input id="owner" name="owner_token" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">授权</button>
  </form>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
</body>
</html>`;
}

function redirectWithError(
  res: ServerResponse,
  redirectUri: string,
  stateValue: string | undefined,
  error: string,
  description?: string,
): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (description) target.searchParams.set("error_description", description);
  if (stateValue) target.searchParams.set("state", stateValue);
  res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
  res.end();
}

export async function handleOAuthAuthorizeGet(
  url: URL,
  res: ServerResponse,
): Promise<boolean> {
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) params[key] = value;

  const client = params.client_id ? await findClient(params.client_id) : undefined;
  if (!client) {
    oauthError(res, 400, "invalid_request", "Unknown client_id. Register the client first.");
    return true;
  }
  if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri)) {
    oauthError(
      res,
      400,
      "invalid_request",
      "redirect_uri does not match a registered value for this client.",
    );
    return true;
  }
  if (params.response_type !== "code") {
    redirectWithError(res, params.redirect_uri, params.state, "unsupported_response_type");
    return true;
  }
  if (params.code_challenge_method !== "S256" || !params.code_challenge) {
    redirectWithError(
      res,
      params.redirect_uri,
      params.state,
      "invalid_request",
      "PKCE with code_challenge_method=S256 is required.",
    );
    return true;
  }
  if (!resourceMatches(params.resource, acceptedResources())) {
    redirectWithError(
      res,
      params.redirect_uri,
      params.state,
      "invalid_target",
      "Invalid or missing resource parameter.",
    );
    return true;
  }

  const scopeVerdict = resolveScopes(params.scope, SUPPORTED_SCOPES);
  if (!scopeVerdict.ok) {
    redirectWithError(
      res,
      params.redirect_uri,
      params.state,
      "invalid_scope",
      `Unsupported scope: ${scopeVerdict.scope}`,
    );
    return true;
  }

  oauthHtml(res, 200, consentPage(params, client));
  return true;
}

export async function handleOAuthAuthorizePost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readBodyText(req, MAX_OAUTH_BODY_BYTES);
  if (body === undefined) {
    oauthError(res, 413, "invalid_request", "Consent body is too large.");
    return true;
  }

  const params = parseOAuthForm(body);
  const client = params.client_id ? await findClient(params.client_id) : undefined;
  if (!client) {
    oauthError(res, 400, "invalid_request", "Unknown client_id.");
    return true;
  }
  if (!params.redirect_uri || !client.redirect_uris.includes(params.redirect_uri)) {
    oauthError(
      res,
      400,
      "invalid_request",
      "redirect_uri does not match a registered value for this client.",
    );
    return true;
  }

  const key = remoteKeyOf(req.headers, req.socket?.remoteAddress);
  const now = Date.now();
  const lockedFor = ownerLimiter.lockoutRemaining(key, now);
  if (lockedFor > 0) {
    oauthHtml(res, 429, consentPage(params, client, "尝试过于频繁，请稍后再试。"));
    return true;
  }
  if (!ownerMatches(params.owner_token)) {
    ownerLimiter.recordFailure(key, now);
    record("oauth", "warning", `Rejected a consent attempt for client ${client.client_id}.`);
    oauthHtml(res, 401, consentPage(params, client, "口令不正确。"));
    return true;
  }
  ownerLimiter.recordSuccess(key);

  if (
    params.response_type !== "code"
    || params.code_challenge_method !== "S256"
    || !params.code_challenge
  ) {
    redirectWithError(
      res,
      params.redirect_uri,
      params.state,
      "invalid_request",
      "PKCE with code_challenge_method=S256 is required.",
    );
    return true;
  }
  if (!resourceMatches(params.resource, acceptedResources())) {
    redirectWithError(
      res,
      params.redirect_uri,
      params.state,
      "invalid_target",
      "Invalid or missing resource parameter.",
    );
    return true;
  }

  const scopeVerdict = resolveScopes(params.scope, SUPPORTED_SCOPES);
  if (!scopeVerdict.ok) {
    redirectWithError(
      res,
      params.redirect_uri,
      params.state,
      "invalid_scope",
      `Unsupported scope: ${scopeVerdict.scope}`,
    );
    return true;
  }

  const code = issueAuthorizationCode({
    clientId: client.client_id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    scopes: scopeVerdict.scopes,
    resource: params.resource ?? oauthResource(),
  }, now);
  record("oauth", "progress", `Authorized OAuth client ${client.client_id}.`);

  const target = new URL(params.redirect_uri);
  target.searchParams.set("code", code);
  if (params.state) target.searchParams.set("state", params.state);
  res.writeHead(302, {
    location: target.toString(),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end();
  return true;
}
