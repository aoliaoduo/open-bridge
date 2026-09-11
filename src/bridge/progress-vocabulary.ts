/**
 * The closed vocabulary a progress report may use.
 *
 * `report_progress` takes free text from a model and writes it to the console
 * and the audit log, so its *structured* fields must be a fixed set. Anything
 * outside the set is dropped rather than stored: an open-ended `phase` string
 * would let a model turn the progress surface into a second, unaudited channel
 * for arbitrary content (command lines, file bodies, whatever it just read).
 * A closed vocabulary is what makes "progress carries a phase and a coarse
 * category, never the shell history" a checkable claim instead of a promise.
 *
 * Free text is still allowed and still useful — it is the `message`, which is
 * already subject to the activity log's own redaction and truncation. The point
 * is that the *machine-readable* fields cannot smuggle anything.
 *
 * Kept dependency-free (no host, no bridge state) so both the tool handler and
 * the console can share one definition, and so it is unit-testable directly.
 */

/**
 * Where in its lifecycle the work is. Deliberately coarse: this answers "is it
 * still getting going, or is it doing the thing?" and nothing finer, because
 * finer detail is what starts leaking.
 *
 * Frozen at runtime, not just `as const`: these arrays are the authority the
 * membership checks read, so a stray `push` could widen the accepted set and
 * quietly reopen the channel this module exists to close. `Object.freeze` makes
 * that a thrown TypeError instead of a silent hole.
 */
export const PROGRESS_PHASES: readonly ProgressPhase[] = Object.freeze([
  "queued",
  "preparing",
  "running",
  "verifying",
  "done",
] as const);

export type ProgressPhase = "queued" | "preparing" | "running" | "verifying" | "done";

/**
 * What kind of work this is, for a progress badge. Also coarse: "a read", "a
 * write", "a command", "a test", "a build". Not a command name, not a path.
 */
export const PROGRESS_CATEGORIES: readonly ProgressCategory[] = Object.freeze([
  "read",
  "edit",
  "command",
  "test",
  "build",
  "other",
] as const);

export type ProgressCategory = "read" | "edit" | "command" | "test" | "build" | "other";

/** Progress log levels, matching the MCP logging levels this surface forwards. */
export const PROGRESS_LEVELS: readonly ProgressLevel[] = Object.freeze([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
] as const);

export type ProgressLevel = "debug" | "info" | "notice" | "warning" | "error";

function inSet<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** True when `value` is one of the five lifecycle phases. */
export function isProgressPhase(value: unknown): value is ProgressPhase {
  return inSet(value, PROGRESS_PHASES);
}

/** True when `value` is one of the six work categories. */
export function isProgressCategory(value: unknown): value is ProgressCategory {
  return inSet(value, PROGRESS_CATEGORIES);
}

/** True when `value` is one of the five MCP logging levels. */
export function isProgressLevel(value: unknown): value is ProgressLevel {
  return inSet(value, PROGRESS_LEVELS);
}

/**
 * Coerce a caller-supplied value into the vocabulary, or `undefined`.
 *
 * Returning `undefined` (rather than a default) is the point: a caller that
 * sends something unrecognised gets no field at all, so nothing is invented and
 * nothing arbitrary is stored. Values are matched case-insensitively and
 * trimmed, because "Running " and "running" are the same intent and rejecting
 * them would only teach callers to retry.
 */
export function normalizePhase(value: unknown): ProgressPhase | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  return isProgressPhase(candidate) ? candidate : undefined;
}

/** Coerce a work category, or `undefined` when it is outside the vocabulary. */
export function normalizeCategory(value: unknown): ProgressCategory | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  return isProgressCategory(candidate) ? candidate : undefined;
}

/**
 * Coerce a log level, defaulting to "info".
 *
 * This one DOES have a default, unlike the others: a log level must always be
 * chosen to emit anything, "info" is already the documented default, and a
 * missing level is not a caller trying to send something arbitrary.
 */
export function normalizeLevel(value: unknown): ProgressLevel {
  if (typeof value !== "string") return "info";
  const candidate = value.trim().toLowerCase();
  return isProgressLevel(candidate) ? candidate : "info";
}
