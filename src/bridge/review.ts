/**
 * Git-ref-backed cumulative review checkpoints (DevSpace-inspired): answers
 * "what has the AI changed since I last looked" as ONE cumulative diff —
 * covering every edit path (edit_block, write_file, apply_patch) AND
 * shell-command side effects, which per-tool diffs cannot.
 *
 * Mechanism (pure git plumbing, zero working-dir disturbance):
 * - a temporary GIT_INDEX_FILE snapshots the working tree via
 *   read-tree HEAD + add -A + write-tree + commit-tree -p <parent>;
 * - snapshot commits live only under refs/openbridge/review/* — never in
 *   the user's history;
 * - the `open` ref anchors workspace state at first review; the `baseline`
 *   ref anchors the last shown state and advances after each review.
 *
 * Checkpoints are namespaced PER WORKSPACE FOLDER (refs carry a hash of the
 * workspace root): two windows on different subfolders of one repository no
 * longer advance each other's baseline, and `git add -A` runs with the
 * WORKSPACE as cwd so a subfolder workspace never reports changes to files
 * outside it.
 *
 * Pure parsing helpers live in mcp/review-parse.ts (unit-testable without
 * vscode; this module is excluded from plain-node unit tests).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedText } from "../mcp/line-diff.js";
import { buildReviewFiles, parseNameStatus, parseNumstat, summarizeFiles, type ReviewFile, type ReviewSummary } from "../mcp/review-parse.js";
import { workspaceContext } from "./state.js";
import type { JsonArgs } from "./json-args.js";

const execFileAsync = promisify(execFile);

const REVIEW_REF_PREFIX = "refs/openbridge/review";
const DEFAULT_PATCH_BYTES = 65_536;

export type { ReviewFile, ReviewSummary };

async function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** Locate the repository root for the workspace, or null outside a repo. */
async function gitRootFor(workspaceRoot: string): Promise<string | null> {
  try {
    return (await git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

async function refCommit(gitRoot: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Per-workspace checkpoint refs so concurrent windows/subfolders stay isolated. */
function reviewRefs(workspaceRoot: string): { open: string; baseline: string } {
  const scope = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return {
    open: `${REVIEW_REF_PREFIX}/${scope}/open`,
    baseline: `${REVIEW_REF_PREFIX}/${scope}/baseline`,
  };
}

/**
 * Snapshot the working tree into a throwaway commit (temp index; HEAD must
 * resolve). `add -A` runs with cwd = scopeDir (the workspace folder) so only
 * changes inside the workspace are captured, never sibling folders of the same
 * repository.
 */
async function snapshotWorkingTree(gitRoot: string, parent: string, scopeDir: string): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "openbridge-review-index-"));
  const indexPath = join(tempDir, "index");
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "OpenBridge",
    GIT_AUTHOR_EMAIL: "openbridge@users.noreply.local",
    GIT_COMMITTER_NAME: "OpenBridge",
    GIT_COMMITTER_EMAIL: "openbridge@users.noreply.local",
  };
  try {
    await git(gitRoot, ["read-tree", "HEAD"], { env });
    await git(scopeDir, ["add", "-A", "--", "."], { env });
    const tree = (await git(gitRoot, ["write-tree"], { env })).trim();
    return (await git(gitRoot, ["commit-tree", tree, "-p", parent, "-m", "OpenBridge review snapshot"], { env })).trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readReviewBetween(gitRoot: string, before: string, after: string): Promise<{ summary: ReviewSummary; files: ReviewFile[]; patch: string }> {
  const [patch, numstatRaw, nameStatusRaw] = await Promise.all([
    git(gitRoot, ["diff", "--no-color", before, after]),
    git(gitRoot, ["diff", "--numstat", "-z", before, after]),
    git(gitRoot, ["diff", "--name-status", "-z", before, after]),
  ]);
  // Classification comes from git's own name-status (A/M/D/R) so renames are
  // reported and "modified with only additions" is not mistaken for "new".
  const files = buildReviewFiles(parseNumstat(numstatRaw), parseNameStatus(nameStatusRaw));
  return { summary: summarizeFiles(files), files, patch };
}

/**
 * Show every workspace change since the last review (or since workspace open),
 * then advance the baseline to now when mark_reviewed is not false.
 * Non-git workspaces return { available: false, reason } instead of failing.
 */
export async function reviewChanges(args: JsonArgs): Promise<unknown> {
  const workspaceRoot = workspaceContext.root();
  const gitRoot = await gitRootFor(workspaceRoot);
  if (!gitRoot) {
    return { available: false, reason: "review_changes requires a Git workspace (open a folder inside a repository)." };
  }
  const head = await refCommit(gitRoot, "HEAD^{commit}");
  if (!head) {
    return { available: false, reason: "review_changes requires the repository to have at least one commit." };
  }

  const refs = reviewRefs(workspaceRoot);
  const openCommit = await refCommit(gitRoot, refs.open);
  const baselineCommit = await refCommit(gitRoot, refs.baseline);

  // `|| DEFAULT` treated an explicit 0 ("include no patch text") as unset and
  // silently served 64 KiB; validate instead of coercing.
  const requestedPatchBytes = Number(args.max_patch_bytes ?? DEFAULT_PATCH_BYTES);
  const maxPatchBytes = Math.max(0, Math.min(
    Number.isFinite(requestedPatchBytes) && requestedPatchBytes >= 0 ? Math.floor(requestedPatchBytes) : DEFAULT_PATCH_BYTES,
    512 * 1024,
  ));

  if (!openCommit || !baselineCommit) {
    // Anchor the open checkpoint at the current state when this workspace has
    // never been reviewed before.
    const initial = await snapshotWorkingTree(gitRoot, head, workspaceRoot);
    if (!openCommit) await git(gitRoot, ["update-ref", refs.open, initial]);
    if (!baselineCommit) await git(gitRoot, ["update-ref", refs.baseline, initial]);
    if (openCommit) {
      // Only the baseline was missing (e.g. the extension was killed between
      // the two update-ref calls of a previous first review). Do NOT silently
      // re-anchor and report "nothing changed": show everything since the
      // original open checkpoint and advance the rebuilt baseline past it.
      const review = await readReviewBetween(gitRoot, openCommit, initial);
      const bounded = boundedText(review.patch, maxPatchBytes);
      return {
        available: true,
        review_ref: initial,
        since: "workspace_open",
        summary: review.summary,
        files: review.files,
        patch: bounded.text,
        patch_truncated: bounded.truncated,
        baseline_advanced: true,
        note: "The previous review baseline was missing and has been rebuilt at the current state; the diff above covers everything since the workspace-open checkpoint.",
      };
    }
    return {
      available: true,
      review_ref: initial,
      since: "workspace_open",
      summary: { files: 0, additions: 0, deletions: 0 },
      files: [],
      patch: "",
      patch_truncated: false,
      note: "Review checkpoints established at the current workspace state. Call again after edits to see what changed.",
    };
  }

  const since = args.since === "workspace_open" ? "workspace_open" : "last_shown";
  const baselineRef = since === "workspace_open" ? refs.open : refs.baseline;
  const baseline = await refCommit(gitRoot, baselineRef);
  if (!baseline) {
    throw new Error(`Review checkpoint ${baselineRef} is missing; run review_changes once to re-establish it.`);
  }

  const snapshot = await snapshotWorkingTree(gitRoot, baseline, workspaceRoot);
  const review = await readReviewBetween(gitRoot, baseline, snapshot);

  const markReviewed = args.mark_reviewed !== false;
  if (markReviewed) {
    await git(gitRoot, ["update-ref", refs.baseline, snapshot]);
  }

  const bounded = boundedText(review.patch, maxPatchBytes);

  return {
    available: true,
    review_ref: snapshot,
    since,
    summary: review.summary,
    files: review.files,
    patch: bounded.text,
    patch_truncated: bounded.truncated,
    ...(markReviewed ? { baseline_advanced: true } : {}),
  };
}

// summarizeFiles is re-exported from review-parse for callers that aggregate.
export { summarizeFiles } from "../mcp/review-parse.js";
