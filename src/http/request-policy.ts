/**
 * Build the Host-header allowlist for a Bridge instance bound to loopback.
 * The optional public domain is admitted because tunnel providers may preserve
 * it while forwarding requests to the local listener.
 */
export function bridgeAllowedHosts(port: number, publicDomain = ""): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("Bridge port must be an integer between 1 and 65535.");
  }
  const domain = publicDomain.trim().toLowerCase();
  return [...new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    domain,
    domain ? `${domain}:443` : "",
  ].filter(Boolean))];
}

export function isAllowedBridgeHost(host: unknown, port: number, publicDomain = ""): boolean {
  return typeof host === "string" && bridgeAllowedHosts(port, publicDomain).includes(host.trim().toLowerCase());
}

export function validateNgrokDomain(value: unknown): string {
  const domain = typeof value === "string" ? value.trim().toLowerCase() : "";
  const labels = domain.split(".");
  if (!domain || domain.length > 253 || labels.some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    throw new Error("ngrokDomain must be a valid hostname.");
  }
  return domain;
}
