/**
 * Streaming, line-oriented file reading for read_files.
 *
 * Instead of reading an entire (possibly huge) file into memory and slicing it,
 * we walk the file as a UTF-8 byte stream, keep only the requested lines, and
 * stop as soon as we have enough — turning a 2 GB log + "give me lines 5-10"
 * request from O(file size) memory/time into O(requested range).
 *
 * Lines are split on the raw 0x0A byte, so CRLF files keep their "\r\n" EOL
 * byte-for-byte. Splitting on bytes (not decoded strings) means a multibyte
 * UTF-8 sequence straddling a chunk boundary is never corrupted. Byte budgets
 * are enforced in UTF-8 bytes and truncation never splits a multibyte character.
 */
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

/** Bytes past an end_line stop that are still streamed (small tail ⇒ whole-file hash). */
const END_LINE_HASH_TAIL_BYTES = 8 * 1024 * 1024;

/**
 * How many bytes past the caller's budget a newline-less line may grow before it
 * is decided. A line with no terminator has no natural bound, so without this
 * the whole file was resident before the budget could truncate it.
 *
 * Sized like the ready-pattern window: far more than any returnable prefix needs,
 * far less than a file that would be a problem to hold.
 */
const PENDING_OVERFLOW_BYTES = 64 * 1024;

export interface StreamReadOptions {
  /** 1-based inclusive first line to return (default 1). */
  startLine?: number;
  /** 1-based inclusive last line to return (default: up to the byte budget). */
  endLine?: number;
  /** Maximum UTF-8 bytes to return; collection stops once exceeded. */
  maxBytes: number;
}

export interface StreamReadResult {
  content: string;
  /** Total line count; null when reading stopped early (end_line reached / budget) so EOF was never seen. */
  lines_total: number | null;
  lines_returned: number;
  start_line: number;
  end_line: number;
  bytes_total: number;
  bytes_returned: number;
  /** True when the byte budget was hit before all (remaining) lines were read. */
  byte_truncated: boolean;
  /** sha256 of the whole file, but only when it was fully read; otherwise null. */
  sha256: string | null;
  /** True only if the stream reached EOF (read the whole file). */
  reached_eof: boolean;
  binary: boolean;
}

export class BinaryFileError extends Error {
  constructor() {
    super("binary file");
    this.name = "BinaryFileError";
  }
}

/**
 * Truncate a JS string so its UTF-8 encoding fits within `maxBytes`, never
 * slicing through a multibyte sequence. Walks code points and stops before the
 * first code point that would overflow the byte budget.
 */
export function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes < 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/** True when `byte` is a UTF-8 continuation byte (10xxxxxx). */
function isUtf8Continuation(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

/**
 * Return the longest prefix of `buf` that is valid standalone UTF-8 and no
 * longer than `maxBytes`. When the cut would land inside a multibyte
 * character, the whole character is excluded so decoding the returned prefix
 * never produces a U+FFFD artifact at the boundary.
 */
export function utf8SafePrefix(buf: Buffer, maxBytes: number): Buffer {
  const limit = Math.min(buf.length, Math.max(0, maxBytes));
  if (limit <= 0 || limit >= buf.length) return buf.subarray(0, limit);
  // Walk back over trailing continuation bytes to find the lead byte of a
  // character that might straddle the cut.
  // Both indices are in range here (limit < buf.length, leadIndex >= 0). The
  // `?? 0` fallbacks read as "not a UTF-8 lead or continuation byte", which
  // makes both checks fall through to the plain cut — the safe answer, and the
  // one that cannot produce a half character.
  let back = 0;
  while (back < 3 && limit - 1 - back >= 0 && isUtf8Continuation(buf[limit - 1 - back] ?? 0)) back += 1;
  const leadIndex = limit - 1 - back;
  if (leadIndex >= 0) {
    const byte = buf[leadIndex] ?? 0;
    if (byte >= 0xc0 && byte <= 0xfd) {
      const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
      if (leadIndex + length > limit) return buf.subarray(0, leadIndex);
    }
  }
  return buf.subarray(0, limit);
}

/** Validate and normalize a 1-based inclusive [start, end] line range. */
export function resolveLineRange(startLine?: number, endLine?: number): { start: number; end: number | null } {
  const start = startLine === undefined || startLine === null ? 1 : Number(startLine);
  if (!Number.isInteger(start) || start < 1) {
    throw new Error("start_line must be a positive integer (1-based).");
  }
  let end: number | null = null;
  if (endLine !== undefined && endLine !== null) {
    end = Number(endLine);
    if (!Number.isInteger(end) || end < 1) {
      throw new Error("end_line must be a positive integer (1-based).");
    }
    if (end < start) {
      throw new Error("end_line must be greater than or equal to start_line.");
    }
  }
  return { start, end };
}

/**
 * Stream a text file, collecting only the requested lines.
 *
 * `sizeHint` (from fs.stat) supplies bytes_total without forcing a full read.
 * The whole-file sha256 / lines_total are returned only when the stream reached
 * EOF; on an early stop they are null so callers never report a hash or count
 * that does not match the file on disk.
 */
export function streamReadLines(
  filePath: string,
  opts: StreamReadOptions,
  sizeHint = 0,
): Promise<StreamReadResult> {
  const { start, end } = resolveLineRange(opts.startLine, opts.endLine);
  const maxBytes = Math.max(0, opts.maxBytes);

  return new Promise<StreamReadResult>((resolveP, rejectP) => {
    const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const hash = createHash("sha256");
    const B = (v: unknown): Buffer => Buffer.isBuffer(v) ? (v as Buffer) : Buffer.from(v as string);
    let settled = false;
    let pending: Buffer = Buffer.alloc(0);   // bytes carried across chunks (current partial line)
    let collected = "";
    let collectedBytes = 0;
    let lineNo = 0;
    let returnedStart = -1;
    let returnedEnd = -1;
    let returnedCount = 0;
    let stoppedEarly = false;
    /**
     * True when collection stopped because end_line was reached AND the
     * remaining tail is small enough to justify streaming on: the stream then
     * reaches EOF and the whole-file sha256 is reported. The schema promises
     * that hash for optimistic writes, and a ranged read of lines
     * 1..last-line used to destroy the stream one line early and omit it.
     * A genuinely large remainder keeps the early stop (a "lines 5-10 of a
     * 2 GB log" read must not become a full-file scan just for a hash).
     */
    let stoppedByEndLine = false;
    /**
     * True while the tail of an over-long line the range does not want is being
     * flushed. Its line NUMBER was counted when the prefix was dropped, so the
     * newline that ends it must not count a second time.
     */
    let discardingLineTail = false;
    let consumedBytes = 0;
    let binary = false;

    const settle = (result: StreamReadResult) => {
      if (settled) return;
      settled = true;
      resolveP(result);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      rejectP(err);
    };

    /**
     * Account for one line.
     *
     * `overflow` means the line was longer than this reader was willing to
     * buffer and has been cut to a returnable prefix: the bytes on the far side
     * of that cut are deliberately never read, so parsing must stop here. It is
     * an explicit parameter because the in-range budget branch below only infers
     * "stop" from its own byte comparison, and a line already trimmed to fit no
     * longer trips that comparison — that inference is exactly how an over-long
     * single-line file ended up being scanned to EOF with every following line
     * appended to the answer.
     */
    const handleLine = (lineBuf: Buffer, overflow = false): void => {
      if (lineBuf.includes(0)) { binary = true; throw new BinaryFileError(); }
      lineNo += 1;
      const inRange = lineNo >= start && (end === null || lineNo <= end);
      if (inRange && !stoppedEarly) {
        const lineBytes = lineBuf.length;
        if (collectedBytes + lineBytes > maxBytes && returnedCount === 0) {
          // The FIRST requested line alone exceeds the byte budget. Buffering
          // the whole (potentially hundreds of MB) line before truncating
          // would make this "O(requested range)" read O(line size); keep only
          // a bounded UTF-8-safe prefix instead and stop.
          const budget = Math.max(0, maxBytes - collectedBytes);
          if (budget > 0) {
            const keep = utf8SafePrefix(lineBuf, budget).toString("utf8");
            // A genuine non-UTF-8 line (legacy GBK/Latin-1 etc.) decodes to
            // U+FFFD replacements: hand it to the binary path instead of
            // returning mojibake the caller might write back over the file.
            if (keep.includes("\uFFFD")) { binary = true; throw new BinaryFileError(); }
            if (keep) {
              if (returnedStart < 0) returnedStart = lineNo;
              collected += keep;
              collectedBytes += Buffer.byteLength(keep, "utf8");
              returnedEnd = lineNo;
              returnedCount = 1;
            }
          }
          stoppedEarly = true;
        } else if (collectedBytes + lineBytes > maxBytes) {
          stoppedEarly = true;   // overshoot: keep what we have, stop collecting
        } else {
          const decoded = lineBuf.toString("utf8");
          // Same non-UTF-8 detection as the budget path: any replacement
          // character means the bytes are not valid UTF-8, so report this file
          // as binary rather than returning mojibake the caller could later
          // write back over the original bytes.
          if (decoded.includes("\uFFFD")) { binary = true; throw new BinaryFileError(); }
          if (returnedStart < 0) returnedStart = lineNo;
          collected += decoded;
          collectedBytes += lineBytes;
          returnedEnd = lineNo;
          returnedCount += 1;
        }
      }
      if (overflow) {
        // The rest of this line was never read, so nothing after it can be
        // reported: stop collecting and stop scanning.
        stoppedEarly = true;
        return;
      }
      if (end !== null && lineNo >= end) {
        stoppedEarly = true;
        // Stream on to EOF only when the un-read tail is small: the common
        // "read to the last line" case then still reports the whole-file
        // hash, while a deep range into a huge file keeps its early stop.
        const remaining = sizeHint - consumedBytes;
        if (remaining <= END_LINE_HASH_TAIL_BYTES) stoppedByEndLine = true;
      }
    };

    stream.on("data", (chunk: unknown) => {
      try {
        const buf = B(chunk);
        hash.update(buf);
        consumedBytes += buf.length;
        pending = (pending.length ? Buffer.concat([pending, buf]) : buf) as Buffer;
        let nl: number;
        while ((nl = pending.indexOf(0x0a)) !== -1) {
          const lineBuf = pending.subarray(0, nl + 1);   // include the "\n" (and any preceding "\r")
          pending = pending.subarray(nl + 1);
          if (discardingLineTail) {
            // This newline ends the over-long line whose prefix was dropped. The
            // line is counted HERE, because the prefix never reached handleLine.
            // A single chunk can legitimately contain the run's tail AND several
            // following lines, so only one line may be consumed — treating the
            // whole buffer as that tail skipped the very lines the caller asked
            // for, which is why this consumes up to the first newline and loops.
            discardingLineTail = false;
            lineNo += 1;
            if (end !== null && lineNo >= end) {
              stoppedEarly = true;
              break;
            }
            continue;
          }
          handleLine(lineBuf);
          if (binary) { stream.destroy(); return; }
          // A byte-budget stop needs no more bytes; a small-remainder end_line
          // stop keeps streaming so the whole-file hash can still be reported.
          if (stoppedEarly && !stoppedByEndLine) { stream.destroy(); return; }
        }
        // No newline in what we have, and more bytes than any answer could need.
        //
        // The budget and `utf8SafePrefix` only ever ran from inside handleLine,
        // i.e. only once a WHOLE line had been buffered — so a file whose line
        // has no newline at all was accumulated in full before being truncated.
        // Measured: a 64 MiB single-line file read with max_bytes=1024 answered
        // correctly but grew RSS by ~137 MiB. With the shipped 512 KiB default,
        // a 500 MiB minified bundle or one giant JSONL record cost 500 MiB per
        // path in `paths`, contradicting this module's promise of
        // O(requested range) memory for a small range in a huge file.
        //
        // One line can be longer than any answer, so no newline is coming soon.
        if (pending.length > maxBytes + PENDING_OVERFLOW_BYTES) {
          if (lineNo + 1 < start) {
            // Ahead of the range: keep only the stream position, so the line
            // counts exactly once — when the newline bytes that follow are seen
            // if they were already read, or when the next chunk supplies them.
            pending = Buffer.alloc(0);
            discardingLineTail = true;
            return;
          }
          // Wanted, or the range is open-ended: keep the returnable prefix and
          // stop. Bytes past it are never decoded.
          stopOverlongLine();
          stream.destroy();
          return;
        }
      } catch (e) {
        if (e instanceof BinaryFileError) { binary = true; stream.destroy(); return; }
        stream.destroy();
        fail(e);
      }
    });

    /**
     * Finish an over-long line that has no newline to delimit it.
     *
     * The bytes handed to handleLine stop at the last returnable character
     * boundary, so a multibyte character is never split; the remaining bytes of
     * that line are never decoded at all.
     */
    const stopOverlongLine = (): void => {
      const keep = utf8SafePrefix(pending, Math.min(pending.length, maxBytes));
      pending = keep;
      handleLine(keep, true);
    };

    const finalize = (): void => {
      if (binary) { fail(new BinaryFileError()); return; }
      // The pending unterminated tail must be counted whenever EOF was reached
      // honestly - including the stoppedByEndLine case, where the stream ran
      // on to EOF precisely so the whole-file numbers stay reportable. The old
      // `!stoppedEarly` guard skipped it there, and every count below was one
      // short for a file without a trailing newline.
      if (pending.length > 0 && (!stoppedEarly || stoppedByEndLine)) {
        try { handleLine(pending); }
        catch (e) { if (e instanceof BinaryFileError) { fail(e); return; } throw e; }
      }
      const fullyRead = !stoppedEarly || stoppedByEndLine;
      settle({
        content: collected,
        lines_total: fullyRead ? lineNo : null,
        lines_returned: returnedCount,
        start_line: returnedStart < 0 ? start : returnedStart,
        end_line: returnedEnd < 0 ? (end ?? Math.max(lineNo, 1)) : returnedEnd,
        bytes_total: sizeHint,
        bytes_returned: collectedBytes,
        byte_truncated: stoppedEarly && !stoppedByEndLine && end === null && returnedCount > 0,
        sha256: fullyRead ? hash.digest("hex") : null,
        reached_eof: true,
        binary: false,
      });
    };

    stream.on("end", finalize);
    stream.on("close", () => {
      if (settled) return;
      // destroy() after an intentional early stop / binary hit may not emit "end"; settle here.
      if (binary) { fail(new BinaryFileError()); return; }
      if (stoppedEarly) {
        settle({
          content: collected,
          lines_total: null,
          lines_returned: returnedCount,
          start_line: returnedStart < 0 ? start : returnedStart,
          end_line: returnedEnd < 0 ? (end ?? lineNo) : returnedEnd,
          bytes_total: sizeHint,
          bytes_returned: collectedBytes,
          byte_truncated: end === null && returnedCount > 0,
          sha256: null,
          reached_eof: false,
          binary: false,
        });
      }
    });
    stream.on("error", (err) => {
      // Our own destroy() surfaces as premature-close on some runtimes; ignore that.
      if (stoppedEarly || binary) return;
      fail(err);
    });
  });
}

