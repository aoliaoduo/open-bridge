/**
 * Where a caller's read starts, and whether anything is left to read there.
 *
 * `read_process_output`'s long-poll has to answer one question: "does THIS
 * caller already have output waiting?" The buffer's own `availableBytes` cannot
 * answer it — that is how many bytes the buffer still retains, which stays
 * positive forever once a process has printed anything, regardless of how far
 * the caller has already read. Using it as the predicate meant the wait was
 * skipped for every process that had ever produced output, i.e. every process
 * anyone actually wants to follow, and the long-poll silently degraded into the
 * busy-poll it exists to replace.
 *
 * The honest predicate compares the caller's absolute offset with the total
 * number of bytes the stream has produced. Pure module: no host, no state.
 */

/** The fields of ProcessOutputBuffer.state() this module reads. */
export interface OutputCursorState {
  totalBytes: number;
  bufferStartOffset: number;
}

/**
 * Resolve the absolute offset a read will start at.
 *
 * An omitted offset means "the start of the retained window", matching
 * `outputRead`. A malformed offset resolves to that same default here: this
 * function only decides whether to WAIT, and `outputRead` is what validates and
 * rejects the argument moments later — guessing differently would only change
 * which error the caller gets.
 */
export function resolveReadOffset(offsetArg: unknown, state: OutputCursorState): number {
  if (offsetArg === undefined) return state.bufferStartOffset;
  const offset = Number(offsetArg);
  if (!Number.isSafeInteger(offset) || offset < 0) return state.bufferStartOffset;
  return offset;
}

/**
 * True when the stream has produced bytes this caller has not read yet.
 *
 * An offset at or past `totalBytes` means the caller is caught up, which is
 * exactly when a long-poll should block. An offset beyond the end (a caller
 * that over-read, or a buffer that was reset) counts as caught up too.
 */
export function hasUnreadOutput(offset: number, state: OutputCursorState): boolean {
  return offset < state.totalBytes;
}
