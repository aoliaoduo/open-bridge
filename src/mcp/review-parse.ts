/**
 * Pure helpers for git numstat/name-status parsing and review summaries
 * (no vscode or bridge-state imports so they stay unit-testable in plain node).
 *
 * Real `git diff --numstat -z` output shapes (verified against git on this
 * machine):
 *   plain   change  -> "N\tM\tpath\0"
 *   binary  change  -> "-\t-\tpath\0"
 *   rename          -> "N\tM\t\0oldpath\0newpath\0"   <-- empty path slot!
 * `git diff --name-status -z`:
 *   A/M/D           -> "X\0path\0"
 *   R/C (rename/copy) -> "R<sim>\0oldpath\0newpath\0" (R + similarity number)
 */

export interface ReviewFile {
  path: string;
  previousPath?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  additions: number;
  deletions: number;
}

export interface ReviewSummary {
  files: number;
  additions: number;
  deletions: number;
}

/** One raw numstat row before type classification. */
export interface NumstatEntry {
  path: string;
  previousPath?: string;
  additions: number;
  deletions: number;
}

export type NameStatus = "A" | "M" | "D" | "R" | "C";

export interface NameStatusEntry {
  status: NameStatus;
  path: string;
  previousPath?: string;
}

function parseStatNumber(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Parse `git diff --numstat -z` output. Tokens are NUL-separated records;
 * rename records carry the stats followed by an empty path slot and then TWO
 * path fields, so a plain token split needs to consume the pair.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const tokens = output.split("\0");
  const files: NumstatEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue; // stray terminator artifacts
    const parts = token.split("\t");
    const additions = parseStatNumber(parts[0]);
    const deletions = parseStatNumber(parts[1]);
    if (parts.length >= 3 && parts[2]) {
      // Plain record with the path embedded: "N\tM\tpath"
      files.push({ path: parts.slice(2).join("\t"), additions, deletions });
      continue;
    }
    // Rename record: stats token ends with a tab and an EMPTY path slot;
    // the old and new paths follow as separate NUL tokens.
    const previousPath = tokens[index + 1];
    const path = tokens[index + 2];
    if (path) {
      files.push({ path, previousPath, additions, deletions });
      index += 2;
    }
  }
  return files;
}

/**
 * Parse `git diff --name-status -z` output so file types come from git's own
 * classification (A/M/D/R) instead of being guessed from add/delete counts
 * (which cannot tell "modified, only additions" from "new file").
 */
export function parseNameStatus(output: string): NameStatusEntry[] {
  const tokens = output.split("\0");
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const letter = token[0];
    if (letter !== "A" && letter !== "M" && letter !== "D" && letter !== "R" && letter !== "C") {
      // Unknown status (typechange "T", submodule changes, ...): still consume
      // this record's path token, otherwise the path is re-parsed as a status
      // letter and EVERY following record silently misaligns and is dropped.
      index += 1;
      continue;
    }
    const status = letter as NameStatus;
    const path = tokens[index + 1];
    if (!path) continue;
    if (status === "R" || status === "C") {
      const newPath = tokens[index + 2];
      if (!newPath) continue;
      entries.push({ status, path: newPath, previousPath: path });
      index += 2;
    } else {
      entries.push({ status, path });
      index += 1;
    }
  }
  return entries;
}

/**
 * Merge numstat rows with name-status rows into classified review files.
 * Classification is driven by git's status (A/D/M/R/C); numstat only supplies
 * the add/delete counts, matched by final path.
 */
export function buildReviewFiles(numstat: NumstatEntry[], nameStatus: NameStatusEntry[]): ReviewFile[] {
  const statusByPath = new Map<string, NameStatusEntry>();
  for (const entry of nameStatus) statusByPath.set(entry.path, entry);
  return numstat.map((entry): ReviewFile => {
    const status = statusByPath.get(entry.path);
    let type: ReviewFile["type"];
    if (status?.status === "R" || status?.status === "C") {
      type = entry.additions === 0 && entry.deletions === 0 ? "rename-pure" : "rename-changed";
    } else if (status?.status === "A") {
      type = "new";
    } else if (status?.status === "D") {
      type = "deleted";
    } else {
      type = "change";
    }
    return {
      path: entry.path,
      ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
      type,
      additions: entry.additions,
      deletions: entry.deletions,
    };
  });
}

export function summarizeFiles(files: ReviewFile[]): ReviewSummary {
  return files.reduce<ReviewSummary>(
    (summary, file) => ({
      files: summary.files + 1,
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}
