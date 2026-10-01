import { AUTH_CODE_TTL_MS, generateOAuthSecret } from "./oauth-store.js";

export interface PendingAuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

const pendingCodes = new Map<string, PendingAuthorizationCode>();

function pruneCodes(now: number): void {
  for (const [code, entry] of pendingCodes) {
    if (entry.expiresAt <= now) pendingCodes.delete(code);
  }
}

/** Issue a short-lived in-memory code. Restarting invalidates every pending code. */
export function issueAuthorizationCode(
  grant: Omit<PendingAuthorizationCode, "expiresAt">,
  now: number,
): string {
  pruneCodes(now);
  const code = generateOAuthSecret("obc_");
  pendingCodes.set(code, {
    ...grant,
    expiresAt: now + AUTH_CODE_TTL_MS,
  });
  return code;
}

/**
 * Single-use consume: delete before the caller validates PKCE/client/resource so
 * a failed exchange cannot retry the same intercepted code.
 */
export function consumeAuthorizationCode(
  code: string,
  now: number,
): PendingAuthorizationCode | undefined {
  pruneCodes(now);
  const entry = code ? pendingCodes.get(code) : undefined;
  if (entry) pendingCodes.delete(code);
  return entry;
}
