/**
 * review_changes shells out to git, so its unit coverage was deliberately
 * zero ("this module shells out to git, so it has no unit tests" — review.ts).
 * These tests still refuse to mock the plumbing away: they drive the real git
 * commands against a throwaway repository, so checkpoint refs, the cumulative
 * diff and the baseline advance are exercised end to end without a bridge.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHost, type Host } from "../src/host/host.js";
import { reviewChanges } from "../src/bridge/tools/review.js";
import { collectReviewDiffPreview } from "../src/console/tui/changes.js";
import type { JsonArgs } from "../src/bridge/tools/json-args.js";

const run = promisify(execFile);

let repo: string;

async function git(args: string[], cwd: string = repo): Promise<void> {
  await run("git", args, { cwd });
}

function installHostFor(root: string): void {
  setHost({
    config: { get<T>(_key: string, fallback: T): T { return fallback; }, async update(): Promise<void> {} },
    secrets: { async get() { return undefined; }, async store() {} },
    state: { get<T>(_key: string, fallback: T): T { return fallback; }, async update() {} },
    storageDir: () => root,
    version: () => "test",
    bundledRipgrep: () => undefined,
    projectRoot: () => root,
    notify: () => {},
    log: () => {},
    ui: { update: () => {}, refresh: () => {} },
  } as Host);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ob-review-"));
  installHostFor(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function initRepo(): Promise<void> {
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "OpenBridge"]);
  await git(["config", "user.email", "openbridge@users.noreply.local"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  await git(["add", "."]);
  await git(["commit", "-m", "seed"]);
}

type ReviewResult = Record<string, unknown> & {
  available: boolean;
  reason?: string;
  since?: string;
  checkpoint_action?: string;
  baseline_advanced?: boolean;
  patch?: string;
  patch_truncated?: boolean;
  summary?: { files: number; additions: number; deletions: number };
  working_tree?: { clean: boolean; summary: { files: number } };
  note?: string;
};

const review = async (args: JsonArgs = {}): Promise<ReviewResult> =>
  await reviewChanges(args) as ReviewResult;

test("outside a repository the review is unavailable, not an error", async () => {
  const r = await review();
  assert.equal(r.available, false);
  assert.match(r.reason ?? "", /Git workspace/);
});

test("a repository without commits asks for history instead of failing", async () => {
  await git(["init", "-b", "main"]);
  const r = await review();
  assert.equal(r.available, false);
  assert.match(r.reason ?? "", /commit/);
});

test("first review establishes checkpoints on a clean tree", async () => {
  await initRepo();
  const r = await review();
  assert.equal(r.available, true);
  assert.equal(r.checkpoint_action, "established");
  assert.equal(r.since, "workspace_open");
  assert.deepEqual(r.summary, { files: 0, additions: 0, deletions: 0 });
  assert.equal(r.patch, "");
  assert.equal(r.patch_truncated, false);
});

test("uncommitted work is summarized as working_tree at establishment", async () => {
  await initRepo();
  writeFileSync(join(repo, "seed.txt"), "seed\nchanged\n");
  const r = await review();
  assert.equal(r.available, true);
  assert.equal(r.checkpoint_action, "established");
  assert.equal(r.working_tree?.clean, false);
  assert.equal(r.working_tree?.summary.files, 1);
});

test("second review shows the cumulative delta and advances the baseline", async () => {
  await initRepo();
  await review();
  writeFileSync(join(repo, "seed.txt"), "seed\nplus one\n");
  writeFileSync(join(repo, "new.txt"), "brand new\n");
  const r = await review();
  assert.equal(r.available, true);
  assert.equal(r.since, "last_shown");
  assert.equal(r.checkpoint_action, "advanced");
  assert.equal(r.baseline_advanced, true);
  assert.ok((r.summary?.files ?? 0) >= 2, "both edits belong in the summary");
  assert.match(r.patch ?? "", /\+plus one/);
  assert.match(r.patch ?? "", /brand new/);
  // Re-reviewing with no further edits reports an empty delta, not the old one.
  const again = await review();
  assert.equal(again.available, true);
  assert.equal(again.summary?.files, 0);
});

test("max_patch_bytes: 0 serves metadata without patch text", async () => {
  await initRepo();
  await review();
  writeFileSync(join(repo, "seed.txt"), "seed\nplus one\n");
  const r = await review({ max_patch_bytes: 0 });
  assert.equal(r.available, true);
  assert.equal(r.patch, "");
  assert.equal(r.patch_truncated, true);
});

test("since workspace_open keeps reporting against the open checkpoint", async () => {
  await initRepo();
  await review();
  writeFileSync(join(repo, "seed.txt"), "seed\nplus one\n");
  const r = await review({ since: "workspace_open" });
  assert.equal(r.available, true);
  assert.equal(r.since, "workspace_open");
  assert.ok((r.summary?.files ?? 0) >= 1);
});

test("the TUI diff preview reads without advancing the baseline", async () => {
  await initRepo();
  await review();
  writeFileSync(join(repo, "seed.txt"), "seed\nplus one\n");
  const first = await collectReviewDiffPreview();
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.match(first.text, /\+plus one/);
  assert.equal(first.since, "last_shown");
  assert.equal(first.checkpoint, "retained");
  // Re-reading is idempotent: the baseline stays where it was.
  const again = await collectReviewDiffPreview();
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.text, first.text);
});

test("the TUI diff preview names a non-git workspace", async () => {
  const plain = mkdtempSync(join(tmpdir(), "ob-plain-"));
  installHostFor(plain);
  try {
    const r = await collectReviewDiffPreview();
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /Git workspace/);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
