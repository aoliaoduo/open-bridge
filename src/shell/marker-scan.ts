/**
 * Completion-marker scanning for persistent shell sessions.
 *
 * Extracted from shell-sessions.ts so the CURSOR + CARRY logic can be unit
 * tested without spawning a shell. The scan walks merged output forward from a
 * per-session cursor in bounded chunks, so a marker buried under later output
 * is still found (the old tail-only window missed it and wedged the session).
 *
 * The state is owned by the session and MUST persist across calls: a sentinel
 * line can be split by the 60 ms poll interval just as easily as by a chunk
 * boundary, and only a carry that survives the call can rejoin the halves.
 */
import { scanMarkerExitCode } from "./session-marker.js";

/** Bytes of merged output scanned for a completion marker per pass. */
export const MARKER_SCAN_CHUNK_BYTES = 1024 * 1024;
/** Bytes of the previous scan re-examined by the next one (a marker line is ~50 chars). */
export const MARKER_SCAN_OVERLAP_BYTES = 256;

/** The minimum of ProcessOutputBuffer this scanner needs (injected, so tests need no child process). */
export interface MarkerScanSource {
  state(): { totalBytes: number; bufferStartOffset: number };
  read(offset: number, maxBytes: number): { data: Buffer; endOffset: number };
  tail(maxBytes: number): { data: Buffer };
}

/**
 * Cursor + carry for one session. `carry` is the tail of everything already
 * examined; it is re-prepended to the next chunk so a marker split across the
 * boundary — of a chunk OR of two separate scans — is still matched.
 */
export interface MarkerScanState {
  scannedOffset: number;
  carry: Buffer;
}

export function createMarkerScanState(): MarkerScanState {
  return { scannedOffset: 0, carry: Buffer.alloc(0) };
}

/**
 * Forget any partial sentinel left by a previous command.
 *
 * Called when a new command is submitted: the bytes still in `carry` belong to
 * the command that just finished, and letting them meet the next command's
 * marker text could only produce a spurious match.
 */
export function resetMarkerScanCarry(scan: MarkerScanState): void {
  scan.carry = Buffer.alloc(0);
}

/**
 * Scan forward from the cursor for `marker`, returning its exit code or null.
 *
 * Advances the cursor past whatever was examined and keeps the trailing
 * overlap in `scan.carry` for the NEXT call.
 */
export function scanForMarker(
  source: MarkerScanSource,
  scan: MarkerScanState,
  marker: string,
): number | null {
  const stateNow = source.state();
  let from = Math.max(scan.scannedOffset, stateNow.bufferStartOffset);

  while (from < stateNow.totalBytes) {
    const read = source.read(from, Math.min(MARKER_SCAN_CHUNK_BYTES, stateNow.totalBytes - from));
    if (read.data.length === 0) break;
    scan.scannedOffset = Math.max(scan.scannedOffset, read.endOffset);
    const combined = scan.carry.length > 0 ? Buffer.concat([scan.carry, read.data]) : read.data;
    // Keep the overlap BEFORE returning: a later call must be able to rejoin a
    // sentinel that this one saw only the first half of.
    scan.carry = Buffer.from(combined.subarray(Math.max(0, combined.length - MARKER_SCAN_OVERLAP_BYTES)));
    const code = scanMarkerExitCode(combined.toString("utf8"), marker);
    if (code !== null) return code;
    from = read.endOffset;
  }

  // Nothing new since the cursor was last moved: re-scan the retained tail once
  // so a marker that landed before the cursor ever advanced is still caught.
  if (scan.scannedOffset <= stateNow.bufferStartOffset) {
    const tail = source.tail(MARKER_SCAN_CHUNK_BYTES).data.toString("utf8");
    const code = scanMarkerExitCode(tail, marker);
    if (code !== null) scan.scannedOffset = stateNow.totalBytes;
    return code;
  }
  return null;
}
