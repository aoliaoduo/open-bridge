/**
 * Per-request MCP tracing.
 *
 * The activity log already answers "which tool ran, and did it work". What it
 * could not answer is the transport-level question: which MCP exchange was this,
 * which protocol era served it, how long did the round trip take, and did the
 * client walk away before the response landed. When a remote client reports
 * "the tool call hung", those four facts decide whether the problem is the tool,
 * the transport, or the network — and without them the operator is guessing.
 *
 * The hard constraint here is that a trace must never become a leak. Every field
 * that leaves this module is either a constant from a closed allow-list, a
 * number, or a one-way hash. Specifically:
 *
 *   - MCP method names are allow-listed. A method outside the list is reported
 *     as `"other"`, so a client cannot use the method string as a channel.
 *   - Session ids and tool names are reduced to a short sha256 prefix. They are
 *     still useful for correlating two lines in a log; they are no longer
 *     identifiers an attacker can read back or forge a match against by
 *     guessing.
 *   - Error text is never logged verbatim. Only a hash plus a short, single-line
 *     form of the message is kept, truncated — because error messages routinely
 *     interpolate the very path, command, or argument that triggered them.
 *   - Nothing else from the request is touched: no body, no headers, no
 *     arguments. There is deliberately no "raw" escape hatch.
 *
 * The module is pure (no host, no bridge state, no `node:fs`) so the redaction
 * rules are unit-testable without booting anything.
 */

import { createHash } from "node:crypto";

/**
 * MCP methods worth distinguishing in a trace. Anything else collapses to
 * `"other"`: this list is the allow-list, so an unknown method cannot smuggle
 * text through the field.
 */
export const TRACED_METHODS = [
  "initialize",
  "notifications/initialized",
  "server/discover",
  "tools/list",
  "tools/call",
  "ping",
] as const;

export type TracedMethod = (typeof TRACED_METHODS)[number];

/** Which protocol era served the request. */
export type TracedEra = "modern" | "legacy";

/** The HTTP methods the /mcp surface serves; anything else collapses. */
const TRACED_HTTP_METHODS = ["GET", "POST", "DELETE"] as const;

export type TracedHttpMethod = (typeof TRACED_HTTP_METHODS)[number] | "other";

/**
 * Collapse the HTTP method onto the allow-list. Same rule as the MCP method:
 * a closed set, so the request line cannot become a channel into the log.
 */
export function tracedHttpMethod(value: unknown): TracedHttpMethod {
  if (typeof value !== "string") return "other";
  const candidate = value.toUpperCase();
  return (TRACED_HTTP_METHODS as readonly string[]).includes(candidate)
    ? candidate as TracedHttpMethod
    : "other";
}

/** How the response body was framed, when it could be determined. */
export type TracedFormat = "json" | "sse" | "none";

/**
 * Collapse a method name onto the allow-list.
 *
 * Accepts anything: a body that never parsed, a missing method, a method a
 * client invented. All of those are `"other"`, which is a true statement —
 * something happened and it was not one of the known methods.
 */
export function tracedMethod(value: unknown): TracedMethod | "other" {
  if (typeof value !== "string") return "other";
  const candidate = value.trim();
  return (TRACED_METHODS as readonly string[]).includes(candidate)
    ? (candidate as TracedMethod)
    : "other";
}

/**
 * A stable, non-reversible short id for correlating log lines.
 *
 * Used for session ids and tool names. `null` in, `undefined` out, so the field
 * is simply absent rather than an empty string that looks like a value.
 *
 * The length is a deliberate trade: 12 hex chars is 48 bits, far too short to
 * invert, but more than enough that two distinct sessions in one operator's log
 * will not collide.
 */
export function traceId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

/** Longest single-line error summary kept, in characters. */
export const MAX_ERROR_SUMMARY_CHARS = 160;

/**
 * A safe, bounded one-line summary of an error.
 *
 * Only the message is used — never a stack, never a `cause` chain, because both
 * routinely embed absolute paths and the offending input. Newlines collapse to
 * spaces so one error cannot forge extra log lines, and the result is truncated.
 * The full text is not lost: the caller hashes it separately, and the operator
 * can reproduce the failure deliberately.
 */
export function errorSummary(value: unknown): string | undefined {
  const message = value instanceof Error
    ? value.message
    : typeof value === "string" ? value : "";
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  return oneLine.length > MAX_ERROR_SUMMARY_CHARS
    ? `${oneLine.slice(0, MAX_ERROR_SUMMARY_CHARS)}…`
    : oneLine;
}

/** A stable fingerprint of an error, for grouping repeats in a log. */
export function errorFingerprint(value: unknown): string | undefined {
  const message = value instanceof Error
    ? `${value.name}: ${value.message}`
    : typeof value === "string" ? value : "";
  if (!message) return undefined;
  return createHash("sha256").update(message, "utf8").digest("hex").slice(0, 16);
}

/** How the response was framed, inferred from the content type that was set. */
export function tracedFormat(contentType: unknown): TracedFormat {
  if (typeof contentType !== "string") return "none";
  const value = contentType.toLowerCase();
  if (value.includes("text/event-stream")) return "sse";
  if (value.includes("application/json")) return "json";
  return "none";
}

/** The fields of a completed exchange. Every one is allow-listed, numeric, or hashed. */
export interface ExchangeOutcome {
  method: TracedMethod | "other";
  era: TracedEra;
  /** The HTTP verb, allow-listed — GET/POST answer the endpoint, DELETE ends a session. */
  httpMethod?: TracedHttpMethod;
  httpStatus: number;
  durationMs: number;
  /** True when the client disconnected before the response was fully written. */
  aborted: boolean;
  format: TracedFormat;
  /** Session id, hashed. Absent on the stateless era, which has no session. */
  sessionHash?: string;
  /** Tool name, hashed. Only present for tools/call. */
  toolHash?: string;
  errorFingerprint?: string;
  errorSummary?: string;
}

/**
 * Render an outcome as the single audit line.
 *
 * Kept here rather than in the caller so the redaction rules and the phrasing
 * cannot drift apart, and so the shape is directly testable.
 */
export function exchangeLine(outcome: ExchangeOutcome): string {
  const parts = [
    `${outcome.era}/${outcome.method}`,
    // GET vs POST is the question a silent long-held exchange forces you to
    // ask (a held-open GET stream is by-design, a stuck POST is not); without
    // it the line says "other" and the log answers nothing.
    ...(outcome.httpMethod ? [outcome.httpMethod] : []),
    `HTTP ${outcome.httpStatus}`,
    `${Math.round(outcome.durationMs)}ms`,
    outcome.format === "none" ? "no-body" : outcome.format,
  ];
  if (outcome.sessionHash) parts.push(`session ${outcome.sessionHash}`);
  if (outcome.toolHash) parts.push(`tool ${outcome.toolHash}`);
  if (outcome.aborted) parts.push("client-aborted");
  if (outcome.errorFingerprint) parts.push(`error ${outcome.errorFingerprint}`);
  return parts.join(" · ");
}

/**
 * Decide whether an exchange is worth a line at all.
 *
 * Ordinary successful `ping` and `notifications/initialized` traffic is loud and
 * tells the operator nothing; logging every one of them would bury the exchange
 * that mattered. Failures and aborts are always logged.
 */
export function isNoteworthy(outcome: ExchangeOutcome): boolean {
  if (outcome.aborted || outcome.errorFingerprint) return true;
  if (outcome.httpStatus >= 400) return true;
  return outcome.method !== "ping" && outcome.method !== "notifications/initialized";
}
