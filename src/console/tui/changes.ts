/**
 * Workspace-change summary for the serve-console TUI sidebar and the
 * Tab 「变更」 file list.
 *
 * The 500 ms render tick only reads a cached value; git and file IO live here
 * so they can be tested without a TTY. A missing git / non-repository is a
 * different fact from a timeout or a partial read — the sidebar names them
 * separately (非 git vs 读取失败).
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { reviewChanges } from "../../bridge/tools/review.js";
import { parseNumstat } from "../../mcp/review-parse.js";
import { boundedText, unifiedDiff } from "../../mcp/line-diff.js";

const execFile = promisify(execFileCallback);

export type ChangeFile = {
  path: string;
  insertions: number;
  deletions: number;
  untracked?: boolean;
  binary?: boolean;
};
export type ChangeCounts = { files: number; insertions: number; deletions: number };
export type ChangeSummary = ChangeCounts & { unavailable?: boolean; entries?: ChangeFile[] };

const STATUS_TIMEOUT_MS = 5000;
const NUMSTAT_TIMEOUT_MS = 5000;
const FILE_DIFF_TIMEOUT_MS = 10_000;
const UNTRACKED_FILE_CAP = 512 * 1024;
const UNTRACKED_READ_BUDGET = 2 * 1024 * 1024;

type GitLikeError = { code?: string | number | null; killed?: boolean; message?: string; stdout?: string; stderr?: string };

export function classifyGitError(error: GitLikeError): "no-git" | "unavailable" {
  if (error.killed === true || error.code === "ETIMEDOUT") return "unavailable";
  if (error.code === "ENOENT") return "no-git";
  if (error.code === 128 || error.code === "128") return "no-git";
  const blob = `${error.message ?? ""}\n${error.stderr ?? ""}\n${error.stdout ?? ""}`;
  if (/not a git repository/i.test(blob)) return "no-git";
  return "unavailable";
}

/** Git-style text line count: empty is 0; a missing trailing newline still counts as a line. */
export function countTextLines(buf: Buffer): number | null {
  if (buf.includes(0)) return null;
  if (buf.byteLength === 0) return 0;
  let lines = 0;
  for (const byte of buf) if (byte === 10) lines += 1;
  if (buf[buf.byteLength - 1] !== 10) lines += 1;
  return lines;
}

export function parsePorcelainZ(output: string): Array<{ xy: string; path: string }> {
  const parts = output.split("\0").filter(part => part.length > 0);
  const entries: Array<{ xy: string; path: string }> = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (part.length < 3) continue;
    const xy = part.slice(0, 2);
    const filePath = part.slice(3);
    if (xy.startsWith("R") || xy.startsWith("C")) {
      // git-status -z reverses the display order: the NEW path sits inside the
      // status record and the ORIGINAL path follows as its own NUL token.
      // Keying by the following token displayed the file under the old path —
      // one that no longer exists on disk — and sent the diff preview after
      // it. numstat -z keeps the display order (old first, see
      // parseNumstatFiles), so the NEW path is the join key on both sides.
      i += 1;
      entries.push({ xy, path: filePath });
    } else {
      entries.push({ xy, path: filePath });
    }
  }
  return entries;
}

export function parseNumstatFiles(output: string): Array<{ path: string; insertions: number; deletions: number; binary: boolean }> {
  const files: Array<{ path: string; insertions: number; deletions: number; binary: boolean }> = [];
  const push = (added: string, removed: string, filePath: string): void => {
    if (filePath.length === 0) return;
    const binary = added === "-" || removed === "-";
    const insertions = binary ? 0 : Number(added);
    const deletions = binary ? 0 : Number(removed);
    if (!binary && (!Number.isFinite(insertions) || !Number.isFinite(deletions))) return;
    files.push({ path: filePath, insertions, deletions, binary });
  };

  if (output.includes("\0")) {
    // NUL mode is `git diff --numstat -z`, parsed by the same shared parser the
    // review_changes tool consumes (mcp/review-parse.ts) so both surfaces read
    // the records identically. A numstat -z rename keeps the display order —
    // OLD path first, NEW path second — while parsePorcelainZ keys its rows by
    // the NEW path, so both sides meet there and the two tables stay joinable
    // per file.
    for (const entry of parseNumstat(output)) {
      files.push({
        path: entry.path,
        insertions: entry.additions,
        deletions: entry.deletions,
        binary: entry.binary === true,
      });
    }
    return files;
  }

  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const tabs = line.split("\t");
    const added = tabs[0] ?? "0";
    const removed = tabs[1] ?? "0";
    let filePath = tabs.slice(2).join("\t");
    const arrow = filePath.lastIndexOf(" => ");
    if (arrow >= 0) filePath = filePath.slice(arrow + 4);
    push(added, removed, filePath);
  }
  return files;
}

export function parsePorcelainLines(output: string): Array<{ xy: string; path: string }> {
  return output.split(/\r?\n/).filter(line => line.length > 0).map(line => {
    // Display-form renames are `XY ORIG -> NEW` (git-status, non -z); the path
    // after the arrow is the one on disk.
    const raw = line.slice(3).replace(/^"(.*)"$/, "$1");
    const arrow = raw.lastIndexOf(" -> ");
    return { xy: line.slice(0, 2), path: arrow >= 0 ? raw.slice(arrow + 4) : raw };
  });
}

export async function summarizeGitStatus(args: {
  statusError?: GitLikeError | null;
  statusOut?: string | null;
  numstatError?: GitLikeError | null;
  numstatOut?: string | null;
  readFile: (rel: string) => Promise<Buffer>;
}): Promise<ChangeSummary | undefined> {
  if (args.statusError) {
    return classifyGitError(args.statusError) === "no-git"
      ? undefined
      : { files: 0, insertions: 0, deletions: 0, unavailable: true };
  }
  if (typeof args.statusOut !== "string") {
    return { files: 0, insertions: 0, deletions: 0, unavailable: true };
  }

  const porcelain = args.statusOut.includes("\0")
    ? parsePorcelainZ(args.statusOut)
    : parsePorcelainLines(args.statusOut);

  if (args.numstatError && classifyGitError(args.numstatError) === "unavailable") {
    return { files: 0, insertions: 0, deletions: 0, unavailable: true };
  }

  const numstatFiles = typeof args.numstatOut === "string" ? parseNumstatFiles(args.numstatOut) : [];
  const numstatByPath = new Map(numstatFiles.map(file => [file.path, file]));

  const entries: ChangeFile[] = [];
  let insertions = 0;
  let deletions = 0;
  let budget = UNTRACKED_READ_BUDGET;

  for (const entry of porcelain) {
    if (entry.xy === "??") {
      let add = 0;
      let binary = false;
      try {
        const buf = await args.readFile(entry.path);
        if (buf.includes(0)) binary = true;
        else if (buf.byteLength <= UNTRACKED_FILE_CAP && budget > 0) {
          budget -= buf.byteLength;
          add = countTextLines(buf) ?? 0;
        }
      } catch {
        // Deleted between status and read — still listed.
      }
      entries.push({ path: entry.path, insertions: add, deletions: 0, untracked: true, ...(binary ? { binary: true } : {}) });
      insertions += add;
      continue;
    }
    const counted = numstatByPath.get(entry.path);
    const add = counted?.insertions ?? 0;
    const del = counted?.deletions ?? 0;
    entries.push({ path: entry.path, insertions: add, deletions: del, ...(counted?.binary ? { binary: true } : {}) });
    insertions += add;
    deletions += del;
  }

  return entries.length > 0
    ? { files: entries.length, insertions, deletions, entries }
    : { files: 0, insertions: 0, deletions: 0, entries: [] };
}

function errorBlob(error: GitLikeError): string {
  return `${error.message ?? ""}\n${error.stderr ?? ""}\n${error.stdout ?? ""}`;
}

function isMissingHead(error: GitLikeError): boolean {
  return /bad revision|unknown revision|ambiguous argument 'HEAD'/i.test(errorBlob(error));
}

async function gitOutput(
  root: string,
  args: string[],
  timeout: number,
  missingHeadIsEmpty = true,
): Promise<{ ok: true; stdout: string } | { ok: false; error: GitLikeError }> {
  try {
    const { stdout } = await execFile("git", ["-C", root, "-c", "core.quotepath=off", ...args], {
      timeout,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout: typeof stdout === "string" ? stdout : "" };
  } catch (error) {
    const err = error as GitLikeError;
    if (missingHeadIsEmpty && isMissingHead(err)) {
      return { ok: true, stdout: "" };
    }
    return { ok: false, error: err };
  }
}

/** Probe a workspace: undefined means 非 git; unavailable is a failed read of a repo. */
export async function collectWorkspaceChanges(root: string): Promise<ChangeSummary | undefined> {
  const status = await gitOutput(root, ["status", "--porcelain=v1", "-z", "-uall"], STATUS_TIMEOUT_MS);
  if (!status.ok) {
    return classifyGitError(status.error) === "no-git"
      ? undefined
      : { files: 0, insertions: 0, deletions: 0, unavailable: true };
  }
  const numstat = await gitOutput(root, ["diff", "--numstat", "-z", "HEAD"], NUMSTAT_TIMEOUT_MS);
  if (!numstat.ok && classifyGitError(numstat.error) === "unavailable") {
    return { files: 0, insertions: 0, deletions: 0, unavailable: true };
  }
  return summarizeGitStatus({
    statusOut: status.stdout,
    numstatOut: numstat.ok ? numstat.stdout : "",
    readFile: rel => fs.readFile(path.join(root, rel)),
  });
}

export type ReviewDiffPreview =
  | { ok: true; text: string; truncated: boolean; since: string; checkpoint: string }
  | { ok: false; reason: string };

/**
 * 累计 diff 预览（TUI 变更页按 d）：review_changes 的只读面。
 * mark_reviewed:false 让审阅基线原地不动 —— 看多少次都不改变 AI 下次
 * 「自上次审阅以来」的口径。首次调用会建立检查点（一次性写入两个 ref）。
 */
export async function collectReviewDiffPreview(maxPatchBytes = 24_000): Promise<ReviewDiffPreview> {
  try {
    const result = await reviewChanges({ max_patch_bytes: maxPatchBytes, mark_reviewed: false }) as {
      available?: boolean; reason?: string; patch?: string; patch_truncated?: boolean; since?: string; checkpoint_action?: string;
    };
    if (!result.available) return { ok: false, reason: String(result.reason ?? "变更摘要不可用") };
    return {
      ok: true,
      text: String(result.patch ?? ""),
      truncated: result.patch_truncated === true,
      since: String(result.since ?? ""),
      checkpoint: String(result.checkpoint_action ?? ""),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export type FileDiffPreview =
  | { ok: true; path: string; text: string; truncated: boolean }
  | { ok: false; path: string; reason: string };

function fallbackUntrackedPatch(root: string, filePath: string): Promise<string> {
  return fs.readFile(path.join(root, filePath)).then(buf => {
    const shownPath = filePath.replaceAll("\\", "/");
    const header = [`diff --git a/${shownPath} b/${shownPath}`, "new file mode 100644"];
    if (buf.includes(0)) return [...header, `Binary files /dev/null and b/${shownPath} differ`].join("\n");
    const body = unifiedDiff("", buf.toString("utf8"));
    return [...header, "--- /dev/null", `+++ b/${shownPath}`, ...(body === undefined ? [] : [body])].join("\n");
  });
}

/** Current working-tree diff for one row in the TUI changes list. */
export async function collectFileDiffPreview(
  root: string,
  file: ChangeFile,
  maxPatchBytes = 24_000,
): Promise<FileDiffPreview> {
  const requested = Number(maxPatchBytes);
  const limit = Math.max(0, Math.min(
    Number.isFinite(requested) && requested >= 0 ? Math.floor(requested) : 24_000,
    512 * 1024,
  ));
  const args = file.untracked
    ? ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file.path]
    : ["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "HEAD", "--", file.path];
  const result = await gitOutput(root, args, FILE_DIFF_TIMEOUT_MS, false);
  const missingHead = !result.ok && !file.untracked && isMissingHead(result.error);

  let patch = "";
  let incomplete = false;
  if (result.ok) {
    patch = result.stdout;
  } else {
    const partial = typeof result.error.stdout === "string" ? result.error.stdout : "";
    const expectedDifference = file.untracked && (result.error.code === 1 || result.error.code === "1");
    const maxBuffer = /maxbuffer|stdout maxbuffer length exceeded/i.test(result.error.message ?? "");
    if (partial !== "" && (expectedDifference || maxBuffer)) {
      patch = partial;
      incomplete = maxBuffer;
    } else if (file.untracked || missingHead) {
      try {
        patch = await fallbackUntrackedPatch(root, file.path);
      } catch (error) {
        return { ok: false, path: file.path, reason: error instanceof Error ? error.message : String(error) };
      }
    } else {
      const reason = (result.error.stderr ?? result.error.message ?? "读取文件 diff 失败").trim();
      return { ok: false, path: file.path, reason: reason || "读取文件 diff 失败" };
    }
  }

  // Git considers /dev/null and an empty untracked file identical. The file is
  // still a real changes-list row, so retain a useful creation header.
  if (file.untracked && patch === "") {
    try {
      patch = await fallbackUntrackedPatch(root, file.path);
    } catch (error) {
      return { ok: false, path: file.path, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const bounded = boundedText(patch, limit);
  return { ok: true, path: file.path, text: bounded.text, truncated: bounded.truncated || incomplete };
}
