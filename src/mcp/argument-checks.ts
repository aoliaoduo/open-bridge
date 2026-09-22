/**
 * Shared runtime validators for MCP tool arguments.
 *
 * The same contract is enforced at several entry points (read_process_output,
 * interact_with_process, read_service_log, read_files, ...) that must refuse
 * with byte-identical messages — a client retrying the same call against a
 * different tool should never learn a different rule. One small leaf module,
 * imported by the bridge tool modules, keeps those messages from drifting.
 * Pure functions, no imports, so they stay unit-testable on their own.
 */

/**
 * Validate a process-output stream choice (`merged`, `stdout` or `stderr`),
 * returning it unchanged. Callers pass the raw coercion result, so the
 * refusal — not a silent fallback to `merged` — is what a typo'd stream gets.
 */
export function requireValidStream(stream: string): string {
  if (!["merged", "stdout", "stderr"].includes(stream)) {
    throw new Error('stream must be one of: merged, stdout, stderr.');
  }
  return stream;
}

/**
 * Validate a byte offset after the caller's `Number()` coercion, returning it
 * unchanged. `Number("abc")` is NaN and a negative offset reads before the
 * buffer start, so both are refused with the message every offset consumer
 * shares.
 */
export function requireValidOffset(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("offset must be a non-negative safe integer.");
  }
  return value;
}
