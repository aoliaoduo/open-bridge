import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { host } from "../../host/host.js";
import { matchFile } from "../../mcp/glob.js";
import { ripgrepAvailable, ripgrepPatternRejection, runRipgrep } from "../../mcp/search-ripgrep.js";
import { matchLinesInWorker, SafeRegexError, SAFE_REGEX_BATCH_TIMEOUT_MS } from "../../mcp/regex-worker.js";
import { searchFileStream, type BatchMatcher } from "../../mcp/stream-search.js";
import {
  DEFAULT_MAX_DIRECTORY_ENTRIES,
  DEFAULT_MAX_SEARCH_RESULTS,
  record,
} from "../state.js";
import { securePath, rejectSymlink, root } from "../paths.js";
import type { JsonArgs } from "./json-args.js";

type Args = JsonArgs;

/**
 * Heavy project directories a shallow listing should never expand wholesale:
 * without this, list_directory depth>1 on a workspace root can enumerate tens
 * of thousands of entries from node_modules/.git/dist into a single response.
 * Direct listings of those folders still work (the filter applies to nested
 * entries, mirroring find_files/search_files).
 */
const LIST_SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

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

export async function listDirectory(args: Args): Promise<unknown> {
  const base = await securePath(args.path);
  // Math.max(0, -5) is 0, so a negative cap listed an empty directory -- which
  // reads as "there is nothing here" rather than "that argument was nonsense",
  // the same trap max_results had. Negatives fall back to the default; 0 is
  // left alone because asking for no rows is a real request.
  const rawMaxEntries = Number(args.max_entries);
  const max = Number.isFinite(rawMaxEntries) && rawMaxEntries >= 0
    ? Math.floor(rawMaxEntries)
    : DEFAULT_MAX_DIRECTORY_ENTRIES;
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
  // Paging is offered for the flat listing only, and it is offered at all
  // because a capped response nobody can continue is just a smaller surprise:
  // the caller is told there are 500 entries and then has no way to reach 501.
  // A recursive listing has no defined page boundary (which level would the
  // offset count?), so asking for one is refused by name rather than ignored.
  const rawOffset = Number(args.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  if (offset > 0 && depth > 1) {
    throw new Error("offset is only supported for depth 1: a recursive listing cannot be paged. "
      + "Narrow the path or raise max_entries instead. (expected 'offset': number, with depth 1)");
  }

  // A zero-row flat page still has an exact, useful total: reading this one
  // directory is the same bounded work an ordinary flat listing performs.
  // It cannot safely offer a continuation because it returned no rows.
  if (max === 0 && depth === 1) {
    const entries = await fs.readdir(base, { withFileTypes: true });
    const total = entries.filter(e => includeHidden || !e.name.startsWith(".")).length;
    return { items: [], truncated: total > offset, total, next_offset: null };
  }

  // Shared budget so max_entries bounds the response across the WHOLE tree
  // (children included). Each directory frame reserves one slot for itself
  // before expanding children, so exhausting the budget never causes an
  // already-listed directory to be dropped and the final count is exact.
  //
  // Running out of budget is REPORTED rather than merely obeyed. A capped
  // listing that does not say it was capped is an answer about the world --
  // "this directory has three files" -- that the tool had no way to know, and
  // the caller acts on it (stops looking). read_files and run_command have
  // reported their own truncation all along; the listing tools did not.
  const budget = { remaining: max };
  let truncated = false;
  let total: number | null = null;
  async function list(dir: string, level: number): Promise<unknown[]> {
    if (budget.remaining <= 0) {
      truncated = true;
      return [];
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    // A flat continuation cursor names positions in this list, so the order
    // must not vary with the filesystem's directory-entry order between calls.
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    // A flat listing already holds every entry in hand, so its true size is
    // free to report. For depth > 1 that number would mean walking the whole
    // tree -- the work max_entries exists to avoid -- so it stays null
    // ("not computed") instead of becoming a number that looks authoritative.
    // Only a flat listing owns its numbers: for depth > 1 the top-level frame
    // holds 13 entries while the tree holds hundreds, and reporting 13 there
    // would be a number that answers a question nobody asked.
    if (depth === 1 && level === 1) {
      total = entries.filter(e => includeHidden || !e.name.startsWith(".")).length;
    }
    const result: unknown[] = [];
    let skipped = 0;
    for (const e of entries) {
      if (budget.remaining <= 0) {
        // Something in this directory will not be listed.
        truncated = true;
        break;
      }
      if (!includeHidden && e.name.startsWith(".")) continue;
      if (level === 1 && skipped < offset) {
        skipped += 1;
        continue;
      }
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
  const items = await list(base, 1);
  return {
    items,
    truncated,
    total,
    // The offset that would resume this survey, so the cap is recoverable
    // rather than terminal. An empty page cannot advance its cursor safely;
    // retry with a positive cap. Recursive listings are not pageable.
    next_offset: truncated && depth === 1 && items.length > 0 ? offset + items.length : null,
  };
}

export async function findFiles(args: Args): Promise<unknown> {
  const out: string[] = [];
  const base = await securePath(args.path);
  const pattern = String(args.pattern ?? "");
  if (!pattern) throw new Error("pattern is required. (expected 'pattern': string)");
  // A negative limit is nonsense, and it failed in two OPPOSITE ways depending
  // on which search path ran: ripgrep reads a negative --max-count as "no
  // limit" and returned everything, while the built-in scan compares
  // `out.length >= limit`, true from the very first entry, and returned
  // nothing. Same argument, same tool, one answer of 166 and one of 0.
  // Fall back to the default: the caller wanted results, and neither "all of
  // them" nor "none" is a defensible reading of -1. maxBytes above already
  // guards this way; max_results was simply missed.
  const limit = Number.isFinite(Number(args.max_results)) && Number(args.max_results) >= 0
    ? Math.floor(Number(args.max_results))
    : DEFAULT_MAX_SEARCH_RESULTS;
  const rawOffset = Number(args.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  // Walk one match PAST the requested page: that extra entry is what makes
  // "there were more" a measured fact instead of an assumption. Include the
  // skipped rows in the probe so every offset has the same evidence.
  const probe = offset + limit + 1;
  async function walk(dir: string): Promise<void> {
    if (out.length >= probe) return;
    // Offsets name positions in this traversal, so their order must not depend
    // on the filesystem's directory-entry order from one call to the next.
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const e of entries) {
      // Checked inside the loop as well: the cap used to be enforced only at
      // recursion entry, so a single directory holding more matches than the
      // cap returned all of them (20 files in one folder answered
      // max_results: 3 with 20 matches) -- the one shape where the entry
      // check never fired.
      if (out.length >= probe) return;
      if (LIST_SKIP_DIRS.has(e.name)) continue;
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
  const page = out.slice(offset, offset + limit + 1);
  const items = page.slice(0, limit);
  const truncated = page.length > limit;
  return {
    items,
    truncated,
    // A zero-sized page cannot advance safely; retry with a positive cap.
    next_offset: truncated && items.length > 0 ? offset + items.length : null,
  };
}

export async function searchFiles(args: Args): Promise<unknown> {
  const needle = String(args.query ?? "");
  if (!needle) throw new Error("query is required. (expected 'query': string)");
  const base = await securePath(args.path);
  // Convenience: path pointing at a single FILE scans just that file (ripgrep is
  // directory-oriented, so the built-in stream scan handles this case directly).
  const baseStat = await fs.stat(base).catch(() => undefined);
  const singleRel = baseStat?.isFile() ? path.relative(root(), base).replace(/\\/g, "/") : undefined;
  // Same guard as grepFiles above: a negative limit meant "everything" down
  // the ripgrep path and "nothing" down the stream path.
  const limit = Number.isFinite(Number(args.max_results)) && Number(args.max_results) >= 0
    ? Math.floor(Number(args.max_results))
    : DEFAULT_MAX_SEARCH_RESULTS;
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

  // A page can be complete relative to its cap yet still incomplete relative to
  // the workspace when a backend had to skip unreadable paths. Keep that fact
  // separate from `truncated`, which only says this response has a next page.
  let partial = false;

  // Prefer ripgrep when available (fast, regex/globs, context). It is invoked with
  // --no-ignore so it sees the same file set as the built-in walk below -- the
  // engines must not disagree about which files exist (see search-ripgrep.ts).
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
      const { matches: rgMatches, partial: ripgrepPartial } = await runRipgrep({
        query: needle,
        cwd: base,
        regex: useRegex,
        includeGlobs: includes,
        // One past the page (see the probe note on the built-in walk below).
        maxResults: limit + offset + 1,
        contextLines,
        executable: rgExe,
      });
      partial = ripgrepPartial;
      if (partial) {
        // rg exit code 2: unreadable/errored files — the matches are real but incomplete.
        record("search_files", "progress", "ripgrep finished partially (exit code 2); results may be incomplete.");
      }
      const page = rgMatches.slice(offset, offset + limit + 1);
      return {
        items: page.slice(0, limit).map(m => ({
          path: withPrefix(m.path),
          line: m.line,
          text: m.text,
          ...(contextLines > 0
            ? { context_before: m.context_before ?? [], context_after: m.context_after ?? [] }
            : {}),
        })),
        truncated: page.length > limit,
        next_offset: page.length > limit && page.length > 1 ? offset + limit : null,
        partial,
      };
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
  // One entry past the page. Requesting exactly the page size makes "there was
  // more" unobservable: the collector stops on the same condition either way,
  // and the caller cannot tell a complete answer from a full page.
  const pageEnd = limit + 1;
  async function walk(dir: string): Promise<void> {
    if (out.length >= pageEnd) return;
    // Keep numeric pagination stable when this JavaScript fallback is used.
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const e of entries) {
      if (out.length >= pageEnd) break;
      if (LIST_SKIP_DIRS.has(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.isSymbolicLink()) await walk(f);
      } else if (!e.isSymbolicLink()) {
        const rel = path.relative(root(), f).replace(/\\/g, "/");
        const includeRel = path.relative(includeBase, f).replace(/\\/g, "/");
        if (!fileAllowed(includeRel)) continue;
        try {
          await searchFileStream(f, batchMatcher, { limit: pageEnd - out.length + offset, contextLines }, match => {
            if (skipped < offset) {
              skipped += 1;
              return out.length < pageEnd;
            }
            const item: Record<string, unknown> = { path: rel, line: match.line, text: match.text };
            if (contextLines > 0) {
              item.context_before = match.context_before;
              item.context_after = match.context_after;
            }
            out.push(item);
            return out.length < pageEnd;
          });
        } catch (error) {
          // A skipped unreadable file is not the same as no matches. Keep the
          // usable rows, but tell the caller this page cannot prove absence.
          if (error instanceof SafeRegexError) throw error;
          partial = true;
        }
      }
    }
  }
  if (singleRel) {
    const singleIncludeRel = path.relative(includeBase, base).replace(/\\/g, "/");
    if (fileAllowed(singleIncludeRel)) {
      let singleSkipped = 0;
      await searchFileStream(base, batchMatcher, { limit: pageEnd + offset, contextLines }, match => {
        if (singleSkipped < offset) {
          singleSkipped += 1;
          return out.length < pageEnd;
        }
        const item: Record<string, unknown> = { path: singleRel, line: match.line, text: match.text };
        if (contextLines > 0) {
          item.context_before = match.context_before;
          item.context_after = match.context_after;
        }
        out.push(item);
        return out.length < pageEnd;
      });
    }
    const items = out.slice(0, limit);
    const truncated = out.length > limit;
    return { items, truncated, next_offset: truncated && items.length > 0 ? offset + items.length : null, partial };
  }
  await walk(base);
  const items = out.slice(0, limit);
  const truncated = out.length > limit;
  return { items, truncated, next_offset: truncated && items.length > 0 ? offset + items.length : null, partial };
}
