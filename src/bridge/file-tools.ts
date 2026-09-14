import * as fs from "node:fs/promises";
import { host } from "../host/host.js";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { assertExpectedHash, sha256 } from "../workspace/file-version.js";
import { createHash, randomBytes } from "node:crypto";
import { applyEol, detectEol, toLf } from "../workspace/eol.js";
import { persistText, writeFileAtomic } from "../workspace/persist.js";
import { applyPatch as applyPatchFile, resolvePatchSource } from "../mcp/patch.js";
import { streamReadLines, truncateToUtf8Bytes } from "../mcp/stream-read.js";
import { findFuzzyMatch, formatFuzzyDiagnostics } from "../mcp/fuzzy-match.js";
import { boundedText, unifiedDiff } from "../mcp/line-diff.js";
import { matchFile } from "../mcp/glob.js";
import { ripgrepAvailable, ripgrepPatternRejection, runRipgrep } from "../mcp/search-ripgrep.js";
import { matchLinesInWorker, SafeRegexError, SAFE_REGEX_BATCH_TIMEOUT_MS } from "../mcp/regex-worker.js";
import { searchFileStream, type BatchMatcher } from "../mcp/stream-search.js";
import {
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_DIRECTORY_ENTRIES,
  DEFAULT_MAX_SEARCH_RESULTS,
  workspaceContext,
  record,
} from "./state.js";
import { securePath, rejectSymlink, root } from "./paths.js";
import type { JsonArgs } from "./json-args.js";

type Args = JsonArgs;

/**
 * A required argument, or a refusal naming the field.
 *
 * File tools used to coerce their inputs with `String(...)`, so a caller that
 * dropped `path` or `destination` did not get an error — it got the literal
 * string "undefined", and the operation then ran against a file of that name:
 * `create_directory` made it, `copy_file` wrote it, `delete_file` removed it and
 * still answered `deleted: true`. Later the same audit found `write_file` and
 * `get_file_info` doing it too — the first one overwrote a real file that
 * happened to be named "undefined". Absence has to be louder than that, so every
 * path-taking file tool reads its paths through here.
 */
function requiredArg(args: Args, key: string): string {
  const value = args[key];
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    throw new Error(
      `Missing "${key}". This operation needs an explicit ${key}; pass a workspace-relative path`
      + " (look it up with list_directory or find_files first).",
    );
  }
  return String(value);
}

/** The paths a file operation must never remove: the project, and the Bridge's own data. */
function protectedTargets(): Array<{ path: string; label: string }> {
  const candidates = [
    { path: path.resolve(workspaceContext.root()), label: "the workspace root this Bridge is anchored to" },
    { path: path.resolve(root()), label: "the workspace root this Bridge is anchored to" },
    { path: path.resolve(host().storageDir()), label: "the Bridge's own data directory" },
  ];
  const unique: Array<{ path: string; label: string }> = [];
  for (const candidate of candidates) {
    if (unique.some(entry => entry.path === candidate.path)) continue;
    unique.push(candidate);
  }
  return unique;
}

/** True when `candidate` is `other` or one of its ancestors (removing it takes `other` with it). */
function isAtOrAbove(candidate: string, other: string): boolean {
  const relative = path.relative(candidate, other);
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * Refuse an operation aimed at the ground the Bridge stands on.
 *
 * `unrestrictedFileAccess` (default on) is deliberate and untouched: absolute
 * paths, parent directories and other volumes stay reachable, and this is not a
 * sandbox. What it stops is the one call nobody means to make — `delete "."`,
 * `delete ".."`, a move or delete that lands on the workspace root, the data
 * directory or a drive root — where a single dropped or mistyped argument takes
 * the whole project with it and `fs.rm` leaves no way back. `run_command` remains
 * the deliberate way to do it.
 */
function refuseSelfDestruction(target: string, verb: string): void {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) {
    throw new Error(
      `Refusing to ${verb} "${resolved}": that is a drive root, not project content. `
      + "File tools never target it; use run_command if you really mean it.",
    );
  }
  const hit = protectedTargets().find(entry => isAtOrAbove(resolved, entry.path));
  if (!hit) return;
  throw new Error(
    `Refusing to ${verb} "${resolved}": it is ${hit.label} (or a parent of it), so the call would take the whole project with it — unrecoverably. `
    + "File tools never target that path; use run_command if you really mean it.",
  );
}

/**
 * Moving a file onto an existing directory is never what the caller meant.
 *
 * `overwrite: true` works by moving the existing destination aside, renaming the
 * source into place and only then deleting the aside — right for swapping two
 * files, catastrophic when the destination is a directory: the entire tree (and,
 * for a destination like "..", everything around the project) is deleted while
 * the call still answers success. `copy` needs no such guard: `fs.cp` refuses a
 * non-directory source over a directory (`ERR_FS_CP_NON_DIR_TO_DIR`).
 */
async function refuseFileOverDirectory(source: string, destination: string, args: Args): Promise<void> {
  const sourceIsDirectory = await fs.stat(source).then(stat => stat.isDirectory(), () => false);
  if (sourceIsDirectory) return;
  const destinationIsDirectory = await fs.stat(destination).then(stat => stat.isDirectory(), () => false);
  if (!destinationIsDirectory) return;
  const inside = `${String(args.destination).replace(/[\\/]+$/, "")}/${path.basename(source)}`;
  throw new Error(
    `Destination "${String(args.destination)}" is an existing directory, and moving a file onto it would delete that directory and everything inside. `
    + `Name the file inside it instead (destination: "${inside}"), or delete the directory first.`,
  );
}


/** Display-diff budget for edit_block results (head+tail bounded). */
const EDIT_DIFF_MAX_CHARS = 16_000;

/**
 * Whole-file hash budget for get_file_info: hashing needs the file in memory
 * (or a full read), so files beyond this cap report sha256:null instead of
 * risking a Bridge-process memory blow-up on a multi-GB target. 128 MiB is
 * far beyond any real source file an edit guard needs to cover.
 */
const GET_FILE_INFO_HASH_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Heavy project directories a shallow listing should never expand wholesale:
 * without this, list_directory depth>1 on a workspace root can enumerate tens
 * of thousands of entries from node_modules/.git/dist into a single response.
 * Direct listings of those folders still work (the filter applies to nested
 * entries, mirroring find_files/search_files).
 */
const LIST_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

/**
 * Whole-file reads of auto-detected binary / base64 content stay below this
 * cap; larger targets are served as a max_bytes-bounded head so a stray stat
 * of a multi-GB file can never balloon Bridge-process memory.
 */
const WHOLE_BINARY_READ_CAP = 64 * 1024 * 1024;

/** Stream-hash a file with constant memory; used instead of buffering it whole. */
async function sha256File(fullPath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fsSync.createReadStream(fullPath);
    stream.on("data", (chunk: string | Buffer) => { hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Read (up to) `maxBytes` from the head of a file into one buffer without
 * buffering the whole file, for bounded base64/binary responses.
 */
async function readHeadBytes(fullPath: string, size: number, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const want = Math.min(size, Math.max(0, maxBytes));
  if (want === 0) return { buf: Buffer.alloc(0), truncated: size > 0 };
  const handle = await fs.open(fullPath, "r");
  try {
    const buf = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const read = await handle.read(buf, got, want - got, got);
      if (read.bytesRead === 0) break;
      got += read.bytesRead;
    }
    const data = got === want ? buf : buf.subarray(0, got);
    return { buf: data, truncated: got < size };
  } finally {
    await handle.close();
  }
}

/** Resolve a base64 response for a (possibly huge) file without unbounded memory. */
async function readAsBase64(
  fullPath: string,
  size: number,
  maxBytesArg: unknown,
): Promise<{ content: string; bytes: number; truncated: boolean; sha: string | null }> {
  const requested = Number.isFinite(Number(maxBytesArg)) && Number(maxBytesArg) >= 0
    ? Math.floor(Number(maxBytesArg))
    : undefined;
  const readWhole = size <= WHOLE_BINARY_READ_CAP && (requested === undefined || size <= requested);
  if (readWhole) {
    const buf = await fs.readFile(fullPath);
    return {
      content: buf.toString("base64"),
      bytes: buf.length,
      truncated: false,
      sha: createHash("sha256").update(buf).digest("hex"),
    };
  }
  // Large file: serve a bounded head (default max_bytes) so the call returns
  // instead of OOM-ing the host; sha256 is only meaningful over the whole file.
  const budget = requested ?? DEFAULT_MAX_READ_BYTES;
  const { buf, truncated } = await readHeadBytes(fullPath, size, budget);
  // A bounded head read cannot speak for the whole file: report null, never a
  // hash of the prefix (it would silently fail every expected_sha256 write).
  return { content: buf.toString("base64"), bytes: buf.length, truncated, sha: truncated ? null : createHash("sha256").update(buf).digest("hex") };
}

/**
 * Zero-match diagnostics (Desktop Commander-inspired, diagnostics-only): when
 * old_text has no occurrence, locate the closest line window and explain the
 * drift so the client can self-correct. Never substitutes content.
 */
function zeroMatchError(
  content: string,
  oldText: string,
  pathLabel: string,
  prefix: string,
  expected: number,
  hint?: string,
): Error {
  const base = `${prefix}: old_text not found (0 occurrences; expected ${expected}).${hint ? ` ${hint}` : ""}`;
  try {
    const match = findFuzzyMatch(content, oldText);
    if (!match) return new Error(base);
    return new Error(`${base}\n${formatFuzzyDiagnostics(match, pathLabel)}`);
  } catch {
    return new Error(base);
  }
}

/** How many matches to name before the list stops being read. */
const AMBIGUOUS_MATCH_LINES = 8;

/**
 * Where the matches are, when old_text is not unique.
 *
 * The zero-match path has full fuzzy diagnostics; the too-many-matches path
 * used to have nothing but a count, even though it is the easier of the two to
 * answer — the positions are already known. The caller was told "found 3" and
 * left to grep for the three themselves, which is the work they had just asked
 * this tool to do.
 *
 * Line numbers specifically, not snippets: the fix is almost always to widen
 * old_text with a neighbouring line, and a line number is what you need to go
 * look at that neighbour.
 */
function ambiguousMatchDetail(content: string, needle: string): string {
  const lines: number[] = [];
  let index = content.indexOf(needle);
  while (index !== -1 && lines.length <= AMBIGUOUS_MATCH_LINES) {
    // Count newlines before the hit rather than splitting the file: a needle
    // that spans lines still reports where it STARTS, which is the anchor the
    // caller will widen from.
    let line = 1;
    for (let i = 0; i < index; i += 1) if (content[i] === "\n") line += 1;
    lines.push(line);
    index = content.indexOf(needle, index + needle.length);
  }
  if (!lines.length) return "";
  const shown = lines.slice(0, AMBIGUOUS_MATCH_LINES);
  const suffix = lines.length > AMBIGUOUS_MATCH_LINES ? ", ..." : "";
  return ` Matches start at line${shown.length > 1 ? "s" : ""} ${shown.join(", ")}${suffix}.`;
}

let resolvedRipgrep: string | undefined;

/**
 * Prefer a host-bundled ripgrep on any platform, fall back to PATH's rg, and
 * finally to the built-in scanner — the search tool probes whatever it gets
 * with `rg --version` before committing to it, so a stale or foreign binary
 * degrades instead of failing the search.
 */
function resolveRipgrepExecutable(): string {
  if (resolvedRipgrep !== undefined) return resolvedRipgrep;
  resolvedRipgrep = "rg";
  const bundled = host().bundledRipgrep();
  if (bundled) {
    try {
      fsSync.accessSync(bundled);
      resolvedRipgrep = bundled;
    } catch {
      // Not bundled in this install; use PATH.
    }
  }
  return resolvedRipgrep;
}

/**
 * Read existing bytes with ENOENT as the ONLY degradation to "absent".
 * A swallowed EACCES/EBUSY (Windows sharing violations are common) used to
 * turn a guarded write or an append into a blind overwrite.
 */
async function readFileOrAbsent(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * rename(2) fails with EXDEV across volumes (C:→D: on Windows); a move is
 * still possible via copy+delete, so fall back instead of erroring out.
 */
async function renameOrCopy(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(source, destination, { recursive: true, force: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}

export async function listDirectory(args: Args): Promise<unknown> {
  const base = await securePath(args.path);
  const max = Number.isFinite(Number(args.max_entries)) ? Math.max(0, Number(args.max_entries)) : DEFAULT_MAX_DIRECTORY_ENTRIES;
  // `Number("abc")` is NaN and `Math.max(NaN, 1)` is NaN, which made every
  // `level < depth` test false: a garbage depth silently returned a depth-1
  // listing instead of failing. Only non-finite input is refused — 0 and
  // negatives still clamp to 1 and an over-large depth still recurses, so no
  // call that used to work changes behaviour.
  const rawDepth = Number(args.depth ?? 1);
  if (!Number.isFinite(rawDepth)) {
    throw new Error("depth must be a number: 1, 2 or 3. (expected 'depth': number)");
  }
  const depth = Math.max(Math.floor(rawDepth), 1);
  const includeHidden = args.include_hidden === true;

  // Shared budget so max_entries bounds the response across the WHOLE tree
  // (children included). Each directory frame reserves one slot for itself
  // before expanding children, so exhausting the budget never causes an
  // already-listed directory to be dropped and the final count is exact.
  const budget = { remaining: max };
  async function list(dir: string, level: number): Promise<unknown[]> {
    if (budget.remaining <= 0) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: unknown[] = [];
    for (const e of entries) {
      if (budget.remaining <= 0) break;
      if (!includeHidden && e.name.startsWith(".")) continue;
      // Dirent does not follow symlinks: resolve the type once so a link to a
      // directory is not mislabeled "file".
      let type: "directory" | "file" = e.isDirectory() ? "directory" : "file";
      if (e.isSymbolicLink()) {
        try {
          type = (await fs.stat(path.join(dir, e.name))).isDirectory() ? "directory" : "file";
        } catch {
          type = "file"; // dangling link
        }
      }
      const item: { name: string; type: "directory" | "file"; children?: unknown[] } = { name: e.name, type };
      // Never expand heavy project folders into a listing (mirrors
      // find_files/search_files); direct listings of those folders still work.
      if (type === "directory" && level < depth && !LIST_SKIP_DIRS.has(e.name)) {
        try {
          await rejectSymlink(path.join(dir, e.name));
          // Reserve this directory's own slot, then expand within what is left.
          const reserve = budget.remaining > 0 ? 1 : 0;
          budget.remaining -= reserve;
          const children = await list(path.join(dir, e.name), level + 1);
          budget.remaining += reserve;
          item.children = children;
        } catch {
          // Unreadable/blocked subtree: present the folder as a leaf.
        }
      }
      result.push(item);
      budget.remaining -= 1;
    }
    return result;
  }
  return list(base, 1);
}

export async function findFiles(args: Args): Promise<string[]> {
  const out: string[] = [];
  const base = await securePath(args.path);
  const pattern = String(args.pattern ?? "");
  if (!pattern) throw new Error("pattern is required. (expected 'pattern': string)");
  const limit = Number.isFinite(Number(args.max_results)) ? Number(args.max_results) : DEFAULT_MAX_SEARCH_RESULTS;

  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist"].includes(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.isSymbolicLink()) await walk(f);
      } else if (!e.isSymbolicLink()) {
        const rel = path.relative(root(), f).replace(/\\/g, "/");
        if (matchFile(rel, pattern)) out.push(rel);
      }
    }
  }
  await walk(base);
  return out;
}

export async function searchFiles(args: Args): Promise<unknown[]> {
  const needle = String(args.query ?? "");
  if (!needle) throw new Error("query is required. (expected 'query': string)");
  const base = await securePath(args.path);
  // Convenience: path pointing at a single FILE scans just that file (ripgrep is
  // directory-oriented, so the built-in stream scan handles this case directly).
  const baseStat = await fs.stat(base).catch(() => undefined);
  const singleRel = baseStat?.isFile() ? path.relative(root(), base).replace(/\\/g, "/") : undefined;
  const limit = Number.isFinite(Number(args.max_results)) ? Number(args.max_results) : DEFAULT_MAX_SEARCH_RESULTS;
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const useRegex = args.regex !== false;
  const contextLines = Math.min(Math.max(Number(args.context ?? 0) || 0, 0), 20);
  const includes: string[] = Array.isArray(args.include) ? args.include.map(String) : [];
  // include globs match paths RELATIVE TO THE SEARCH ROOT (ripgrep semantics:
  // rg anchors -g patterns to its cwd). The built-in walk must use the same
  // anchor, otherwise the two search backends answer the same call differently
  // (e.g. {path:"src", include:["src/**/*.ts"]} matched under the fallback but
  // not under rg). For a single-file search the anchor is the file's directory.
  const includeBase = baseStat?.isFile() ? path.dirname(base) : base;
  const prefix = path.relative(root(), base);
  const withPrefix = (p: string): string =>
    prefix && prefix !== "." ? path.join(prefix, p).replace(/\\/g, "/") : p;

  // Prefer ripgrep when available (fast, .gitignore-aware, regex/globs, context).
  const rgExe = resolveRipgrepExecutable();
  // A pattern ripgrep's default engine cannot parse (look-around, backreferences)
  // is answered by the built-in JS-regex walk — which is the semantics this tool
  // documents anyway. Detecting it here skips a spawn that is guaranteed to exit 2,
  // and the audit line names the construct: a bare "ripgrep failed" told the caller
  // nothing it could act on (it is a `progress` record, so it never reaches the
  // result), which is why the same search kept degrading silently for a whole day.
  const rgDeclined = useRegex ? ripgrepPatternRejection(needle) : undefined;
  if (!singleRel && rgDeclined) {
    record("search_files", "progress",
      `ripgrep's regex engine does not support ${rgDeclined}; used the built-in scanner (JavaScript regex semantics).`);
  }
  if (!singleRel && !rgDeclined && (await ripgrepAvailable(rgExe))) {
    try {
      const { matches: rgMatches, partial } = await runRipgrep({
        query: needle,
        cwd: base,
        regex: useRegex,
        includeGlobs: includes,
        maxResults: limit + offset,
        contextLines,
        executable: rgExe,
      });
      if (partial) {
        // rg exit code 2: unreadable/errored files — the matches are real but incomplete.
        record("search_files", "progress", "ripgrep finished partially (exit code 2); results may be incomplete.");
      }
      return rgMatches.slice(offset, offset + limit).map(m => ({
        path: withPrefix(m.path),
        line: m.line,
        text: m.text,
        ...(contextLines > 0
          ? { context_before: m.context_before ?? [], context_after: m.context_after ?? [] }
          : {}),
      }));
    } catch (error) {
      // Say WHAT failed, not just that something did. record() redacts and bounds
      // the message itself; ripgrep's own diagnostics are short and name the
      // construct (or the unreadable path), which is the part worth keeping.
      const reason = (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .slice(0, 240);
      record("search_files", "progress", `ripgrep failed; using built-in scan — ${reason || "no detail from ripgrep"}`);
    }
  } else if (!singleRel && !rgDeclined) {
    record("search_files", "progress", "ripgrep not found; using built-in scan.");
  }

  // Built-in fallback walk (also regex/glob/context aware). User regexes are
  // evaluated batch-wise inside an isolated worker, so catastrophic
  // backtracking burns a worker instead of freezing the Bridge process; files
  // are scanned as line streams instead of being read whole into memory.
  const batchMatcher: BatchMatcher = useRegex
    ? (lines: string[]) => matchLinesInWorker(needle, lines, SAFE_REGEX_BATCH_TIMEOUT_MS)
    : async (lines: string[]) => {
        const indices: number[] = [];
        lines.forEach((lineText, index) => { if (lineText.includes(needle)) indices.push(index); });
        return indices;
      };
  const fileAllowed = (rel: string): boolean =>
    includes.length === 0 || includes.some(g => matchFile(rel, g));

  const out: unknown[] = [];
  let skipped = 0;
  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return;
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (out.length >= limit) break;
      if ([".git", "node_modules", "dist"].includes(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.isSymbolicLink()) await walk(f);
      } else if (!e.isSymbolicLink()) {
        const rel = path.relative(root(), f).replace(/\\/g, "/");
        const includeRel = path.relative(includeBase, f).replace(/\\/g, "/");
        if (!fileAllowed(includeRel)) continue;
        try {
          await searchFileStream(f, batchMatcher, { limit: limit - out.length + offset, contextLines }, match => {
            if (skipped < offset) {
              skipped += 1;
              return out.length < limit;
            }
            const item: Record<string, unknown> = { path: rel, line: match.line, text: match.text };
            if (contextLines > 0) {
              item.context_before = match.context_before;
              item.context_after = match.context_after;
            }
            out.push(item);
            return out.length < limit;
          });
        } catch (error) {
          // Unreadable files are skipped; regex/worker failures surface to the caller.
          if (error instanceof SafeRegexError) throw error;
        }
      }
    }
  }
  if (singleRel) {
    const singleIncludeRel = path.relative(includeBase, base).replace(/\\/g, "/");
    if (fileAllowed(singleIncludeRel)) {
      let singleSkipped = 0;
      await searchFileStream(base, batchMatcher, { limit: limit + offset, contextLines }, match => {
        if (singleSkipped < offset) {
          singleSkipped += 1;
          return out.length < limit;
        }
        const item: Record<string, unknown> = { path: singleRel, line: match.line, text: match.text };
        if (contextLines > 0) {
          item.context_before = match.context_before;
          item.context_after = match.context_after;
        }
        out.push(item);
        return out.length < limit;
      });
    }
    return out;
  }
  await walk(base);
  return out;
}

export async function readFiles(args: Args): Promise<unknown> {
  const paths: unknown[] = Array.isArray(args.paths) ? args.paths : [];
  if (!paths.length) throw new Error("paths must contain at least one workspace file. (expected 'paths': string[])");
  const asBase64 = args.encoding === "base64";
  const lineRange = args.start_line !== undefined || args.end_line !== undefined;
  return Promise.all(paths.map(async (p, index) => {
    // `String(null)` is "null" and `String("")` resolves to the workspace root:
    // both used to be read as if the caller had named a file that way.
    if (typeof p !== "string" || p.trim() === "") {
      throw new Error(`paths[${index}] must be a non-empty string. (expected 'paths': string[])`);
    }
    const maxBytes = Number.isFinite(Number(args.max_bytes)) && Number(args.max_bytes) >= 0
      ? Number(args.max_bytes)
      : DEFAULT_MAX_READ_BYTES;
    const fullPath = await securePath(p);
    const stat = await fs.stat(fullPath);

    // Explicit base64: bounded by max_bytes only for genuinely large files
    // (see readAsBase64); small files are returned whole as before.
    if (asBase64) {
      const { content, bytes, truncated, sha } = await readAsBase64(fullPath, stat.size, args.max_bytes);
      return {
        path: String(p),
        content,
        encoding: "base64" as const,
        sha256: sha ?? null,
        bytes_total: stat.size,
        bytes_returned: bytes,
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
      // Auto-detected binary (NUL bytes or non-UTF-8 content): same bounded
      // base64 response as the explicit path.
      const { content, bytes, truncated, sha } = await readAsBase64(fullPath, stat.size, args.max_bytes);
      return {
        path: String(p),
        content,
        encoding: "base64" as const,
        binary: true,
        sha256: sha ?? null,
        bytes_total: stat.size,
        bytes_returned: bytes,
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
    return {
      path: String(p),
      sha256: fullyRead ? r.sha256 : null,
      content,
      truncated: lineRange ? rangeTruncated || byteTruncated : byteTruncated,
      bytes_returned: Buffer.byteLength(content, "utf8"),
      bytes_total: stat.size,
      ...(lineRange
        ? {
            lines_returned: r.lines_returned,
            start_line: r.start_line,
            end_line: r.end_line,
            lines_total: r.lines_total,
          }
        : {}),
    };
  }));
}

export async function writeFile(args: Args): Promise<unknown> {
  const file = await securePath(requiredArg(args, "path"), true);
  // A write with NEITHER payload silently truncated the target to zero bytes
  // (content defaulted to ""). Both payloads are optional in the schema only
  // so an explicit empty string can still create an empty file; a call that
  // forgets the payload entirely is a client bug and must error out.
  if (args.content_base64 == null && typeof args.content !== "string") {
    throw new Error("write_file requires content or content_base64. (expected 'content': string or 'content_base64': string)");
  }
  if (args.content_base64 != null) {
    const base64Text = String(args.content_base64);
    // Reject garbage instead of letting Buffer.from silently decode it.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64Text)) {
      throw new Error("content_base64 must be a base64 string.");
    }
    const buf = Buffer.from(base64Text, "base64");
    // Read the existing bytes only when a check or append actually needs them.
    const hashRequested = args.expected_sha256 !== undefined && args.expected_sha256 !== "";
    const previousBuf = hashRequested || args.mode === "append"
      ? await readFileOrAbsent(file)
      : null;
    // Same stale-write guard as the text path, but over raw bytes: read_files
    // reports whole-file byte hashes for base64 content, so compare against that.
    if (hashRequested) {
      if (typeof args.expected_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(args.expected_sha256)) {
        throw new Error("expected_sha256 must be a 64-character SHA-256 hex digest.");
      }
      const actual = createHash("sha256").update(previousBuf ?? Buffer.alloc(0)).digest("hex");
      if (actual !== args.expected_sha256.toLowerCase()) {
        throw new Error(`File changed since it was read: ${String(args.path)}. Read it again before writing.`);
      }
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await rejectSymlink(path.dirname(file));
    if (args.mode === "append" && previousBuf !== null) await fs.appendFile(file, buf);
    else await writeFileAtomic(file, buf);
    const finalBuf = args.mode === "append" && previousBuf !== null
      ? Buffer.concat([previousBuf, buf])
      : buf;
    return {
      path: String(args.path),
      bytes: buf.length,
      mode: args.mode === "append" ? "append" : "overwrite",
      encoding: "base64",
      sha256: createHash("sha256").update(finalBuf).digest("hex"),
    };
  }
  const content = String(args.content ?? "");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await rejectSymlink(path.dirname(file));
  if (args.mode === "append") {
    // The base64 branch checks the stale-write guard before appending; the
    // text path silently skipped it, so a guarded append could land on a file
    // a human (or another process) had changed in the meantime.
    const hashRequested = args.expected_sha256 !== undefined && args.expected_sha256 !== "";
    if (hashRequested) {
      const previousBuf = await readFileOrAbsent(file);
      const previous = previousBuf === null ? "" : previousBuf.toString("utf8");
      assertExpectedHash(previous, args.expected_sha256, String(args.path));
    }
    // Same stale-write guard the base64 branch enforces before appending.
    await fs.appendFile(file, content);
    // Constant-memory hash of the appended file (streamed, so appending to a
    // large log never buffers the whole file just to report a sha256).
    return {
      path: String(args.path),
      bytes: Buffer.byteLength(content, "utf8"),
      mode: "append" as const,
      sha256: await sha256File(file),
    };
  }
  // Overwrite: only read the existing bytes when a stale-write guard was
  // requested; an unconditional whole-file read made every overwrite O(existing
  // file size) in memory for no benefit.
  const hashRequested = args.expected_sha256 !== undefined && args.expected_sha256 !== "";
  if (hashRequested) {
    // ENOENT hashes as "" (create intent); any other read failure must fail
    // the call — conflating EACCES/EBUSY with an empty file let a guard
    // against a locked non-empty file pass and the overwrite proceed blind.
    const previousBuf = await readFileOrAbsent(file);
    assertExpectedHash(previousBuf === null ? "" : previousBuf.toString("utf8"), args.expected_sha256, String(args.path));
  }
  await persistText(file, content);
  return {
    path: String(args.path),
    bytes: Buffer.byteLength(content, "utf8"),
    mode: "overwrite" as const,
    sha256: sha256(content),
  };
}

/**
 * Read a file edit_block is about to rewrite as text.
 *
 * edit_block has no base64 path (write_file does), so a binary target would be
 * decoded with U+FFFD replacements and written straight back — silent,
 * unrecoverable corruption. Refuse loudly and point at the tool that can.
 */
async function readEditableText(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  if (buf.subarray(0, Math.min(buf.length, 8192)).indexOf(0) !== -1) {
    throw new Error(
      "edit_block cannot edit a binary file (NUL bytes found). Use write_file with encoding=base64 for binary content.",
    );
  }
  const text = buf.toString("utf8");
  // Undecodable bytes decode to U+FFFD, which does not round-trip; a file that
  // legitimately contains U+FFFD does round-trip, so this stays a true positive.
  if (text.includes("\uFFFD") && !buf.equals(Buffer.from(text, "utf8"))) {
    throw new Error(
      "edit_block cannot edit a file that is not valid UTF-8. Use write_file with encoding=base64 for binary content.",
    );
  }
  return text;
}

export async function editBlock(args: Args): Promise<unknown> {
  const file = await securePath(requiredArg(args, "path"));
  const hasSingle = args.old_text !== undefined || args.new_text !== undefined;
  const hasEdits = args.edits !== undefined;
  if (hasSingle === hasEdits) {
    throw new Error("Provide exactly one of old_text/new_text or edits. (expected 'edits': 1..20 items of {old_text: string, new_text?: string})");
  }
  if (hasEdits) {
    const edits = args.edits;
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > 20) {
      throw new Error("edits must be an array of 1..20 items. (expected 'edits': 1..20 items of {old_text: string, new_text?: string})");
    }
    const raw = await readEditableText(file);
    assertExpectedHash(raw, args.expected_sha256, String(args.path));
    // Byte-preserving editing (Desktop Commander-inspired): needles are
    // normalized to the file's dominant EOL and replaced in place, so bytes
    // outside the edited spans (including mixed line endings) stay untouched.
    // All hunks apply in memory first and are persisted once, so a mismatched
    // hunk leaves the file untouched (atomic).
    const eol = detectEol(raw);
    let content = raw;
    let replacements = 0;
    for (let i = 0; i < edits.length; i++) {
      const item = edits[i] as { old_text?: unknown; new_text?: unknown };
      const oldText = typeof item.old_text === "string" ? item.old_text : "";
      if (!oldText) {
        throw new Error(`edits[${i}].old_text must be a non-empty string. (expected 'edits[i].old_text': string)`);
      }
      const newText = String(item.new_text ?? "");
      const needle = applyEol(oldText, eol);
      const occurrences = content.split(needle).length - 1;
      if (occurrences !== 1) {
        if (occurrences === 0) throw zeroMatchError(toLf(content), toLf(oldText), String(args.path), `edits[${i}]`, 1);
        throw new Error(`edits[${i}]: expected 1 replacement, found ${occurrences}.`
          + `${ambiguousMatchDetail(content, needle)}`
          + " Include more surrounding lines to make old_text unique.");
      }
      content = content.replace(needle, () => applyEol(newText, eol));
      replacements += 1;
    }
    await persistText(file, content);
    const diffRaw = unifiedDiff(raw, content);
    const diff = diffRaw ? boundedText(diffRaw, EDIT_DIFF_MAX_CHARS).text : undefined;
    return { path: String(args.path), replacements, sha256: sha256(content), applied_edits: edits.length, ...(diff ? { diff } : {}) };
  }
  const oldText = String(args.old_text ?? "");
  const newText = String(args.new_text ?? "");
  if (!oldText) throw new Error("old_text must not be empty. (expected 'old_text': string)");
  const raw = await readEditableText(file);
  assertExpectedHash(raw, args.expected_sha256, String(args.path));
  // Byte-preserving editing: the needle/replacement are normalized to the
  // file's dominant EOL and replaced in place, so bytes outside the edited
  // spans (including mixed line endings elsewhere in the file) stay untouched.
  const eol = detectEol(raw);
  const needle = applyEol(oldText, eol);
  const replacement = applyEol(newText, eol);
  const occurrences = raw.split(needle).length - 1;
  // replace_all means "every occurrence". It used to be read only inside the
  // error message below, so a multi-occurrence replace_all always failed with
  // "Expected 1 replacement(s), found N. Pass replace_all=true ..." — advice to
  // pass the flag the caller had just passed. An explicit expected_replacements
  // still wins, so the count stays fully controllable.
  const replaceAll = args.replace_all === true;
  const expected = args.expected_replacements === undefined
    ? (replaceAll ? occurrences : 1)
    : Number(args.expected_replacements);
  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error("expected_replacements must be a non-negative integer. (expected 'expected_replacements': number)");
  }
  if (args.expected_replacements === undefined && occurrences === 0) {
    // replace_all honors an explicit expected count when given; without one,
    // zero matches would silently rewrite the file unchanged (F3).
    throw zeroMatchError(toLf(raw), toLf(oldText), String(args.path), "edit_block", 1, "Pass expected_replacements: 0 for an intentional no-op.");
  }
  if (occurrences === 0 && expected !== 0) {
    throw zeroMatchError(toLf(raw), toLf(oldText), String(args.path), "edit_block", expected);
  }
  if (occurrences !== expected) {
    // Where they are, then what to do about it. The positions are the half the
    // caller cannot derive from this message, so they come first.
    const where = occurrences > 1 ? ambiguousMatchDetail(raw, needle) : "";
    const guidance = !args.replace_all && occurrences > 1
      ? " Pass replace_all=true or set expected_replacements to replace every occurrence, or include more surrounding lines to make old_text unique."
      : "";
    throw new Error(`Expected ${expected} replacement(s), found ${occurrences}.${where}${guidance}`);
  }
  // split/join replaces every occurrence without interpreting $ sequences in
  // the replacement (String.replace would expand $&, $', ... and corrupt the
  // file). occurrences === expected here, so this replaces exactly the
  // expected count in both single and replace_all mode.
  const next = occurrences === 0 ? raw : raw.split(needle).join(replacement);
  const count = occurrences;
  await persistText(file, next);
  const diffRaw = unifiedDiff(raw, next);
  const diff = diffRaw ? boundedText(diffRaw, EDIT_DIFF_MAX_CHARS).text : undefined;
  return { path: String(args.path), replacements: count, sha256: sha256(next), ...(diff ? { diff } : {}) };
}

export async function createDirectory(args: Args): Promise<unknown> {
  const dir = await securePath(requiredArg(args, "path"), true);
  await fs.mkdir(dir, { recursive: true });
  return { path: String(args.path), created: true };
}

export async function moveFile(args: Args): Promise<unknown> {
  const source = await securePath(requiredArg(args, "source"));
  const destination = await securePath(requiredArg(args, "destination"), true);
  refuseSelfDestruction(source, "move");
  refuseSelfDestruction(destination, "move onto");
  if (args.overwrite === true) await refuseFileOverDirectory(source, destination, args);
  if (args.overwrite !== true) {
    try {
      await fs.lstat(destination);
      throw new Error("Destination already exists; set overwrite=true to replace it.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (args.overwrite === true) {
    // Safe overwrite order: never delete the destination BEFORE the rename.
    // rm-first destroyed the destination irreversibly whenever the rename then
    // failed (cross-volume EXDEV, locked file, missing source) and, when the
    // destination was an ancestor of the source, deleted the source itself.
    // Instead: move the existing destination aside, rename source into place,
    // and only on success remove the aside; restore the aside on failure.
    const destinationExists = await fs.lstat(destination).then(() => true, () => false);
    if (destinationExists) {
      if (path.resolve(source) === path.resolve(destination)) {
        // Same file: nothing to do; report success without touching anything.
        return { source: String(args.source), destination: String(args.destination), unchanged: true };
      }
      const aside = path.join(
        path.dirname(destination),
        `.ob-tmp-${path.basename(destination)}-${randomBytes(4).toString("hex")}`,
      );
      await fs.rename(destination, aside);
      try {
        await renameOrCopy(source, destination);
      } catch (error) {
        // Restore is best-effort, but a failed restore must surface: the
        // caller believes the destination is intact while its content lives
        // in `aside`, which a retry would then treat as "destination exists".
        try {
          await fs.rename(aside, destination);
        } catch (restoreError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} — restoring the original destination failed too `
            + `(its content is preserved at ${aside}): ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
        throw error;
      }
      await fs.rm(aside, { recursive: true, force: true }).catch(() => { /* leftover aside is harmless */ });
    } else {
      await renameOrCopy(source, destination);
    }
  } else {
    await renameOrCopy(source, destination);
  }
  return { source: String(args.source), destination: String(args.destination) };
}

export async function copyFile(args: Args): Promise<unknown> {
  const source = await securePath(requiredArg(args, "source"));
  const destination = await securePath(requiredArg(args, "destination"), true);
  if (args.overwrite !== true) {
    try {
      await fs.lstat(destination);
      throw new Error("Destination already exists; set overwrite=true to replace it.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: args.overwrite === true });
  return { source: String(args.source), destination: String(args.destination) };
}

export async function deleteFile(args: Args): Promise<unknown> {
  const target = await securePath(requiredArg(args, "path"));
  refuseSelfDestruction(target, "delete");
  await fs.rm(target, { recursive: args.recursive === true, force: false });
  return { path: String(args.path), deleted: true };
}

export async function getFileInfo(args: Args): Promise<unknown> {
  const file = await securePath(requiredArg(args, "path"));
  const stat = await fs.stat(file);
  const isDirectory = stat.isDirectory();
  // Hashing needs the file in memory; beyond the cap we report null instead of
  // buffering a multi-GB file into the Bridge process (the outputSchema already
  // allows sha256: null).
  const hash = isDirectory || stat.size > GET_FILE_INFO_HASH_MAX_BYTES
    ? null
    : createHash("sha256").update(await fs.readFile(file)).digest("hex");
  return {
    path: String(args.path),
    type: isDirectory ? "directory" : "file",
    size: stat.size,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    sha256: hash,
  };
}

export async function applyPatchTool(args: Args): Promise<unknown> {
  const hashes = args.expected_sha256 && typeof args.expected_sha256 === "object" && !Array.isArray(args.expected_sha256)
    ? (args.expected_sha256 as Record<string, unknown>)
    : {};
  const source = resolvePatchSource(args.patch, args.patch_file);
  const patchText =
    source.kind === "inline" ? source.content : await fs.readFile(await securePath(source.path), "utf8");
  const { changed, changes } = await applyPatchFile(patchText, workspaceContext, hashes,
    (f, c) => persistText(f, c));
  return { applied: true, files: changed, changes };
}
