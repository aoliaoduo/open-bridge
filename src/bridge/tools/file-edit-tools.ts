import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { assertExpectedHash, sha256 } from "../../workspace/file-version.js";
import { applyEol, detectEol, toLf, type EolStyle } from "../../workspace/eol.js";
import { writeFileAtomic } from "../../workspace/persist.js";
import { findFuzzyMatch, formatFuzzyDiagnostics } from "../../mcp/fuzzy-match.js";
import { boundedText, unifiedDiff } from "../../mcp/line-diff.js";
import { securePath, rejectSymlink } from "../paths.js";
import type { JsonArgs } from "./json-args.js";
import { requiredFileArg } from "./file-tool-args.js";

type Args = JsonArgs;

/** Display-diff budget for edit_block results (head+tail bounded). */
const EDIT_DIFF_MAX_CHARS = 16_000;

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

/** How much of an existing file is sampled to learn its line-ending style. */
const APPEND_EOL_SAMPLE_BYTES = 64 * 1024;

/**
 * The line-ending style of a file that is about to be appended to, or null when
 * there is no file to match.
 *
 * Only a bounded tail is read: append targets tend to be logs, the style that
 * matters is the one used where the new bytes will land, and buffering a 2 GB
 * log to learn one fact would be absurd. The window can cut a CRLF pair in half,
 * so one byte of run-up is included when the window does not start at byte 0 —
 * otherwise a CRLF file could sample as LF-dominant and be appended to with the
 * wrong style, which is the bug this exists to prevent.
 */
async function existingEolStyle(file: string): Promise<EolStyle | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    if (size === 0) return null;
    const runUp = size > APPEND_EOL_SAMPLE_BYTES ? 1 : 0;
    const length = Math.min(size, APPEND_EOL_SAMPLE_BYTES) + runUp;
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buf, 0, length, size - length);
    return detectEol(buf.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function writeFile(args: Args): Promise<unknown> {
  const file = await securePath(requiredFileArg(args, "path"), true);
  // A silent fallback on a destructive switch is data loss: an unknown mode
  // (mode:"Append") used to fall through to overwrite and clobber the file it
  // was asked to append to. Unknown values get the error vocabulary's word
  // for them: Invalid.
  if (args.mode !== undefined && args.mode !== null && args.mode !== "append" && args.mode !== "overwrite") {
    throw new Error(`Invalid "mode" value ${JSON.stringify(String(args.mode))} for write_file. Expected one of: overwrite, append.`);
  }
  // A write with NEITHER payload silently truncated the target to zero bytes
  // (content defaulted to ""). Both payloads are optional in the schema only
  // so an explicit empty string can still create an empty file; a call that
  // forgets the payload entirely is a client bug and must error out.
  if (args.content_base64 == null && typeof args.content !== "string") {
    throw new Error("Missing one of \"content\" or \"content_base64\". write_file requires a text or Base64 payload. (expected 'content': string or 'content_base64': string)");
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
    //
    // Match the file's line endings instead of handing the caller's bytes to the
    // filesystem: appending "p3\n" to "p1\r\np2\r\n" used to leave the file
    // with two CRLF lines and one LF line, and every later diff of it noise.
    // `edit_block` and `apply_patch` already work this way. Nothing on disk is
    // rewritten -- only the appended text is normalized. The base64 branch above
    // is deliberately exempt: there the caller is writing bytes, not lines.
    const eol = await existingEolStyle(file);
    const appended = eol === null ? content : applyEol(content, eol);
    await fs.appendFile(file, appended);
    // Constant-memory hash of the appended file (streamed, so appending to a
    // large log never buffers the whole file just to report a sha256).
    return {
      path: String(args.path),
      bytes: Buffer.byteLength(appended, "utf8"),
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
  await writeFileAtomic(file, content);
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
  const file = await securePath(requiredFileArg(args, "path"));
  const hasSingle = args.old_text !== undefined || args.new_text !== undefined;
  const hasEdits = args.edits !== undefined;
  if (!hasSingle && !hasEdits) {
    throw new Error('Missing one of "old_text" or "edits". edit_block requires one edit mode; "new_text" is optional with "old_text".');
  }
  if (hasSingle && hasEdits) {
    throw new Error('Conflict: provide exactly one edit mode — "old_text" (with optional "new_text") or "edits".');
  }
  if (hasEdits) {
    const edits = args.edits;
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > 20) {
      throw new Error('Invalid "edits": expected an array of 1..20 items with "old_text" and optional "new_text".');
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
      const item = edits[i] as { old_text?: unknown; new_text?: unknown; path?: unknown };
      // Every hunk applies to "path" (and the lock plan protects exactly that
      // file). A per-edit path naming a DIFFERENT file used to be silently
      // ignored — the caller believed it had edited that file. Refuse instead.
      if (item.path !== undefined && String(item.path) !== String(args.path)) {
        throw new Error(
          `Invalid "edits[${i}].path": every hunk applies to "path" (${String(args.path)}); per-edit paths are not supported.`,
        );
      }
      const oldText = typeof item.old_text === "string" ? item.old_text : "";
      if (!oldText) {
        throw new Error(`Invalid "edits[${i}].old_text": expected a non-empty string.`);
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
    await writeFileAtomic(file, content);
    const diffRaw = unifiedDiff(raw, content);
    const diff = diffRaw ? boundedText(diffRaw, EDIT_DIFF_MAX_CHARS).text : undefined;
    return { path: String(args.path), replacements, sha256: sha256(content), applied_edits: edits.length, ...(diff ? { diff } : {}) };
  }
  const oldText = String(args.old_text ?? "");
  const newText = String(args.new_text ?? "");
  if (!oldText) {
    if (args.old_text === undefined || args.old_text === null) {
      throw new Error('Missing "old_text". edit_block single-edit mode requires text to find.');
    }
    throw new Error('Invalid "old_text": expected a non-empty string.');
  }
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
    throw new Error('Invalid "expected_replacements": expected a non-negative integer.');
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
  await writeFileAtomic(file, next);
  const diffRaw = unifiedDiff(raw, next);
  const diff = diffRaw ? boundedText(diffRaw, EDIT_DIFF_MAX_CHARS).text : undefined;
  return { path: String(args.path), replacements: count, sha256: sha256(next), ...(diff ? { diff } : {}) };
}
