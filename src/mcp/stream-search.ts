/**
 * Streaming, batched text search over a single file.
 *
 * The file is consumed as a line stream (never fully materialized), lines are
 * matched in batches by a caller-supplied matcher — which may evaluate user
 * regexes inside an isolated worker (see regex-worker.ts) — and matches carry
 * optional before/after context gathered incrementally. Pure module with no
 * bridge state access.
 */
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Bytes probed for a NUL before scanning. Real binaries (and most archives)
 * contain one in the first chunk, so they are skipped the way ripgrep skips
 * them instead of being streamed as multi-megabyte "lines".
 */
const BINARY_PROBE_BYTES = 65_536;

/**
 * Hard cap on one line. readline buffers a whole line before yielding it, so a
 * minified bundle or any newline-less file materialized the ENTIRE file in
 * memory (and again inside the regex worker). Lines past this cap are kept as
 * line numbers only: the tail is discarded instead of buffered.
 */
const MAX_LINE_CHARS = 1 << 20;

/**
 * Total characters one matcher batch may carry. Each batch is structured-
 * cloned into a fresh worker, so 500 × 1 MiB lines meant a ~0.5 GB clone
 * spike when regex-searching long-line (minified) files. Batches are split
 * again by this budget before they reach the worker.
 */
const BATCH_CHAR_BUDGET = 4 * 1024 * 1024;

export interface StreamSearchMatch {
  /** 1-based line number. */
  line: number;
  text: string;
  context_before: string[];
  context_after: string[];
}

export interface StreamSearchOptions {
  /** Maximum matches to emit. */
  limit: number;
  /** Context lines to collect on each side (0 disables context). */
  contextLines: number;
  /** Lines per matcher batch (default 500). */
  batchLines?: number;
}

/** Match a batch of lines, returning the matching indices within the batch. */
export type BatchMatcher = (lines: string[]) => Promise<number[]>;

/**
 * True when the file looks binary: a NUL byte inside the first 64 KiB.
 * ripgrep skips such files by default; the fallback scanner must do the same
 * instead of streaming them as one enormous "line".
 */
async function looksBinary(file: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(file, "r");
    const { size } = await handle.stat();
    const probe = Buffer.alloc(Math.min(BINARY_PROBE_BYTES, size));
    if (probe.length === 0) return false;
    await handle.read(probe, 0, probe.length, 0);
    return probe.indexOf(0) !== -1;
  } catch {
    return false; // unreadable files are the caller's problem, not a false "binary"
  } finally {
    await handle?.close();
  }
}

/**
 * Yield the file's lines without ever holding more than one line in memory.
 * readline buffers a full line before yielding it, so a newline-less file
 * (minified bundle, giant log record) materialized the whole file — twice, once
 * for the scanner and once inside the matcher worker. Lines past
 * MAX_LINE_CHARS are truncated and their tail discarded.
 */
async function* iterateLines(file: string): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let line = "";
  let truncated = false;
  const take = (): string => {
    let text = line;
    line = "";
    truncated = false;
    // A CRLF whose \r and \n land in different stream chunks leaves the CR on
    // the yielded line (the piece-based strip below only fires when both bytes
    // are in the same chunk); a stray \r in `text` breaks exact-match clients.
    if (text.endsWith("\r")) text = text.slice(0, -1);
    return text;
  };
  const append = (piece: string): void => {
    if (truncated) return; // tail of an over-long line: consume, never buffer
    line += piece;
    if (line.length > MAX_LINE_CHARS) {
      line = line.slice(0, MAX_LINE_CHARS);
      truncated = true;
    }
  };
  for await (const chunk of fs.createReadStream(file)) {
    let text = decoder.write(chunk as Buffer);
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n")) {
      let piece = text.slice(0, nl);
      if (piece.endsWith("\r")) piece = piece.slice(0, -1); // CRLF is one break
      append(piece);
      yield take();
      text = text.slice(nl + 1);
    }
    append(text);
  }
  append(decoder.end());
  if (line.length > 0) yield take();
}

/**
 * Search `file` line by line, emitting up to `limit` matches via `onMatch`.
 * Returning false from `onMatch` stops the scan early. Resolves with the
 * number of emitted matches. Binary files are skipped (0 matches).
 */
export async function searchFileStream(
  file: string,
  matcher: BatchMatcher,
  options: StreamSearchOptions,
  onMatch: (match: StreamSearchMatch) => boolean | void,
): Promise<number> {
  // Binary content has no meaningful lines: skip it the way ripgrep does.
  if (await looksBinary(file)) return 0;
  const limit = Math.max(options.limit, 0);
  const contextLines = Math.max(options.contextLines, 0);
  const batchSize = Math.max(options.batchLines ?? 500, 1);

  let emitted = 0;
  let stopped = false;
  const pending: StreamSearchMatch[] = [];
  const before: string[] = [];

  const emitReady = (): void => {
    while (!stopped && pending.length > 0 && pending[0].context_after.length >= contextLines) {
      const match = pending.shift()!;
      emitted += 1;
      if (onMatch(match) === false) stopped = true;
    }
  };

  const accepting = (): boolean => emitted + pending.length < limit;
  const needsMoreLines = (): boolean =>
    !stopped && (accepting() || pending.some(m => m.context_after.length < contextLines));

  let batch: string[] = [];
  let batchStartLine = 0;
  let lineNo = 0;

  const processBatch = async (): Promise<void> => {
    if (batch.length === 0) return;
    const lines = batch;
    const start = batchStartLine;
    batch = [];
    // Once the limit is reached we only feed context_after; skip matching.
    const indices = new Set<number>();
    if (accepting()) {
      // Split oversized batches by total characters: the whole slice is
      // structured-cloned into a worker, and long-line files made that clone
      // hundreds of megabytes. Index space is the batch's, so sub-results
      // re-offset to the full batch.
      let from = 0;
      while (from < lines.length) {
        let end = from;
        let chars = 0;
        while (end < lines.length) {
          const len = lines[end].length + 1;
          if (chars + len > BATCH_CHAR_BUDGET && end > from) break;
          chars += len;
          end += 1;
        }
        for (const i of await matcher(lines.slice(from, end))) indices.add(from + i);
        from = end;
      }
    }
    for (let i = 0; i < lines.length && needsMoreLines(); i += 1) {
      const text = lines[i];
      for (const m of pending) {
        if (m.context_after.length < contextLines) m.context_after.push(text);
      }
      emitReady();
      if (indices.has(i) && accepting()) {
        pending.push({ line: start + i, text, context_before: before.slice(), context_after: [] });
      }
      before.push(text);
      if (before.length > contextLines) before.shift();
    }
  };

  // Breaking out of the loop returns the generator, which destroys the read
  // stream — no descriptor can leak when the limit is hit early.
  for await (const text of iterateLines(file)) {
    if (!needsMoreLines()) break;
    lineNo += 1;
    if (batch.length === 0) batchStartLine = lineNo;
    batch.push(text);
    if (batch.length >= batchSize) await processBatch();
  }
  await processBatch();

  // EOF: remaining matches flush with whatever context_after was gathered.
  while (!stopped && pending.length > 0) {
    const match = pending.shift()!;
    emitted += 1;
    if (onMatch(match) === false) stopped = true;
  }
  return emitted;
}
