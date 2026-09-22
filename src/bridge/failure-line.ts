/**
 * The audit log's failure envelope, in one place.
 *
 * Both dispatch paths — `dispatcher.invoke` and the MCP endpoint's
 * `runToolCall` — write `Failed in <N> ms: <reason>` as the only trace a
 * failed call leaves behind, and two readers strip that prefix again
 * (`diagnostics` error classes and the TUI's operator copy). Template and
 * parser live in this one dependency-free module so a change to the envelope
 * cannot strand either side.
 *
 * The pattern is deliberately the WIDER of the two parsers that existed
 * (`[\d.]+` and a tolerant `m?s`, case-insensitive): it must still strip every
 * line this template has ever produced, including old audit rows if the
 * envelope's formatting ever shifts.
 */

/**
 * Detect (`.test`) or strip (`.replace`) the envelope's prefix; what remains
 * is the reason.
 */
export const FAILURE_LINE_PATTERN = /^Failed in [\d.]+ m?s:\s*/i;

/** The envelope: how long the call ran before failing, then the reason. */
export function failureLine(startedAt: number, reason: string): string {
  return `Failed in ${Date.now() - startedAt} ms: ${reason}`;
}
