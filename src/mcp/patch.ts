import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertExpectedHash } from "../workspace/file-version.js";
import type { WorkspaceContext } from "../workspace/context.js";
import { detectEol, toLf, applyEol } from "../workspace/eol.js";
import { boundedText, countDiffLines, unifiedDiff } from "./line-diff.js";

/** Per-file change details returned alongside the applied file list. */
export interface PatchChange {
  path: string;
  action: "add" | "update" | "delete";
  additions: number;
  deletions: number;
  /** Unified diff against the file's pre-patch content, head+tail bounded. */
  diff: string;
}

/** Upper bound for a single file's display diff; larger diffs are head+tail truncated. */
const PATCH_DIFF_MAX_CHARS = 16_000;

export type PatchSource =
  | { kind: "inline"; content: string }
  | { kind: "file"; path: string };

/**
 * Resolve the mutually exclusive patch / patch_file inputs (T-2).
 * Exactly one must be provided; the error echoes the expected shapes so
 * clients can self-correct (Task 5 agent-experience style).
 */
export function resolvePatchSource(patch: unknown, patchFile: unknown): PatchSource {
  const patchText = typeof patch === "string" && patch.length > 0 ? patch : undefined;
  const filePath = typeof patchFile === "string" && patchFile.trim().length > 0 ? patchFile.trim() : undefined;
  if (patchText === undefined && filePath === undefined) {
    throw new Error("Missing one of \"patch\" or \"patch_file\". apply_patch requires exactly one patch source. (expected 'patch': string or 'patch_file': string)");
  }
  if (patchText !== undefined && filePath !== undefined) {
    throw new Error("Conflict: provide exactly one of \"patch\" or \"patch_file\". (expected 'patch': string or 'patch_file': string)");
  }
  return patchText !== undefined ? { kind: "inline", content: patchText } : { kind: "file", path: filePath! };
}

/**
 * Resolve a file path out of a patch header.
 *
 * Two syntaxes reach this, and they mean different things by `a/` and `b/`:
 *
 *  - **Classic unified diff** (`--- a/<path>` / `+++ b/<path>`). Here the prefix
 *    is diff metadata — it says which side of the hunk the path came from — so
 *    exactly ONE must be stripped. Chaining two replaces stripped both, so
 *    `--- a/b/index.ts` lost its real `b/` directory and the patch rewrote or
 *    deleted the wrong file, which is not recoverable.
 *  - **ShunCode block headers** (`*** Update File: <path>`, the form `docs/`
 *    tells clients to send). Here the path is literal and no prefix is added, so
 *    stripping one was itself the bug: in a repo with a top-level `b/`
 *    directory, `*** Delete File: b/gone.txt` deleted `gone.txt`.
 *
 * Hence the mode. A block header naming a top-level `a/` or `b/` path now
 * resolves to that file; the cost is that a block header spelling a diff-style
 * `b/<path>` no longer reaches `<path>`, which is not a form the block grammar
 * produces.
 */
function patchFilePath(header: string, mode: "block" | "diff"): string {
  const trimmed = header.trim();
  const clean = mode === "diff" ? trimmed.replace(/^[ab][\\/]/, "") : trimmed;
  if (!clean || clean === "/dev/null") throw new Error("Patch contains an invalid file path.");
  return clean;
}

/**
 * Absolute paths a patch will touch, resolved through the same workspace policy
 * the applier uses. Consumed by the concurrency layer so an apply_patch cannot
 * interleave with a write_file on the same file.
 *
 * Best-effort by design: headers the applier would reject are skipped so the
 * real error still comes from applyPatch, and an unreadable patch_file yields
 * no keys (the applier reports the read failure).
 */
export async function patchTargetPaths(
  patch: unknown,
  patchFile: unknown,
  workspace: WorkspaceContext,
): Promise<string[]> {
  let text: string;
  try {
    const source = resolvePatchSource(patch, patchFile);
    text = source.kind === "inline"
      ? source.content
      : await fs.readFile(await workspace.resolveSecure(source.path), "utf8");
  } catch {
    return [];
  }
  const normalized = text.replace(/^\*\*\* Begin Patch\s*\n?/m, "").replace(/^\*\*\* End Patch\s*$/m, "");
  const paths = new Set<string>();
  const add = async (header: string, mode: "block" | "diff"): Promise<void> => {
    let relative: string;
    try {
      relative = patchFilePath(header, mode);
    } catch {
      return;
    }
    try {
      paths.add(await workspace.resolveSecure(relative, true));
    } catch {
      // Outside the allowed roots: applyPatch raises the policy error itself.
    }
  };
  // Block headers must parse with the SAME mode applyPatch uses ("block", no
  // a//b/ stripping): the two used to disagree, and for a path that really
  // starts with b/ the lock landed on a different file than the one edited —
  // which unguarded a concurrent write_file against the real target.
  for (const match of normalized.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) await add(match[1]!, "block");
  // Classic unified diff: the --- side names the file for deletions too, where
  // +++ is /dev/null.
  for (const match of normalized.matchAll(/^(?:---|\+\+\+)\s+([^\n]+)$/gm)) await add(match[1]!, "diff");
  return [...paths];
}

type PatchOperation = { kind: "update" | "add" | "delete"; relative: string; file: string; content?: string };

function sliceBlockBody(source: string, header: RegExpMatchArray, endIndex: number): string {
  return source
    .slice(header.index! + header[0].length, endIndex)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n\*\*\* End Patch\s*$/, "");
}

/** 0-based line number on which the character offset `index` sits. */
function lineIndexOf(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}

/** Character offset of the start of 0-based line `line` (clamped to text length). */
function lineStartIndexOf(text: string, line: number): number {
  if (line <= 0) return 0;
  let pos = -1;
  for (let i = 0; i < line; i += 1) {
    pos = text.indexOf("\n", pos + 1);
    if (pos === -1) return text.length;
  }
  return pos + 1;
}

/**
 * One hunk edit expressed in ORIGINAL LF-space coordinates.
 *
 * Hunks apply bottom-up (descending positions), so every recorded span keeps
 * its original coordinates: edits above never shift positions below them.
 * This is what lets applyHunksPreserving map LF-space edits back onto the raw
 * bytes and leave everything outside the edited spans byte-for-byte intact.
 */
interface HunkSpan {
  /** LF offset where the replaced span starts (insertion: start === end). */
  lfStart: number;
  /** LF offset just past the replaced span. */
  lfEnd: number;
  /** LF-normalized replacement text ("" for deletions). */
  replacement: string;
  /** EOF insertion onto a final line with no terminator: terminate that raw line first. */
  appendTerminator?: boolean;
}

/**
 * Apply unified-diff hunks to current content (LF space), recording each edit
 * as an original-coordinate span for byte-preserving reconstruction.
 *
 * Blank hunk lines arrive in two shapes: the canonical leading-space context
 * line (" ") and a completely empty line, which many AI/MCP clients emit for
 * blank lines instead of the space prefix. Both are context. The only empty
 * string dropped is the split artifact produced by the newline terminating the
 * hunk body itself.
 *
 * Diff lines are LINE-ORIENTED: every '-'/'+'/' ' line stands for one whole
 * file line, so the spans this function removes/inserts include each line's
 * newline terminator. Handling terminators is what makes a context-free
 * deletion ("-bbb" on a "\n"-terminated file) remove the whole line instead of
 * leaving a stray blank line, and what keeps inserted lines from fusing onto
 * the following line (or leaving a file without a trailing newline when the
 * insertion lands at EOF).
 *
 * Hunks are applied BOTTOM-UP so each @@ old-line coordinate stays valid while
 * earlier (upper) regions are still unmodified; hunks anchored at the same
 * coordinate apply in reverse body order so the earlier body hunk ends up
 * first in the document. The @@ coordinates are honored when the hunk text is
 * ambiguous: previously the parser ignored them and replaced the FIRST
 * occurrence of a duplicated block, silently editing the WRONG location while
 * reporting success. A duplicated block whose target line does not match any
 * occurrence now fails loudly instead of guessing.
 */
function applyHunksTracked(current: string, body: string, relative: string): { text: string; spans: HunkSpan[] } {
  let next = current;
  const spans: HunkSpan[] = [];
  // Hunks arrive in two shapes: git-style "@@ -N,M +N,K @@" with coordinates,
  // and a bare "@@" header (ShunCode-style Update blocks) without them.
  const matches = [...body.matchAll(/@@(?: -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?)?[^\n]*\n([\s\S]*?)(?=\n@@|$)/g)];
  if (!matches.length) throw new Error(`Update patch for ${relative} has no @@ hunk.`);
  const hunks = matches.map((hunk, order) => ({
    oldStart: hunk[1] !== undefined ? Number(hunk[1]) : undefined,
    order,
    // Group 5 is a mandatory `([\s\S]*?)`, so it is always a string (possibly
    // empty). The fallback never fires; it only tells the compiler so.
    bodyText: hunk[5] ?? "",
  }));
  const stripPrefix = (line: string): string => (line.startsWith("-") || line.startsWith("+") || line.startsWith(" ") ? line.slice(1) : line);
  const splitBody = (raw: string): string[] => {
    const lines = raw.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "" && raw.endsWith("\n")) lines.pop();
    return lines;
  };
  const hunkData = hunks.map(hunk => {
    const lines = splitBody(hunk.bodyText);
    // Build full-line spans: context/del lines go to `remove`, context/add to
    // `add`, and EVERY retained line keeps its "\n" so line boundaries are
    // respected on both sides of the replacement.
    const removeLines: string[] = [];
    const addLines: string[] = [];
    for (const line of lines) {
      // "\ No newline at end of file" is not content: git emits it after the
      // "-" and/or "+" line of an EOF change. Treating it as context (it
      // starts with neither "-" nor "+" nor " ") appended the literal marker
      // text to BOTH sides, so the hunk could never match and every git-style
      // diff touching a file without a trailing newline failed loudly. The
      // missing final terminator itself is already handled by the EOF
      // fallback below (remove keeps its "\n"; the file's last line has none).
      if (line.startsWith("\\")) continue;
      if (line.startsWith("-")) {
        removeLines.push(stripPrefix(line) + "\n");
      } else if (line.startsWith("+")) {
        addLines.push(stripPrefix(line) + "\n");
      } else {
        const text = stripPrefix(line);
        removeLines.push(text + "\n");
        addLines.push(text + "\n");
      }
    }
    return { ...hunk, remove: removeLines.join(""), add: addLines.join("") };
  });
  // Bottom-up: lower hunks first so their coordinates are unaffected by edits
  // made above them (and upper hunks still find their original context).
  hunkData.sort((a, b) => {
    const aKey = a.oldStart ?? Number.POSITIVE_INFINITY;
    const bKey = b.oldStart ?? Number.POSITIVE_INFINITY;
    if (bKey !== aKey) return bKey - aKey;
    // Applications tied on one sort key do NOT share a correct order — it
    // depends on what the key means:
    //
    // - Finite anchor (e.g. two pure insertions after the same line): REVERSE
    //   body order. Every insertion lands AT the same original position, so
    //   the hunk applied last ends up ahead of the one applied first;
    //   reversing keeps the document in body order.
    // - Bare "@@" hunks (key +Infinity): FORWARD body order. They append at
    //   the end of the file and the end MOVES with every append, so the
    //   first-applied hunk keeps the earlier position — applying in reverse
    //   used to emit the later body hunk's lines above the earlier one's,
    //   silently reversing content the client wrote in order.
    //
    // Keys are compared explicitly: Infinity - Infinity is NaN, and relying
    // on NaN being falsy to reach the tie-break made this comparator one
    // refactor away from sorting tied hunks arbitrarily.
    return a.oldStart === undefined ? a.order - b.order : b.order - a.order;
  });
  for (const { oldStart, remove, add } of hunkData) {
    if (!remove) {
      // Pure-insertion hunk (@@ -N,0 +M,K @@): insert AFTER old line N. Bare
      // "@@" headers carry no anchor; appending at the end is the only safe
      // choice (the old parser simply errored on such hunks).
      let insertAt = oldStart !== undefined ? lineStartIndexOf(next, oldStart) : next.length;
      let appendTerminator = false;
      if (insertAt === next.length && next.length > 0 && !next.endsWith("\n")) {
        // Appending after a file whose last line has no newline: terminate
        // that line first so the inserted lines stay whole lines instead of
        // fusing onto it.
        next += "\n";
        insertAt = next.length;
        appendTerminator = true;
      }
      next = next.slice(0, insertAt) + add + next.slice(insertAt);
      spans.push({ lfStart: insertAt, lfEnd: insertAt, replacement: add, ...(appendTerminator ? { appendTerminator: true } : {}) });
      continue;
    }
    // Enumerate non-overlapping occurrences so duplicated blocks are detected
    // instead of silently editing the first one.
    const occurrences: number[] = [];
    let searchFrom = 0;
    for (;;) {
      const idx = next.indexOf(remove, searchFrom);
      if (idx === -1) break;
      occurrences.push(idx);
      searchFrom = idx + remove.length;
    }
    if (occurrences.length === 0 && remove.endsWith("\n")) {
      // EOF fallback for a file whose FINAL line has no trailing newline
      // ("\ No newline at end of file"): the removed span's last terminator is
      // absent. Only accept a match that runs to the very end of the file so
      // this cannot silently eat the wrong text.
      const trimmed = remove.slice(0, -1);
      if (trimmed && next.endsWith(trimmed)) {
        const start = next.length - trimmed.length;
        const end = next.length; // captured before the mutation below
        const replacement = add.endsWith("\n") ? add.slice(0, -1) : add;
        next = next.slice(0, start) + replacement;
        spans.push({ lfStart: start, lfEnd: end, replacement });
        continue;
      }
    }
    if (occurrences.length === 0) throw new Error(`Patch context not found in ${relative}.`);
    // `!` is backed by the `occurrences.length === 0` throw just above and, in
    // the branch below, by `atTarget.length === 1`. Stating it keeps `chosen` a
    // plain number: an undefined offset would turn the slice arithmetic into
    // NaN and quietly corrupt the file.
    let chosen = occurrences[0]!;
    if (occurrences.length > 1) {
      const atTarget = oldStart !== undefined
        ? occurrences.filter(idx => lineIndexOf(next, idx) === oldStart - 1)
        : [];
      if (atTarget.length === 1) {
        chosen = atTarget[0]!;
      } else {
        const atLines = occurrences.map(idx => lineIndexOf(next, idx) + 1).join(", ");
        throw new Error(
          `Patch hunk for ${relative} is ambiguous: the changed block appears ${occurrences.length} times ` +
          `(around lines ${atLines}).${oldStart !== undefined ? ` It does not match its @@ target line ${oldStart}.` : ""} ` +
          "Add more surrounding context lines to the hunk so the intended block is unique.",
        );
      }
    }
    // Replacement must go through slice/splice: String.replace(str, fn) is fine
    // here (no $ expansion with a function), but slice keeps the edit anchored
    // to the chosen occurrence when duplicates exist.
    next = next.slice(0, chosen) + add + next.slice(chosen + remove.length);
    spans.push({ lfStart: chosen, lfEnd: chosen + remove.length, replacement: add });
  }
  return { text: next, spans };
}

/**
 * Map every LF-space offset of toLf(raw) back to its offset in raw.
 * map[k] is the raw offset of LF character k; map[lfLength] === raw.length.
 * Each CRLF pair collapses to one LF character, every other character maps 1:1
 * (including lone CR, which toLf leaves untouched).
 */
function buildLfToRawIndex(raw: string, lfLength: number): number[] {
  const map = new Array<number>(lfLength + 1);
  map[0] = 0;
  let rawIdx = 0;
  for (let lfIdx = 1; lfIdx <= lfLength; lfIdx += 1) {
    if (raw.charCodeAt(rawIdx) === 13 /* \r */ && raw.charCodeAt(rawIdx + 1) === 10 /* \n */) rawIdx += 2;
    else rawIdx += 1;
    map[lfIdx] = rawIdx;
  }
  return map;
}

/**
 * Apply hunks to the RAW file content while preserving untouched bytes
 * (edit_block semantics): hunks are matched in LF space, then each recorded
 * span is mapped back onto the raw text so lines outside the edited spans —
 * including their original line endings in a mixed-EOL file — stay
 * byte-for-byte identical. Replacement text uses the file's dominant EOL,
 * exactly like edit_block's needle normalization.
 *
 * A final verification (toLf(result) === expected LF text) guards the mapping:
 * in pathological cases (hunk matches far from their @@ coordinates) recorded
 * spans cannot be proven to be original coordinates, and the function falls
 * back to whole-file EOL normalization — the previous behavior — instead of
 * risking a silently wrong reconstruction.
 */
function applyHunksPreserving(rawCurrent: string, body: string, relative: string): string {
  const eol = detectEol(rawCurrent);
  const lf = toLf(rawCurrent);
  const { text, spans } = applyHunksTracked(lf, body, relative);
  if (text === lf) return rawCurrent; // semantic no-op: keep the file byte-identical
  const toNative = (s: string): string => (eol === "\r\n" ? s.replace(/\n/g, "\r\n") : s);
  const map = buildLfToRawIndex(rawCurrent, lf.length);
  let rawNext = rawCurrent;
  for (const span of spans) {
    if (span.appendTerminator === true) {
      // LF space appended "\n" before inserting at EOF; mirror that with the
      // file's dominant terminator so the last raw line stays whole.
      rawNext = rawNext + toNative("\n") + toNative(span.replacement);
      continue;
    }
    const start = map[span.lfStart];
    const end = map[span.lfEnd];
    // Spans are applied bottom-up, so rawNext only ever changed ABOVE these
    // positions; any missing or out-of-range mapping means the coordinate
    // assumption broke and the verified fallback below must take over. The two
    // `=== undefined` tests are also what let the comparisons after them
    // type-check — Number.isInteger is not a narrowing guard.
    if (start === undefined || end === undefined
      || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 0 || end < start || end > rawNext.length) {
      return applyEol(text, eol);
    }
    rawNext = rawNext.slice(0, start) + toNative(span.replacement) + rawNext.slice(end);
  }
  return toLf(rawNext) === text ? rawNext : applyEol(text, eol);
}

/** Collect the content of an Add File block; blank added lines stay blank. */
function addedContent(body: string): string {
  // A bodyless Add block creates an EMPTY file, not a one-newline file (the
  // bare "" line here is the split artifact, not an added blank line).
  if (body === "") return "";
  const lines = body.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "" && body.endsWith("\n")) lines.pop();
  const contentLines = lines.filter(line => line.startsWith("+") || line === "");
  if (!contentLines.length) return "";
  const content = contentLines
    .map(line => (line.startsWith("+") ? line.slice(1) : line))
    .join("\n");
  return content.endsWith("\n") ? content : `${content}\n`;
}

/**
 * Read a file apply_patch is about to rewrite as text.
 *
 * apply_patch has no base64 path, so a binary or non-UTF-8 target would be
 * decoded with U+FFFD replacements and written straight back — silent,
 * unrecoverable corruption of regions the patch never touched. Same guard as
 * edit_block's readEditableText.
 */
async function readPatchableText(file: string, label: string): Promise<string> {
  const buf = await fs.readFile(file);
  if (buf.subarray(0, Math.min(buf.length, 8192)).indexOf(0) !== -1) {
    throw new Error(
      `apply_patch cannot patch a binary file (NUL bytes found): ${label}. Use write_file with encoding=base64 instead.`,
    );
  }
  const text = buf.toString("utf8");
  // Undecodable bytes decode to U+FFFD, which does not round-trip; a file that
  // legitimately contains U+FFFD does round-trip, so this stays a true positive.
  if (text.includes("\uFFFD") && !buf.equals(Buffer.from(text, "utf8"))) {
    throw new Error(
      `apply_patch cannot patch a file that is not valid UTF-8: ${label}. Use write_file with encoding=base64 instead.`,
    );
  }
  return text;
}

/**
 * Apply a ShunCode-style (*** Begin Patch) or classic unified diff patch.
 * Path resolution and hash enforcement go through the workspace context so the
 * same security policy as every other file tool applies.
 */
export async function applyPatch(
  patch: string,
  workspace: WorkspaceContext,
  expectedHashes: Record<string, unknown> = {},
  writeText: (file: string, content: string) => Promise<unknown> = async (file, content) => {
    await fs.writeFile(file, content, "utf8");
  },
): Promise<{ changed: string[]; changes: PatchChange[] }> {
  const normalized = patch.replace(/^\*\*\* Begin Patch\s*\n?/m, "").replace(/^\*\*\* End Patch\s*$/m, "");
  const blocks = [...normalized.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)];
  const operations: PatchOperation[] = [];
  // B-9: chain same-file blocks in memory; later blocks read earlier results.
  const interim = new Map<string, string>();
  // Pre-patch content per touched file, for whole-journey display diffs.
  const originalContent = new Map<string, string>();
  // Last block kind per file, so an "Add" that logically recreates a file the
  // same patch just deleted stays allowed while every other Add-over-existing
  // (or duplicate Add) is rejected.
  const lastBlockKind = new Map<string, PatchOperation["kind"]>();

  if (blocks.length) {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const nextBlock = blocks[i + 1];
      if (!block) continue; // unreachable: i < blocks.length
      // Groups 1 and 2 are mandatory in the block pattern (`(Update|Add|Delete)`
      // and `(.+)`), so both are strings. `!` rather than a fallback: a guessed
      // kind or a defaulted empty path would silently patch the wrong thing,
      // which is the one failure mode a patch applier must not have.
      const kind = block[1]! as "Update" | "Add" | "Delete";
      const relative = block[2]!.trim();
      const file = await workspace.resolveSecure(patchFilePath(relative, "block"), kind !== "Update");
      // `nextBlock` is undefined exactly when this is the last block, which is
      // what the old `i + 1 < blocks.length` test spelled out longhand.
      const body = sliceBlockBody(normalized, block, nextBlock ? nextBlock.index! : normalized.length);
      if (kind === "Add") {
        // Add means "create this file": overwriting anything that already
        // exists is a client bug and silently destroys content. Only an Add
        // that recreates a file this same patch deleted (a delete+recreate
        // update pattern) is allowed.
        const prior = lastBlockKind.get(file);
        if (prior !== "delete") {
          const exists = await fs.stat(file).then(() => true, () => false);
          if (exists || interim.has(file)) {
            throw new Error(
              `Add File: ${relative} already exists. Use an Update block to modify an existing file, or delete it first.`,
            );
          }
        }
      }
      const rawCurrent = kind === "Add" ? "" : interim.has(file) ? interim.get(file)! : await readPatchableText(file, relative);
      if (!interim.has(file)) {
        originalContent.set(file, rawCurrent);
        assertExpectedHash(rawCurrent, expectedHashes[relative], relative);
      }
      if (kind === "Delete") {
        interim.delete(file);
        operations.push({ kind: "delete", relative, file });
        lastBlockKind.set(file, "delete");
        continue;
      }
      if (kind === "Add") {
        const addContent = addedContent(body);
        interim.set(file, addContent);
        operations.push({ kind: "add", relative, file, content: addContent });
        lastBlockKind.set(file, "add");
        continue;
      }
      const updContent = applyHunksPreserving(rawCurrent, body, relative);
      interim.set(file, updContent);
      operations.push({ kind: "update", relative, file, content: updContent });
      lastBlockKind.set(file, "update");
    }
  } else {
    // Classic unified diff. The lookahead keeps hunk BODY lines that merely
    // start with "-- "/"++ " (removed/added content rendering as ---/+++)
    // from being mistaken for a new file section — git headers are always
    // followed by an @@ hunk.
    const fileHeaders = [...normalized.matchAll(/^---\s+([^\n]+)\n\+\+\+\s+([^\n]+)\n(?=@@)/gm)];
    if (!fileHeaders.length) throw new Error("Expected ShunCode patch format or unified diff headers.");
    for (let i = 0; i < fileHeaders.length; i++) {
      const header = fileHeaders[i];
      const nextHeader = fileHeaders[i + 1];
      if (!header) continue; // unreachable: i < fileHeaders.length
      // "+++ /dev/null" names a DELETION: the --- side carries the file. The
      // code used to take +++ unconditionally, so patchFilePath("/dev/null")
      // threw and aborted the ENTIRE multi-file patch.
      // Groups 0-2 are all mandatory here (`([^\n]+)` twice) and split() always
      // yields a first element, so these `!`s restate guarantees the pattern
      // already makes — no path is ever defaulted to "".
      const plusPath = header[2]!.split(/\s+/)[0]!;
      const isDeletion = plusPath === "/dev/null";
      const relative = patchFilePath(isDeletion ? header[1]!.split(/\s+/)[0]! : plusPath, "diff");
      const file = await workspace.resolveSecure(relative, isDeletion);
      const body = normalized.slice(
        header.index! + header[0]!.length,
        nextHeader ? nextHeader.index! : normalized.length,
      );
      if (isDeletion) {
        if (interim.has(file)) interim.delete(file);
        else {
          const rawCurrent = await readPatchableText(file, relative);
          originalContent.set(file, rawCurrent);
          assertExpectedHash(rawCurrent, expectedHashes[relative], relative);
        }
        operations.push({ kind: "delete", relative, file });
        lastBlockKind.set(file, "delete");
        continue;
      }
      const rawCurrent = interim.has(file) ? interim.get(file)! : await readPatchableText(file, relative);
      if (!interim.has(file)) {
        originalContent.set(file, rawCurrent);
        assertExpectedHash(rawCurrent, expectedHashes[relative], relative);
      }
      const updContent = applyHunksPreserving(rawCurrent, body, relative);
      interim.set(file, updContent);
      operations.push({ kind: "update", relative, file, content: updContent });
    }
  }

  // Collapse to one final action per file (last op wins, first-seen order).
  const finalActions = new Map<string, PatchOperation>();
  for (const operation of operations) finalActions.set(operation.file, operation);
  const changed: string[] = [];
  for (const operation of operations) {
    if (!changed.includes(operation.relative)) changed.push(operation.relative);
  }
  // Per-file display diffs against the pre-patch content (whole journey for
  // chained same-file blocks), so callers can show what actually changed.
  const changes: PatchChange[] = [];
  for (const operation of finalActions.values()) {
    const before = originalContent.get(operation.file) ?? "";
    const after = operation.kind === "delete" ? "" : operation.content ?? "";
    const raw = unifiedDiff(before, after);
    const stats = raw ? countDiffLines(raw) : { additions: 0, deletions: 0 };
    changes.push({
      path: operation.relative,
      action: operation.kind,
      additions: stats.additions,
      deletions: stats.deletions,
      diff: raw ? boundedText(raw, PATCH_DIFF_MAX_CHARS).text : "",
    });
  }
  // Pre-flight every target directory BEFORE any content changes, so one bad
  // path fails the patch without leaving earlier files already rewritten.
  for (const operation of finalActions.values()) {
    if (operation.kind !== "delete") await fs.mkdir(path.dirname(operation.file), { recursive: true });
  }
  // Apply, rolling back on failure: a crash partway (locked file, disk full)
  // used to leave a half-applied patch with no record of what landed. Files
  // this patch created are removed again; pre-existing files get their original
  // content back (writeText is atomic per file, so restores are too).
  //
  // "Existed before" is decided by the file's FIRST operation, never its last.
  // The blocks allow a legal `*** Add File: x` followed by `*** Update File: x`,
  // and collapsing to one final action per file made that chain look like an
  // update — so the rollback wrote "" into a file the patch itself had created
  // instead of removing it, leaving an empty file behind as the "restored" state.
  const filesExistedBefore = new Set<string>();
  {
    const seen = new Set<string>();
    for (const operation of operations) {
      if (seen.has(operation.file)) continue;
      seen.add(operation.file);
      if (operation.kind !== "add") filesExistedBefore.add(operation.file);
    }
  }
  const applied: string[] = [];
  try {
    for (const operation of finalActions.values()) {
      if (operation.kind === "delete") {
        await fs.unlink(operation.file);
      } else {
        await writeText(operation.file, operation.content ?? "");
      }
      // Recorded for BOTH kinds. A deletion is a content change like any other,
      // and skipping it here is what made the rollback claim to have restored
      // "the files it had already written" while the file it had already
      // DELETED stayed gone — even though originalContent held its bytes.
      applied.push(operation.file);
    }
  } catch (error) {
    for (const file of applied) {
      try {
        if (filesExistedBefore.has(file) && originalContent.has(file)) {
          await fs.writeFile(file, originalContent.get(file) ?? "", "utf8");
        } else {
          await fs.rm(file, { force: true });
        }
      } catch { /* best-effort rollback; the primary error is rethrown below */ }
    }
    throw new Error(
      `Patch aborted partway; the files it had already changed were restored `
      + `(deleted files recreated, created files removed). `
      + `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { changed, changes };
}
