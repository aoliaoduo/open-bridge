import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSnapshot, type TuiStateView } from "../src/console/tui/snapshot.js";
import { nextPanelView, panelScrollMetrics, renderFrame } from "../src/console/tui/render.js";
import { paint } from "../src/console/tui/theme.js";
import { stripAnsi, visualWidth } from "../src/console/tui/text.js";
import { git, gitAvailable } from "./lib/git.js";
import { tuiView } from "./lib/tui-view.js";
import {
  classifyGitError,
  collectFileDiffPreview,
  collectWorkspaceChanges,
  countTextLines,
  parseNumstatFiles,
  parsePorcelainLines,
  parsePorcelainZ,
  summarizeGitStatus,
} from "../src/console/tui/changes.js";

const NOW = 1_700_000_000_000;

function fixtureView(): TuiStateView {
  return tuiView({
    port: 12345,
    routeToken: "synthetic-changes-fixture",
    usage: { startedAt: NOW, calls: 0, successes: 0, failures: 0 },
  });
}

function byPath(summary: { entries?: Array<{ path: string; insertions: number; deletions: number; untracked?: boolean; binary?: boolean }> }, rel: string) {
  return summary.entries?.find(entry => entry.path.replaceAll("\\", "/") === rel);
}

test("countTextLines matches git: empty, trailing newline, binary", () => {
  assert.equal(countTextLines(Buffer.from("")), 0, "empty file is 0 lines, not a phantom 1");
  assert.equal(countTextLines(Buffer.from("hello\n")), 1, "one newline-terminated line is 1, not split('\\n').length === 2");
  assert.equal(countTextLines(Buffer.from("hello")), 1, "missing trailing newline still counts");
  assert.equal(countTextLines(Buffer.from("a\nb\n")), 2);
  assert.equal(countTextLines(Buffer.from("a\0b")), null, "NUL means binary — do not utf8-split it");
});

test("parsePorcelainZ expands untracked files and keeps quoted-unsafe paths intact", () => {
  const entries = parsePorcelainZ("?? dir/a.txt\0?? my file.txt\0 M tracked.ts\0");
  assert.deepEqual(entries.map(entry => entry.path), ["dir/a.txt", "my file.txt", "tracked.ts"]);
  // Real git order, measured: `git status --porcelain -z` emits
  // `R  <new>\0<old>\0` — the NEW path sits inside the status record and the
  // ORIGINAL path follows as its own token ("the field order is reversed").
  // The fixture below used the display-form order, so the parser returned the
  // old path and the changes page listed a file that no longer exists.
  const renamed = parsePorcelainZ("R  new.txt\0old.txt\0");
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0]?.path, "new.txt", "the listed path is the one on disk");
});

test("parsePorcelainLines keys a display-form rename by its new path", () => {
  // Without -z git writes `XY ORIG -> NEW`; the path after the arrow is what
  // exists on disk.
  const entries = parsePorcelainLines("R  old.txt -> new.txt\n");
  assert.deepEqual(entries, [{ xy: "R ", path: "new.txt" }]);
});

test("a staged rename joins numstat by the new path and lists it under the new path", async () => {
  // Measured shapes: porcelain -z `R  new\0old\0`, but numstat -z
  // `N\tM\t\0old\0new\0` — the OPPOSITE order. Both sides must meet on the
  // new path: the old one is a file that no longer exists, and keying by it
  // made Enter open `git diff HEAD -- <old>` and read "the whole file was
  // deleted" for a plain rename.
  const summary = await summarizeGitStatus({
    statusOut: "R  src/new.ts\0src/old.ts\0",
    numstatOut: "2\t1\t\0src/old.ts\0src/new.ts\0",
    readFile: async () => {
      throw new Error("rename rows are never read as untracked content");
    },
  });
  assert.ok(summary);
  const entry = byPath(summary, "src/new.ts");
  assert.ok(entry, "the rename is listed under the path that exists on disk");
  assert.equal(entry?.insertions, 2, "the numstat counts join onto the new path");
  assert.equal(entry?.deletions, 1);
});

test("parseNumstatFiles ignores binary dashes and still sums text files", () => {
  const counted = parseNumstatFiles("3\t1\tsrc/a.ts\n-\t-\tpic.bin\n2\t0\tmy file.txt\n").reduce(
    (acc, file) => ({ insertions: acc.insertions + file.insertions, deletions: acc.deletions + file.deletions }),
    { insertions: 0, deletions: 0 },
  );
  assert.equal(counted.insertions, 5);
  assert.equal(counted.deletions, 1);
});

test("timeouts and missing git are different facts", () => {
  assert.equal(classifyGitError({ killed: true, code: null }), "unavailable");
  assert.equal(classifyGitError({ code: "ETIMEDOUT" }), "unavailable");
  assert.equal(classifyGitError({ code: "ENOENT" }), "no-git");
  assert.equal(classifyGitError({ code: 128, message: "fatal: not a git repository" }), "no-git");
});

test("summarizeGitStatus: empty untracked + trailing newline + space path + binary", async () => {
  const files = new Map<string, Buffer>([
    ["empty.txt", Buffer.from("")],
    ["tail.txt", Buffer.from("hello\n")],
    ["my file.txt", Buffer.from("one\ntwo\n")],
    ["pic.bin", Buffer.from("a\0b\0c")],
  ]);
  const porcelain = ["?? empty.txt", "?? tail.txt", "?? \"my file.txt\"", "?? pic.bin"].join("\n");
  const summary = await summarizeGitStatus({
    statusOut: porcelain,
    numstatOut: "",
    readFile: async rel => {
      const buf = files.get(rel);
      if (!buf) throw new Error(`missing ${rel}`);
      return buf;
    },
  });
  assert.ok(summary);
  assert.equal(summary.unavailable, undefined);
  assert.equal(summary.files, 4, "each untracked path is a file, including the quoted space path");
  assert.equal(summary.insertions, 0 + 1 + 2 + 0, "empty=0, hello\\n=1, two lines=2, binary=0 — never split('\\n') phantoms");
  assert.equal(summary.deletions, 0);
  assert.equal(byPath(summary, "empty.txt")?.insertions, 0);
  assert.equal(byPath(summary, "my file.txt")?.untracked, true);
  assert.equal(byPath(summary, "pic.bin")?.binary, true);
});

test("summarizeGitStatus: untracked directory listing is not collapsed", async () => {
  const summary = await summarizeGitStatus({
    statusOut: "?? nested/a.txt\0?? nested/b.txt\0",
    numstatOut: "",
    readFile: async rel => Buffer.from(rel.endsWith("a.txt") ? "aaa\n" : "b\nc\n"),
  });
  assert.equal(summary?.files, 2, "default porcelain would have reported nested/ as 1");
  assert.equal(summary?.insertions, 1 + 2);
  assert.equal(summary?.entries?.map(entry => entry.path).join(","), "nested/a.txt,nested/b.txt");
});

test("summarizeGitStatus: a timeout is 读取失败, not 非 git", async () => {
  const missing = await summarizeGitStatus({
    statusError: { code: 128, message: "fatal: not a git repository (or any of the parent directories): .git" },
    readFile: async () => Buffer.from(""),
  });
  assert.equal(missing, undefined, "no repository stays undefined so the renderer can say 非 git");

  const timedOut = await summarizeGitStatus({
    statusError: { killed: true, code: null, message: "killed" },
    readFile: async () => Buffer.from(""),
  });
  assert.equal(timedOut?.unavailable, true);
  assert.equal(timedOut?.files, 0);
});

test("the sidebar names 读取失败 without dropping the resident 变更 row", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
    workspaceChanges: { files: 0, insertions: 0, deletions: 0, unavailable: true },
  });
  const joined = renderFrame(snap, { width: 110, height: 30, now: 60_000 }).map(stripAnsi).join("\n");
  assert.match(joined, /变更\s+读取失败/, "a failed read is named, never silently turned into 非 git");
  assert.doesNotMatch(joined, /非 git/, "timeouts must not impersonate a missing repository");
});

test("dirty and clean rows keep their red/green signs", () => {
  const dirty = buildSnapshot(fixtureView(), {
    version: "v",
    rootName: "r",
    logPath: "l",
    now: 60_000,
    workspaceChanges: { files: 2, insertions: 53, deletions: 18 },
  });
  const raw = renderFrame(dirty, { width: 110, height: 30, now: 60_000 }).join("\n");
  assert.ok(raw.includes(paint("success", "+53")), "insertions stay green");
  assert.ok(raw.includes(paint("error", "-18")), "deletions stay red");
});

test("Tab cycles activity → tasks → changes", () => {
  assert.equal(nextPanelView("activity"), "tasks");
  assert.equal(nextPanelView("tasks"), "changes");
  assert.equal(nextPanelView("changes"), "activity");
});

test("the changes panel lists each path with its own +/- and keeps the sidebar summary", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "1.0.0-rc.2",
    rootName: "open-bridge",
    logPath: "C:/x/bridge.log",
    now: 60_000,
    workspaceChanges: {
      files: 3,
      insertions: 6,
      deletions: 1,
      entries: [
        { path: "src/a.ts", insertions: 3, deletions: 1 },
        { path: "my file.txt", insertions: 2, deletions: 0, untracked: true },
        { path: "nested/b.txt", insertions: 1, deletions: 0, untracked: true },
      ],
    },
  });
  const lines = renderFrame(snap, { width: 110, height: 30, now: 60_000, panelView: "changes" });
  assert.equal(lines.length, 30);
  for (const [i, line] of lines.entries()) {
    assert.equal(visualWidth(line), 110, `change line ${i} must be exactly 110 columns`);
  }
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /─ 变更 \(3\)/, "the wide panel belongs to the file list");
  assert.doesNotMatch(text, /Tab 任务|Tab 变更|Tab 返回活动|Tab 活动/, "the title row does not advertise the Tab cycle");
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /my file\.txt/);
  assert.match(text, /nested\/b\.txt/);
  assert.match(text, /未跟踪/);
  assert.ok(lines.join("\n").includes(paint("success", "+3")), "per-file insertions stay green");
  assert.ok(lines.join("\n").includes(paint("error", "-1")), "per-file deletions stay red");
  assert.match(text, /变更\s+\+6/, "the sidebar summary is still a resident");
  assert.doesNotMatch(text, /EVENT_|暂无任务/, "the file list does not leak the other views");
});

test("the changes panel is a one-file-per-row cursor list", () => {
  const longPath = `nested/${"very-long-segment/".repeat(12)}tail.ts`;
  const snap = buildSnapshot(fixtureView(), {
    version: "v", rootName: "r", logPath: "l", now: 60_000,
    workspaceChanges: {
      files: 2, insertions: 3, deletions: 1,
      entries: [
        { path: longPath, insertions: 2, deletions: 1 },
        { path: "selected.ts", insertions: 1, deletions: 0 },
      ],
    },
  });
  const metrics = panelScrollMetrics(snap, { width: 110, height: 30, panelView: "changes" });
  assert.equal(metrics.totalRows, 2, "long paths truncate instead of consuming extra selection rows");
  const frame = renderFrame(snap, { width: 110, height: 30, panelView: "changes", changeCursor: 1 });
  const selected = frame.find(line => stripAnsi(line).includes("selected.ts")) ?? "";
  assert.ok(selected.includes("\x1b[1m"), "the current file is visibly highlighted");
  const text = frame.map(stripAnsi).join("\n");
  assert.match(text, /↑↓ 选择/);
  assert.match(text, /Enter 文件 diff/);
  assert.match(text, /d 累计/);
});

test("a narrow changes view owns the body the way the task view does", () => {
  const snap = buildSnapshot(fixtureView(), {
    version: "v",
    rootName: "r",
    logPath: "l",
    now: 60_000,
    workspaceChanges: {
      files: 2,
      insertions: 2,
      deletions: 0,
      entries: [
        { path: "nested/a.txt", insertions: 1, deletions: 0, untracked: true },
        { path: "nested/b.txt", insertions: 1, deletions: 0, untracked: true },
      ],
    },
  });
  const lines = renderFrame(snap, { width: 60, height: 12, now: 60_000, panelView: "changes" }).map(stripAnsi);
  const joined = lines.join("\n");
  assert.match(joined, /nested\/a\.txt/);
  assert.doesNotMatch(joined, /概览/, "narrow changes view does not keep overview cards");
  assert.equal(panelScrollMetrics(snap, { width: 60, height: 12, panelView: "changes" }).totalRows >= 2, true);
});

test("clean / missing git / failed read have named empty states on the changes page", () => {
  const clean = buildSnapshot(fixtureView(), {
    version: "v", rootName: "r", logPath: "l", now: 60_000,
    workspaceChanges: { files: 0, insertions: 0, deletions: 0, entries: [] },
  });
  assert.match(renderFrame(clean, { width: 110, height: 30, now: 60_000, panelView: "changes" }).map(stripAnsi).join("\n"), /暂无变更/);

  const missing = buildSnapshot(fixtureView(), {
    version: "v", rootName: "r", logPath: "l", now: 60_000,
  });
  assert.match(renderFrame(missing, { width: 110, height: 30, now: 60_000, panelView: "changes" }).map(stripAnsi).join("\n"), /非 git/);

  const failed = buildSnapshot(fixtureView(), {
    version: "v", rootName: "r", logPath: "l", now: 60_000,
    workspaceChanges: { files: 0, insertions: 0, deletions: 0, unavailable: true },
  });
  assert.match(renderFrame(failed, { width: 110, height: 30, now: 60_000, panelView: "changes" }).map(stripAnsi).join("\n"), /读取失败/);
});

test("collectWorkspaceChanges against an isolated git repository", async (t) => {
  if (!gitAvailable()) {
    t.skip("git is not on PATH");
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "ob-tui-git-"));
  git(dir, ["init"]);
  try { git(dir, ["checkout", "-b", "main"]); } catch { /* already on main */ }
  writeFileSync(path.join(dir, "tracked.txt"), "one\n");
  writeFileSync(path.join(dir, "literal[1].txt"), "magic old\n");
  writeFileSync(path.join(dir, "literal1.txt"), "plain old\n");
  git(dir, ["add", "--all"]);
  git(dir, ["commit", "-m", "seed"]);

  writeFileSync(path.join(dir, "tracked.txt"), "one\ntwo\n");
  writeFileSync(path.join(dir, "literal[1].txt"), "magic old\nmagic changed\n");
  writeFileSync(path.join(dir, "literal1.txt"), "plain old\nplain changed\n");
  mkdirSync(path.join(dir, "nested"));
  writeFileSync(path.join(dir, "nested", "a.txt"), "aaa\n");
  writeFileSync(path.join(dir, "nested", "b.txt"), "b\n");
  writeFileSync(path.join(dir, "empty.txt"), "");
  writeFileSync(path.join(dir, "tail.txt"), "hello\n");
  writeFileSync(path.join(dir, "my file.txt"), "x\ny\n");
  writeFileSync(path.join(dir, "pic.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));

  const summary = await collectWorkspaceChanges(dir);
  assert.ok(summary, "a real repository is never reported as 非 git");
  assert.equal(summary.unavailable, undefined);
  // Three tracked modifications + nested/a + nested/b + empty + tail + "my file.txt" + pic.bin
  assert.equal(summary.files, 9, "untracked directory must expand; space path and empty file each count");
  // Each tracked file is +1; untracked: a=1, b=1, empty=0, tail=1, my file=2, binary=0.
  assert.equal(summary.insertions, 1 + 1 + 1 + 1 + 1 + 0 + 1 + 2 + 0);
  assert.equal(summary.deletions, 0);
  assert.equal(summary.entries?.length, 9);
  assert.equal(byPath(summary, "tracked.txt")?.insertions, 1);
  assert.equal(byPath(summary, "tracked.txt")?.untracked, undefined);
  assert.equal(byPath(summary, "nested/a.txt")?.untracked, true);
  assert.equal(byPath(summary, "nested/b.txt")?.insertions, 1);
  assert.equal(byPath(summary, "empty.txt")?.insertions, 0);
  assert.equal(byPath(summary, "my file.txt")?.insertions, 2);
  assert.equal(byPath(summary, "pic.bin")?.binary, true);

  const trackedPreview = await collectFileDiffPreview(dir, { path: "tracked.txt", insertions: 1, deletions: 0 });
  assert.equal(trackedPreview.ok, true);
  if (trackedPreview.ok) {
    assert.match(trackedPreview.text, /^\+two$/m, "the selected tracked file gets its own HEAD-to-worktree diff");
    assert.doesNotMatch(trackedPreview.text, /nested\/a\.txt/, "other changed files never leak into the detail");
  }
  const literalPreview = await collectFileDiffPreview(dir, { path: "literal[1].txt", insertions: 1, deletions: 0 });
  assert.equal(literalPreview.ok, true);
  if (literalPreview.ok) {
    assert.match(literalPreview.text, /^\+magic changed$/m);
    assert.doesNotMatch(literalPreview.text, /plain changed/, "pathspec metacharacters remain literal");
  }
  const untrackedPreview = await collectFileDiffPreview(dir, { path: "my file.txt", insertions: 2, deletions: 0, untracked: true });
  assert.equal(untrackedPreview.ok, true);
  if (untrackedPreview.ok) {
    assert.match(untrackedPreview.text, /my file\.txt/);
    assert.match(untrackedPreview.text, /^\+x$/m);
    assert.match(untrackedPreview.text, /^\+y$/m);
  }
  const emptyPreview = await collectFileDiffPreview(dir, { path: "empty.txt", insertions: 0, deletions: 0, untracked: true });
  assert.equal(emptyPreview.ok, true);
  if (emptyPreview.ok) assert.match(emptyPreview.text, /new file mode/, "an empty untracked file still has a useful creation preview");
  const binaryPreview = await collectFileDiffPreview(dir, { path: "pic.bin", insertions: 0, deletions: 0, untracked: true, binary: true });
  assert.equal(binaryPreview.ok, true);
  if (binaryPreview.ok) assert.match(binaryPreview.text, /Binary files/);
  const boundedPreview = await collectFileDiffPreview(dir, { path: "my file.txt", insertions: 2, deletions: 0, untracked: true }, 40);
  assert.equal(boundedPreview.ok, true);
  if (boundedPreview.ok) assert.equal(boundedPreview.truncated, true, "large file diffs honor the preview budget");

  const unbornDir = mkdtempSync(path.join(tmpdir(), "ob-tui-git-unborn-"));
  git(unbornDir, ["init"]);
  writeFileSync(path.join(unbornDir, "staged.txt"), "first revision\n");
  git(unbornDir, ["add", "staged.txt"]);
  const unbornPreview = await collectFileDiffPreview(unbornDir, { path: "staged.txt", insertions: 1, deletions: 0 });
  assert.equal(unbornPreview.ok, true);
  if (unbornPreview.ok) assert.match(unbornPreview.text, /^\+first revision$/m, "a staged file is useful before the first commit");

  const cleanDir = mkdtempSync(path.join(tmpdir(), "ob-tui-git-clean-"));
  git(cleanDir, ["init"]);
  try { git(cleanDir, ["checkout", "-b", "main"]); } catch { /* already on main */ }
  writeFileSync(path.join(cleanDir, "ok.txt"), "ok\n");
  git(cleanDir, ["add", "ok.txt"]);
  git(cleanDir, ["commit", "-m", "clean"]);
  const clean = await collectWorkspaceChanges(cleanDir);
  assert.deepEqual(clean, { files: 0, insertions: 0, deletions: 0, entries: [] });

  const plain = mkdtempSync(path.join(tmpdir(), "ob-tui-nongit-"));
  writeFileSync(path.join(plain, "x.txt"), "x\n");
  const missing = await collectWorkspaceChanges(plain);
  assert.equal(missing, undefined, "a folder without .git is 非 git");
});
