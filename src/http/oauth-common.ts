import type { ServerResponse } from "node:http";
import { host } from "../host/host.js";
import { state } from "../bridge/runtime-state.js";
import { sendJson } from "./json-response.js";
import {
  DEFAULT_ALLOWED_REDIRECT_HOSTS,
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "./oauth-protocol.js";
import { OAUTH_SCOPE } from "./oauth-store.js";

export const OAUTH_PREFIX = "/oauth/";
export const WELL_KNOWN_PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";
export const WELL_KNOWN_AUTHORIZATION_SERVER = "/.well-known/oauth-authorization-server";
export const SUPPORTED_SCOPES: readonly string[] = Object.freeze([OAUTH_SCOPE]);
export const MAX_OAUTH_BODY_BYTES = 64 * 1024;

export function oauthEnabled(): boolean {
  return host().config.get<boolean>("oauth.enabled", false) === true;
}

export function allowedRedirectHosts(): readonly string[] {
  const configured = host().config.get<unknown>("oauth.allowedRedirectHosts", []);
  if (
    Array.isArray(configured)
    && configured.every(entry => typeof entry === "string")
    && configured.length > 0
  ) {
    return configured as string[];
  }
  return DEFAULT_ALLOWED_REDIRECT_HOSTS;
}

export function oauthIssuer(): string {
  const publicUrl = state.tunnelUrl;
  if (publicUrl) {
    try {
      return new URL(publicUrl).origin;
    } catch {
      // Fall through to loopback when a malformed tunnel URL is observed.
    }
  }
  return state.port ? `http://127.0.0.1:${state.port}` : "http://127.0.0.1";
}

/**
 * Public resource identifier. It deliberately excludes the route token because
 * the discovery document is unauthenticated by design.
 */
export function oauthResource(): string {
  return `${oauthIssuer()}/mcp`;
}

/** Accept the historical tokenized identifier without publishing it again. */
export function acceptedResources(): string[] {
  return state.routeToken
    ? [oauthResource(), `${oauthResource()}/${state.routeToken}`]
    : [oauthResource()];
}

export function protectedResourceMetadataUrl(): string {
  const resourcePath = new URL(oauthResource()).pathname;
  return `${oauthIssuer()}${WELL_KNOWN_PROTECTED_RESOURCE}${resourcePath}`;
}

export function oauthJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  sendJson(res, status, payload, {
    "referrer-policy": "no-referrer",
    "access-control-allow-origin": "*",
    ...extraHeaders,
  });
}

export function oauthError(
  res: ServerResponse,
  status: number,
  error: string,
  description?: string,
): void {
  oauthJson(res, status, description ? { error, error_description: description } : { error });
}

export function oauthHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  });
  res.end(body);
}

export function parseOAuthForm(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params) result[key] = value;
  return result;
}

export function handleOAuthMetadata(url: URL, res: ServerResponse): boolean {
  const issuer = oauthIssuer();
  if (url.pathname === WELL_KNOWN_AUTHORIZATION_SERVER) {
    oauthJson(res, 200, authorizationServerMetadata(issuer, SUPPORTED_SCOPES));
    return true;
  }
  if (
    url.pathname === WELL_KNOWN_PROTECTED_RESOURCE
    || url.pathname.startsWith(`${WELL_KNOWN_PROTECTED_RESOURCE}/`)
  ) {
    oauthJson(res, 200, protectedResourceMetadata(oauthResource(), SUPPORTED_SCOPES));
    return true;
  }
  return false;
}
