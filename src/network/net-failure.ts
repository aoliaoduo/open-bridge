/**
 * Classification of network failures that no amount of retrying can fix
 * (DNS misses, connection refused, TLS/certificate problems). EAI_AGAIN is
 * deliberately NOT here: it means "temporary failure in name resolution"
 * (transient resolver outage / timeout), which retrying CAN heal.
 */
const DETERMINISTIC_NETWORK_CODES = new Set([
  "ENOTFOUND", "ECONNREFUSED",
  // Certificate problems cannot heal by waiting: the cert (or the client's
  // trust store / corporate proxy) must change first. Missing these meant the
  // public-health wait burned its whole budget in exactly the proxy scenario
  // the error text warns about.
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED", "CERT_REVOKED",
]);

/** True when the error chain carries a DNS/refused/TLS code that retrying cannot fix. */
export function isDeterministicNetworkFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; Boolean(current) && depth < 5; depth += 1) {
    const code = (current as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && DETERMINISTIC_NETWORK_CODES.has(code)) return true;
    current = (current as { cause?: unknown } | undefined)?.cause;
  }
  return false;
}
