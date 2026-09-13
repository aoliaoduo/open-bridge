/**
 * Compact, redacted argument summaries for the audit log (T-1).
 *
 * Pure module with no bridge-state imports (same pattern as batch-plan.ts),
 * so the formatting rules stay unit-testable in plain node. The redactor is
 * injected by the caller (dispatcher passes state.redactSensitiveText); tests
 * pass a fake. Design decisions, kept as documented boundaries:
 *
 * - Big payload keys (content, content_base64, patch, new_text, old_text) are
 *   replaced with a char-count placeholder so large bodies never hit the log.
 * - Redaction runs BEFORE any truncation: a long command that embeds a public
 *   URL or route token is scrubbed first, so the length caps can never leak a
 *   truncated-but-still-identifying secret prefix (T-1 live acceptance catch).
 * - String values are truncated at 80 chars; the whole summary at 300 chars.
 * - Nested objects/arrays are expanded to depth 2, then collapsed to a size
 *   placeholder ({...} / [N items]) — enough to answer "what was this call
 *   about" without echoing nested payloads.
 */

export const ARGS_SUMMARY_MAX_CHARS = 300;
const MAX_STRING_VALUE_CHARS = 80;

const BIG_VALUE_KEYS = new Set(["content", "content_base64", "patch", "new_text", "old_text"]);

/**
 * Serialize one value for the summary. `depth` starts at 1 for top-level
 * properties; objects/arrays deeper than 2 levels collapse to a size marker.
 * String values are redacted first, then truncated.
 */
function serializeValue(value: unknown, depth: number, key: string, redact: (text: string) => string): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (BIG_VALUE_KEYS.has(key)) return `<len:${value.length} chars>`;
    const redacted = redact(value);
    return redacted.length > MAX_STRING_VALUE_CHARS
      ? `"${redacted.slice(0, MAX_STRING_VALUE_CHARS)}…"`
      : `"${redacted}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (depth >= 2) return `[${value.length} items]`;
    const shown = value.slice(0, 4).map(item => serializeValue(item, depth + 1, "", redact)).join(", ");
    return `[${shown}${value.length > 4 ? ", …" : ""}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (depth >= 2) return "{...}";
    const shown = entries.slice(0, 6).map(([k, v]) => `${k}:${serializeValue(v, depth + 1, k, redact)}`).join(", ");
    return `{${shown}${entries.length > 6 ? ", …" : ""}}`;
  }
  return String(value);
}

/**
 * Build a one-line argument summary for the audit log, or undefined for empty
 * input (record() then omits the field, keeping old log lines parseable).
 * The redactor runs on every string value before truncation, plus once over
 * the assembled text as a safety net, before the final length cap.
 */
export function buildArgsSummary(
  args: Record<string, unknown> | undefined | null,
  redact: (text: string) => string = (text: string) => text,
): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const keys = Object.keys(args);
  if (keys.length === 0) return undefined;
  const parts = keys.map(key => `${key}:${serializeValue(args[key], 1, key, redact)}`);
  let summary = redact(`{${parts.join(", ")}}`);
  if (summary.length > ARGS_SUMMARY_MAX_CHARS) {
    summary = `${summary.slice(0, ARGS_SUMMARY_MAX_CHARS)}…`;
  }
  return summary;
}
