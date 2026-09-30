import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { streamReadLines, truncateToUtf8Bytes } from "../../mcp/stream-read.js";
import { requireValidOffset } from "../../mcp/argument-checks.js";
import { DEFAULT_MAX_READ_BYTES } from "../state.js";
import { securePath } from "../paths.js";
import { enrichFsError } from "./error-hints.js";
import type { JsonArgs } from "./json-args.js";

type Args = JsonArgs;

/**
 * Whole-file reads of auto-detected binary / base64 content stay below this
 * cap; larger targets are served as a max_bytes-bounded head so a stray stat
 * of a multi-GB file can never balloon Bridge-process memory.
 */
const WHOLE_BINARY_READ_CAP = 64 * 1024 * 1024;

/** read_files accepts at most this many paths per call (schema advertises the same bound). */
const MAX_READ_PATHS = 20;
/** How many of those paths are read concurrently; each base64 row can pin ~150 MB. */
const READ_FILES_CONCURRENCY = 4;

/**
 * Read one bounded byte page without buffering the whole file. Binary/base64
 * callers use the returned offset as an actual continuation cursor.
 */
async function readBytesAt(
  fullPath: string,
  size: number,
  offset: number,
  maxBytes: number,
): Promise<{ buf: Buffer; offset: number; truncated: boolean }> {
  const start = Math.max(0, Math.min(offset, size));
  const want = Math.min(size - start, Math.max(0, maxBytes));
  if (want === 0) return { buf: Buffer.alloc(0), offset: start, truncated: start < size };
  const handle = await fs.open(fullPath, "r");
  try {
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const read = await handle.read(buf, got, want - got, start + got);
      if (read.bytesRead === 0) break;
      got += read.bytesRead;
    }
    const data = got === want ? buf : buf.subarray(0, got);
    return { buf: data, offset: start, truncated: start + got < size };
  } finally {
    await handle.close();
  }
}

/** Resolve a base64 response for a (possibly huge) file without unbounded memory. */
async function readAsBase64(
  fullPath: string,
  size: number,
  maxBytesArg: unknown,
  offsetArg = 0,
): Promise<{ content: string; bytes: number; offset: number; truncated: boolean; sha: string | null }> {
  const requested = Number.isFinite(Number(maxBytesArg)) && Number(maxBytesArg) >= 0
    ? Math.floor(Number(maxBytesArg))
    : undefined;
  const offset = Math.max(0, Math.min(offsetArg, size));
  const readWhole = offset === 0 && size <= WHOLE_BINARY_READ_CAP && (requested === undefined || size <= requested);
  if (readWhole) {
    const buf = await fs.readFile(fullPath);
    return {
      content: buf.toString("base64"),
      bytes: buf.length,
      offset,
      truncated: false,
      sha: createHash("sha256").update(buf).digest("hex"),
    };
  }
  // A bounded byte page preserves a usable recovery cursor instead of making a
  // large binary's first prefix look like the only bytes it has.
  const budget = requested ?? DEFAULT_MAX_READ_BYTES;
  const { buf, truncated } = await readBytesAt(fullPath, size, offset, budget);
  // A page is not a whole-file digest, even if it happens to reach EOF.
  const completeFile = offset === 0 && !truncated;
  return {
    content: buf.toString("base64"),
    bytes: buf.length,
    offset,
    truncated,
    sha: completeFile ? createHash("sha256").update(buf).digest("hex") : null,
  };
}

export async function readFiles(args: Args): Promise<unknown> {
  const paths: unknown[] = Array.isArray(args.paths) ? args.paths : [];
  if (!paths.length) throw new Error("paths must contain at least one workspace file. (expected 'paths': string[])");
  if (paths.length > MAX_READ_PATHS) {
    throw new Error(
      `paths must contain at most ${MAX_READ_PATHS} entries (received ${paths.length}). `
      + "Split the request: one call cannot fan out into an unbounded number of concurrent reads.",
    );
  }
  // An unknown encoding used to fall through to utf8 silently: a client that
  // misspelled "base64" got raw binary decoded as text back, reported as a
  // success. Unknown values get the error vocabulary's word: Invalid.
  if (args.encoding !== undefined && args.encoding !== null && args.encoding !== "utf8" && args.encoding !== "base64") {
    throw new Error(`Invalid "encoding" value ${JSON.stringify(String(args.encoding))} for read_files. Expected one of: utf8, base64.`);
  }
  const asBase64 = args.encoding === "base64";
  const lineRange = args.start_line !== undefined || args.end_line !== undefined;
  if (args.offset !== undefined && !asBase64) {
    throw new Error("offset is only supported with encoding=base64; use start_line/end_line for text.");
  }
  if (asBase64 && lineRange) {
    throw new Error("encoding=base64 cannot be combined with start_line or end_line.");
  }
  const base64Offset = args.offset === undefined ? 0 : requireValidOffset(Number(args.offset));
  // One call used to run every path at once: with the count uncapped, a
  // "read all the images" prompt could pin ~150 MB per base64 row (64 MiB
  // buffer plus its base64 string) times N paths in this process — an OOM that
  // takes every session and supervised process down with it. The count cap
  // bounds one dimension here; the small worker pool bounds the other.
  const readOne = async (p: unknown, index: number): Promise<unknown> => {
    // `String(null)` is "null" and `String("")` resolves to the workspace root:
    // both used to be read as if the caller had named a file that way.
    if (typeof p !== "string" || p.trim() === "") {
      throw new Error(`paths[${index}] must be a non-empty string. (expected 'paths': string[])`);
    }
    // A valid sibling path being unreadable must not discard other requested
    // files. The public array contract promises one row per named path.
    try {
    const maxBytes = Number.isFinite(Number(args.max_bytes)) && Number(args.max_bytes) >= 0
      ? Number(args.max_bytes)
      : DEFAULT_MAX_READ_BYTES;
    const fullPath = await securePath(p);
    const stat = await fs.stat(fullPath);

    // Explicit base64 uses max_bytes as its page budget; small uncapped files
    // still return whole (see readAsBase64).
    if (asBase64) {
      const { content, bytes, offset, truncated, sha } = await readAsBase64(fullPath, stat.size, args.max_bytes, base64Offset);
      return {
        path: String(p),
        content,
        encoding: "base64" as const,
        sha256: sha ?? null,
        bytes_total: stat.size,
        bytes_returned: bytes,
        offset,
        next_offset: truncated && bytes > 0 ? offset + bytes : null,
        truncated,
      };
    }

    // Streaming, line-oriented text read: O(requested range) memory, not O(file size).
    const result = await streamReadLines(
      fullPath,
      {
        startLine: lineRange ? (args.start_line as number | undefined) : undefined,
        endLine: lineRange ? (args.end_line as number | undefined) : undefined,
        maxBytes,
      },
      stat.size,
    ).catch(async err => {
      if (err && typeof err === "object" && (err as { name?: string }).name === "BinaryFileError") {
        return { binary: true as const };
      }
      throw err;
    });

    if ("binary" in result && result.binary === true) {
      // Auto-detected binary starts at zero. A later page is an explicit
      // encoding=base64 request using this returned cursor.
      const { content, bytes, offset, truncated, sha } = await readAsBase64(fullPath, stat.size, args.max_bytes);
      return {
        path: String(p),
        content,
        encoding: "base64" as const,
        binary: true,
        sha256: sha ?? null,
        bytes_total: stat.size,
        bytes_returned: bytes,
        offset,
        next_offset: truncated && bytes > 0 ? offset + bytes : null,
        truncated,
      };
    }

    const r = result as Exclude<typeof result, { binary: true }>;
    // Enforce the byte budget UTF-8-safely (never split a multibyte char).
    const content = truncateToUtf8Bytes(r.content, maxBytes);
    const byteTruncated = r.byte_truncated || Buffer.byteLength(content, "utf8") < r.bytes_returned;
    // sha256 covers the whole file, so it exists only when the stream reached
    // EOF. On an early stop (line range / byte budget) we report `null` rather
    // than re-reading the file, keeping the operation O(requested range).
    // It stays a PRESENT key: the tool contract is "absent facts are explicit
    // nulls", and a dropped key makes `'sha256' in result` flip with file size,
    // which is exactly the silent drift that contract exists to prevent.
    const fullyRead = r.reached_eof;
    // truncated: a ranged read is "truncated" unless it covered the whole file
    // (stream reached EOF, started at line 1 AND ran to the last line — the
    // end_line stop with a small tail now reports the whole-file hash, but it
    // still omitted the lines after end_line); byte-budget hits always truncate.
    // `lines_total` is only null when we never saw EOF; `fullyRead` already
    // proves we did, so a missing value here is a programmer error, not a
    // user input, and we treat it as truncated to stay safe.
    const rangeTruncated = lineRange
      ? !(fullyRead && r.start_line <= 1 && r.lines_total !== null && r.end_line >= r.lines_total)
      : false;
    const truncated = lineRange ? rangeTruncated || byteTruncated : byteTruncated;
    // A byte cap may end inside one enormous line. Only advertise a line cursor
    // when the returned text ends at a newline; otherwise start_line would skip
    // bytes that were never returned and the safe recovery is a larger max_bytes.
    const hasLaterLines = r.lines_total === null || r.end_line < r.lines_total;
    const nextStartLine = truncated && hasLaterLines && r.lines_returned > 0 && content.endsWith("\n")
      ? r.end_line + 1
      : null;
    return {
      path: String(p),
      content,
      encoding: "utf8" as const,
      sha256: fullyRead ? r.sha256 : null,
      truncated,
      bytes_returned: Buffer.byteLength(content, "utf8"),
      bytes_total: stat.size,
      lines_returned: r.lines_returned,
      start_line: r.start_line,
      end_line: r.end_line,
      lines_total: r.lines_total,
      next_start_line: nextStartLine,
    };
    } catch (error) {
      const enriched = enrichFsError(error);
      return { path: p, error: enriched instanceof Error ? enriched.message : String(enriched) };
    }
  };
  const results: unknown[] = new Array(paths.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < paths.length) {
      const index = nextIndex;
      nextIndex += 1;
      const p = paths[index];
      results[index] = await readOne(p, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_FILES_CONCURRENCY, paths.length) }, () => worker()));
  return results;
}
