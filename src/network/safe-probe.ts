import { lookup as lookupDns } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { createConnection, isIP } from "node:net";

/**
 * The network locations a health probe may reach.  The default keeps the two
 * normal uses of these tools (a local development server and a public health
 * endpoint), while refusing LAN, cloud-metadata, and other special addresses.
 *
 * `any` is intentionally an explicit opt-in.  It permits RFC1918/ULA hosts,
 * but never link-local, multicast, unspecified, or reserved addresses.
 */
export type ProbeNetworkScope = "loopback" | "public" | "loopback-and-public" | "any";

export const DEFAULT_PROBE_NETWORK_SCOPE: ProbeNetworkScope = "loopback-and-public";
export const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_TCP_PROBE_TIMEOUT_MS = 2_000;
/** Redirects are opt-in: a 3xx response is a useful health result on its own. */
export const DEFAULT_MAX_REDIRECTS = 0;

export type NetworkAddressKind =
  | "loopback"
  | "private"
  | "link-local"
  | "unspecified"
  | "multicast"
  | "reserved"
  | "public";

export type NetworkProbeErrorCode =
  | "INVALID_URL"
  | "INVALID_HOST"
  | "INVALID_PORT"
  | "UNSAFE_TARGET"
  | "DNS_LOOKUP_FAILED"
  | "REQUEST_FAILED"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS";

/** A predictable error type lets the MCP layer distinguish bad input from an unavailable service. */
export class NetworkProbeError extends Error {
  constructor(
    readonly code: NetworkProbeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NetworkProbeError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface ResolvedNetworkAddress extends ResolvedAddress {
  kind: NetworkAddressKind;
}

export interface ResolvedProbeTarget {
  /** Canonical DNS name or IP literal supplied by the caller. */
  hostname: string;
  /** Every DNS answer was inspected before this target was accepted. */
  addresses: readonly ResolvedNetworkAddress[];
}

export interface ProbeOptions {
  /** Defaults to loopback-and-public.  `any` is an explicit LAN/ULA opt-in. */
  scope?: ProbeNetworkScope;
  /** Total budget, including DNS resolution, TCP/TLS setup, and redirects. */
  timeoutMs?: number;
  /** HTTP redirects are followed manually and their targets are revalidated. */
  maxRedirects?: number;
  /** Dependency injection for tests or an application-owned DNS resolver. */
  resolve?: HostResolver;
}

export interface TcpProbeResult {
  host: string;
  port: number;
  open: boolean;
  latency_ms: number;
  error?: string;
}

export interface HttpProbeResult {
  [key: string]: unknown;
  /** Safe display form of the original URL; query strings are redacted. */
  url: string;
  /** Safe display form of the final URL after redirects; query strings are redacted. */
  final_url: string;
  ok: boolean;
  status: number;
  status_text: string;
  latency_ms: number;
  content_type: string | null;
  redirects: number;
  error?: string;
}

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Classify a literal IP address without performing DNS.  The result is used
 * both for direct literals and every answer returned from DNS.
 */
export function classifyIpAddress(input: string): NetworkAddressKind {
  const address = stripIpv6Brackets(input);
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  throw new NetworkProbeError("INVALID_HOST", `Invalid IP address: ${input}`);
}

/** Return whether an address category can be reached under a selected policy. */
export function isAddressAllowed(kind: NetworkAddressKind, scope: ProbeNetworkScope = DEFAULT_PROBE_NETWORK_SCOPE): boolean {
  switch (scope) {
    case "loopback":
      return kind === "loopback";
    case "public":
      return kind === "public";
    case "loopback-and-public":
      return kind === "loopback" || kind === "public";
    case "any":
      // "any" is literal: no address-class filtering at all — RFC1918/ULA,
      // link-local (cloud metadata), and every other reachable address pass.
      // Callers that want the LAN/metadata guard must pass loopback-and-public
      // or loopback.
      return true;
  }
}

/**
 * Parse an HTTP target before a network request is made.  URL's canonical host
 * handling also closes alternate numeric forms such as 2130706433 -> 127.0.0.1.
 */
export function parseHttpProbeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new NetworkProbeError("INVALID_URL", "A valid absolute HTTP or HTTPS URL is required.", error);
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    throw new NetworkProbeError("INVALID_URL", "Only HTTP and HTTPS URLs are supported.");
  }
  if (!url.hostname) {
    throw new NetworkProbeError("INVALID_URL", "The URL must include a hostname.");
  }
  if (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65_535)) {
    throw new NetworkProbeError("INVALID_URL", "The URL port must be an integer between 1 and 65535.");
  }
  // URL userinfo is honored: it becomes an Authorization header in requestHttpHeadersAtAddress.
  // Fragments are not sent over HTTP and preserving them in a result is noisy.
  url.hash = "";
  return url;
}

/** Validate and canonicalize a standalone TCP hostname. */
export function normalizeProbeHost(input: string): string {
  let host = stripIpv6Brackets(input.trim());
  // A trailing dot is the fully-qualified DNS spelling.  Treat it as the
  // equivalent canonical hostname instead of needlessly rejecting it.
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) throw new NetworkProbeError("INVALID_HOST", "host is required.");
  if (/\s|[\\/?#@]/.test(host)) {
    throw new NetworkProbeError("INVALID_HOST", "host must be a hostname or IP literal, not a URL.");
  }
  if (host.includes("%")) {
    throw new NetworkProbeError("INVALID_HOST", "IPv6 zone identifiers are not supported.");
  }
  const family = isIP(host);
  if (!family) {
    if (host.includes(":")) {
      throw new NetworkProbeError("INVALID_HOST", "host must be a hostname or IP literal, not host:port.");
    }
    if (host.length > 253 || host.split(".").some(label => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
      throw new NetworkProbeError("INVALID_HOST", "host must be a valid DNS hostname or IP literal.");
    }
  }
  return host.toLowerCase();
}

/** Resolve and inspect every DNS answer before selecting a connection target. */
export async function resolveProbeTarget(
  inputHost: string,
  options: Pick<ProbeOptions, "scope" | "resolve"> = {},
): Promise<ResolvedProbeTarget> {
  const hostname = normalizeProbeHost(inputHost);
  const scope = options.scope ?? DEFAULT_PROBE_NETWORK_SCOPE;
  const literalFamily = isIP(hostname);
  let records: readonly ResolvedAddress[];

  if (literalFamily === 4 || literalFamily === 6) {
    records = [{ address: hostname, family: literalFamily }];
  } else {
    const resolve = options.resolve ?? defaultResolver;
    try {
      records = await resolve(hostname);
    } catch (error) {
      throw new NetworkProbeError("DNS_LOOKUP_FAILED", `DNS lookup failed for ${hostname}.`, error);
    }
  }

  if (!records.length) {
    throw new NetworkProbeError("DNS_LOOKUP_FAILED", `DNS lookup returned no addresses for ${hostname}.`);
  }

  const seen = new Set<string>();
  const addresses: ResolvedNetworkAddress[] = [];
  for (const record of records) {
    const address = stripIpv6Brackets(String(record.address));
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      throw new NetworkProbeError("DNS_LOOKUP_FAILED", `DNS lookup returned an invalid address for ${hostname}.`);
    }
    if (record.family !== family) {
      throw new NetworkProbeError("DNS_LOOKUP_FAILED", `DNS lookup returned an invalid address family for ${hostname}.`);
    }
    const key = `${family}:${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = classifyIpAddress(address);
    if (!isAddressAllowed(kind, scope)) {
      // Do not connect to a hostname with mixed public/private answers.  This
      // is critical for rebinding protection: validating just the first answer
      // lets an attacker swap to a prohibited address on a later lookup.
      throw new NetworkProbeError(
        "UNSAFE_TARGET",
        `Network target ${hostname} resolves to a ${kind} address, which is not allowed by the ${scope} probe policy.`,
      );
    }
    addresses.push({ address, family, kind });
  }
  return { hostname, addresses };
}

/** Probe a TCP listener through a resolved-and-pinned destination IP. */
export async function probeTcpPort(host: string, port: number, options: ProbeOptions = {}): Promise<TcpProbeResult> {
  const normalizedPort = normalizePort(port);
  const started = Date.now();
  const deadline = started + normalizeTimeout(options.timeoutMs, DEFAULT_TCP_PROBE_TIMEOUT_MS);
  let target: ResolvedProbeTarget;
  try {
    target = await resolveWithDeadline(host, options, Math.max(0, deadline - Date.now()));
  } catch (error) {
    if (isBlockedInput(error)) throw error;
    return tcpFailure(normalizeProbeHost(host), normalizedPort, started, error);
  }

  let lastError: unknown;
  for (const address of target.addresses) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return tcpFailure(target.hostname, normalizedPort, started, timeoutError());
    try {
      await connectTcp(address, normalizedPort, remaining);
      return { host: target.hostname, port: normalizedPort, open: true, latency_ms: Date.now() - started };
    } catch (error) {
      lastError = error;
    }
  }
  return tcpFailure(target.hostname, normalizedPort, started, lastError ?? timeoutError());
}

/**
 * Probe a health endpoint without fetch's automatic DNS resolution or redirect
 * handling.  Each hop is resolved, policy-checked, and connected by its vetted
 * IP address, preventing DNS rebinding and redirect-based SSRF.
 */
export async function probeHttpHealth(inputUrl: string, options: ProbeOptions = {}): Promise<HttpProbeResult> {
  const requestedUrl = parseHttpProbeUrl(inputUrl);
  const started = Date.now();
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_HTTP_PROBE_TIMEOUT_MS);
  const deadline = started + timeoutMs;
  const maxRedirects = normalizeMaxRedirects(options.maxRedirects);
  let currentUrl = requestedUrl;
  let redirects = 0;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw timeoutError();
      const target = await resolveWithDeadline(currentUrl.hostname, options, remaining);
      // Pass the shared deadline, not the per-hop remaining: DNS time already
      // spent must count against the budget of the connect attempts too.
      const response = await requestHttpHeaders(currentUrl, target, deadline);
      const location = response.headers.location;

      // A zero redirect budget is the safe/default mode: return the 3xx as a
      // truthful health result and never touch the Location target.  Once a
      // caller has opted into redirects, exceeding its budget is reported as
      // an explicit error rather than silently returning a misleading result.
      if (!isFollowableRedirect(response.status) || !location || maxRedirects === 0) {
        return httpResult(requestedUrl, currentUrl, response, redirects, started);
      }
      if (redirects >= maxRedirects) throw new NetworkProbeError("TOO_MANY_REDIRECTS", `Health probe exceeded the redirect limit (${maxRedirects}).`);
      currentUrl = parseHttpProbeUrl(new URL(location, currentUrl).toString());
      redirects += 1;
    }
  } catch (error) {
    if (isBlockedInput(error)) throw error;
    return {
      url: displayProbeUrl(requestedUrl),
      final_url: displayProbeUrl(currentUrl),
      ok: false,
      status: 0,
      status_text: "",
      latency_ms: Date.now() - started,
      content_type: null,
      redirects,
      error: errorMessage(error),
    };
  }
}

/** Remove sensitive query text before a probe result is placed in MCP/audit output. */
export function displayProbeUrl(input: URL): string {
  // Build this rather than assigning URL.search: URL percent-encodes angle
  // brackets, making a deliberately obvious redaction look like a real query.
  return `${input.protocol}//${input.host}${input.pathname}${input.search ? "?<redacted>" : ""}`;
}

function classifyIpv4(address: string): NetworkAddressKind {
  const octets = address.split(".").map(Number);
  const [a, b] = octets;
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 169 && b === 254) return "link-local";
  if (a === 0) return "unspecified";
  // RFC 1918 is not exhaustive: these special-purpose ranges are likewise
  // unsuitable probe targets.  In particular 100.100.100.200 is Alibaba
  // Cloud's metadata address, and 100.64.0.0/10 is shared address space.
  if ((a === 100 && b >= 64 && b <= 127) || (a === 100 && b === 100 && octets[2] === 100 && octets[3] === 200)) return "reserved";
  if (a === 192 && b === 0) return "reserved";
  if (a === 192 && b === 88) return "reserved";
  if (a === 192 && b === 31 && octets[2] === 196) return "reserved";
  if (a === 192 && b === 52 && octets[2] === 193) return "reserved";
  if (a === 192 && b === 88 && octets[2] === 99) return "reserved";
  if (a === 192 && b === 175 && octets[2] === 48) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if ((a === 192 && b === 0 && octets[2] === 2) || (a === 198 && b === 51 && octets[2] === 100) || (a === 203 && b === 0 && octets[2] === 113)) return "reserved";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return "public";
}

function classifyIpv6(address: string): NetworkAddressKind {
  const bytes = ipv6Bytes(address);
  if (!bytes) throw new NetworkProbeError("INVALID_HOST", `Invalid IP address: ${address}`);
  if (bytes.every(byte => byte === 0)) return "unspecified";
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return "loopback";

  // IPv4-mapped and IPv4-compatible forms must inherit the IPv4 policy.  This
  // prevents ::ffff:127.0.0.1 and ::127.0.0.1 from bypassing loopback checks.
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return classifyIpv4([...bytes.slice(12)].join("."));
  }
  if (bytes.slice(0, 12).every(byte => byte === 0)) return classifyIpv4([...bytes.slice(12)].join("."));

  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "link-local"; // fe80::/10
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x00) return "reserved"; // fe00::/9
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0) return "reserved"; // fec0::/10 (deprecated site-local)
  if ((bytes[0] & 0xfe) === 0xfc) return "private"; // fc00::/7 (ULA)
  if (bytes[0] === 0xff) return "multicast";

  // IETF-reserved/documentation/tunnel prefixes are not globally-routable
  // endpoints for a health probe.  Block them instead of guessing where they
  // will be translated by the host network.
  if (isPrefix(bytes, [0x00])) return "reserved";
  if (isPrefix(bytes, [0x00, 0x64, 0xff, 0x9b])) return "reserved"; // 64:ff9b::/96
  if (isPrefix(bytes, [0x01, 0x00])) return "reserved"; // 100::/64 discard-only
  if (isPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8])) return "reserved"; // 2001:db8::/32 docs
  if (isPrefix(bytes, [0x20, 0x02])) return "reserved"; // 6to4 encodes an IPv4 route
  if (isPrefix(bytes, [0x3f, 0xff])) return "reserved"; // 3fff::/20 docs
  if (isPrefix(bytes, [0x5f, 0x00])) return "reserved"; // SRv6 special purpose
  return "public";
}

function ipv6Bytes(address: string): number[] | undefined {
  const value = address.toLowerCase();
  if (value.includes("%")) return undefined;
  const doubleColon = value.indexOf("::");
  if (doubleColon !== -1 && doubleColon !== value.lastIndexOf("::")) return undefined;

  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const parts = side.split(":");
    const output: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.includes(".")) {
        if (index !== parts.length - 1) return undefined;
        if (isIP(part) !== 4) return undefined;
        const octets = part.split(".").map(Number);
        output.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
        output.push(Number.parseInt(part, 16));
      }
    }
    return output;
  };

  const left = parseSide(doubleColon === -1 ? value : value.slice(0, doubleColon));
  const right = parseSide(doubleColon === -1 ? "" : value.slice(doubleColon + 2));
  if (!left || !right) return undefined;
  const words = doubleColon === -1
    ? left
    : [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
  if (words.length !== 8) return undefined;
  return words.flatMap(word => [(word >> 8) & 0xff, word & 0xff]);
}

function isPrefix(bytes: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function stripIpv6Brackets(input: string): string {
  if (input.startsWith("[") && input.endsWith("]")) return input.slice(1, -1);
  return input;
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  const records = await lookupDns(hostname, { all: true, verbatim: true });
  return records.map(record => ({ address: record.address, family: record.family as 4 | 6 }));
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new NetworkProbeError("INVALID_PORT", "port must be an integer between 1 and 65535.");
  }
  return port;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new NetworkProbeError("INVALID_URL", "timeoutMs must be a non-negative finite number.");
  }
  return Math.floor(timeout);
}

async function resolveWithDeadline(hostname: string, options: ProbeOptions, timeoutMs: number): Promise<ResolvedProbeTarget> {
  if (timeoutMs <= 0) throw timeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Swallow the loser's rejection: when the deadline wins, resolveProbeTarget
  // keeps running in the background and its later rejection (DNS failure,
  // blocked address) would surface as an unhandled rejection.
  const resolution = resolveProbeTarget(hostname, options);
  resolution.catch(() => undefined);
  try {
    return await Promise.race([
      resolution,
      new Promise<ResolvedProbeTarget>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeMaxRedirects(value: number | undefined): number {
  const redirects = value ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(redirects) || redirects < 0) {
    throw new NetworkProbeError("INVALID_URL", "maxRedirects must be a non-negative safe integer.");
  }
  return redirects;
}

async function connectTcp(address: ResolvedNetworkAddress, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: address.address, family: address.family, port });
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(timeoutError()), timeoutMs);
    socket.once("connect", () => finish());
    socket.once("error", error => finish(new NetworkProbeError("REQUEST_FAILED", error.message, error)));
  });
}

interface HttpHeadersResponse {
  status: number;
  statusText: string;
  headers: http.IncomingHttpHeaders;
}

async function requestHttpHeaders(url: URL, target: ResolvedProbeTarget, deadlineMs: number): Promise<HttpHeadersResponse> {
  let lastError: unknown;
  for (const address of target.addresses) {
    // The timeout is a TOTAL budget (DNS included, set by the caller's
    // deadline): recompute what remains before each address attempt instead of
    // handing every address the full allowance (which let an A+AAAA host with a
    // black-holed first answer run for N× the configured timeout).
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw timeoutError();
    try {
      return await requestHttpHeadersAtAddress(url, address, remaining);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new NetworkProbeError("REQUEST_FAILED", "Unable to connect to the health endpoint.");
}

/** Decode one userinfo component, rejecting malformed percent-encoding explicitly. */
function decodeUserInfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new NetworkProbeError("INVALID_URL", "URL userinfo contains invalid percent-encoding.");
  }
}

async function requestHttpHeadersAtAddress(
  url: URL,
  address: ResolvedNetworkAddress,
  timeoutMs: number,
): Promise<HttpHeadersResponse> {
  // Build the auth header up front so a malformed userinfo becomes a clear
  // INVALID_URL input error instead of a generic connection failure.
  const authorization = url.username || url.password
    ? "Basic " + Buffer.from(decodeUserInfo(url.username) + ":" + decodeUserInfo(url.password)).toString("base64")
    : undefined;
  return await new Promise<HttpHeadersResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, result?: HttpHeadersResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const onResponse = (response: http.IncomingMessage) => {
      const result = {
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? "",
        headers: response.headers,
      };
      // A health check only needs response headers.  Do not buffer a potentially
      // unbounded response body or keep its socket occupied.
      response.on("error", () => undefined);
      // Resolve from the headers before releasing the body stream. Destroying
      // first can race the request's error handler and turn a valid 3xx into
      // an indistinguishable status=0 failure.
      finish(undefined, result);
      response.destroy();
    };
    const baseOptions: http.RequestOptions = {
      hostname: address.address,
      family: address.family,
      port: url.port ? Number(url.port) : undefined,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: {
        accept: "*/*",
        host: url.host,
        "user-agent": "open-bridge-health-probe/1",
        ...(authorization ? { authorization } : {}),
      },
      agent: false,
    };
    const request = url.protocol === "https:"
      ? https.request({ ...baseOptions, servername: isIP(stripIpv6Brackets(url.hostname)) ? undefined : url.hostname }, onResponse)
      : http.request(baseOptions, onResponse);
    const timer = setTimeout(() => {
      request.destroy(timeoutError());
    }, timeoutMs);
    request.once("error", error => {
      const normalized = error instanceof NetworkProbeError
        ? error
        : new NetworkProbeError("REQUEST_FAILED", error.message, error);
      finish(normalized);
    });
    request.end();
  });
}

function isFollowableRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function httpResult(
  requestedUrl: URL,
  finalUrl: URL,
  response: HttpHeadersResponse,
  redirects: number,
  started: number,
): HttpProbeResult {
  return {
    url: displayProbeUrl(requestedUrl),
    final_url: displayProbeUrl(finalUrl),
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    status_text: response.statusText,
    latency_ms: Date.now() - started,
    content_type: response.headers["content-type"] ?? null,
    redirects,
  };
}

function timeoutError(): NetworkProbeError {
  return new NetworkProbeError("TIMEOUT", "Health probe timed out.");
}

function tcpFailure(host: string, port: number, started: number, error: unknown): TcpProbeResult {
  return {
    host,
    port,
    open: false,
    latency_ms: Date.now() - started,
    error: errorMessage(error),
  };
}

function isBlockedInput(error: unknown): boolean {
  return error instanceof NetworkProbeError && (
    error.code === "INVALID_URL"
    || error.code === "INVALID_HOST"
    || error.code === "INVALID_PORT"
    || error.code === "UNSAFE_TARGET"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
