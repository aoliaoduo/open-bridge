import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { host } from "../../host/host.js";
import { writeFileAtomic } from "../../workspace/persist.js";
import { applyPatch as applyPatchFile, resolvePatchSource } from "../../mcp/patch.js";
import { workspaceContext } from "../runtime-state.js";
import { securePath, root } from "../paths.js";
import type { JsonArgs } from "./json-args.js";
import { requiredFileArg } from "./file-tool-args.js";

type Args = JsonArgs;

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
 * The comparison key for the self-destruction guard: one directory, one string.
 *
 * Windows accepts more than one spelling for the same path, and a guard that
 * compares resolved strings is only as strong as the spelling it is handed:
 *
 *   - `\\?\C:\dir` (and `\\.\C:\dir`, `//?/C:/dir`) is the long-path prefix
 *     form. `path.resolve` does not remove it, so it never compared equal to the
 *     protected path — and `fs` happily acted on it.
 *   - The Win32 layer strips trailing dots and spaces from each segment before
 *     opening it, so `C:\dir.` and `C:\dir ` are the same directory on disk
 *     while comparing as different strings.
 *
 * Deleting a path is deleting a path: the guard refuses the call nobody means to
 * make, and "which spelling did the caller produce" must not be what decides
 * whether it holds. Case variants were already safe (`path.relative` compares
 * case-insensitively on win32).
 *
 * `..` and `.` are left exactly as they are — they are the segments that carry
 * meaning, and stripping their dots would silently turn a parent traversal into
 * the current directory, i.e. break the very case this guard is for.
 *
 * Only Windows spellings are normalized, and only on Windows: on POSIX a file may
 * legitimately be named `current.` or start with `\\?\`, and rewriting those
 * would merge two real, different directories.
 *
 * Deliberately NOT `fs.realpath`: removing a symlink or junction does not remove
 * what it points at, so a link spelled towards the workspace root is not the
 * self-destruction this guard exists to refuse.
 */
export function normalizeGuardPath(input: string): string {
  let text = input;
  if (process.platform === "win32") {
    // \\?\UNC\server\share must keep its UNC meaning rather than degrading to
    // a relative "UNC\server\share".
    if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(text)) {
      text = `\\\\${text.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, "")}`;
    } else if (/^[\\/]{2}[?.][\\/]/.test(text)) {
      text = text.replace(/^[\\/]{2}[?.][\\/]/, "");
    }
    text = text
      .split(/[\\/]/)
      .map(segment => (segment === "." || segment === ".." ? segment : segment.replace(/[. ]+$/, "")))
      .join("\\");
  }
  return path.resolve(text);
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
  const resolved = normalizeGuardPath(target);
  // When the input was an alias, name it: the caller wrote a path the guard read
  // as something else, and that is the fact worth putting in the error.
  const spelled = resolved === path.resolve(target) ? "" : ` (spelled "${target}")`;
  if (resolved === path.parse(resolved).root) {
    throw new Error(
      `Refusing to ${verb} "${resolved}"${spelled}: that is a drive root, not project content. `
      + "File tools never target it; use run_command if you really mean it.",
    );
  }
  const hit = protectedTargets().find(entry => isAtOrAbove(resolved, entry.path));
  if (!hit) return;
  throw new Error(
    `Refusing to ${verb} "${resolved}"${spelled}: it is ${hit.label} (or a parent of it), so the call would take the whole project with it — unrecoverably. `
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

/**
 * Whole-file hash budget for get_file_info: hashing needs the file in memory
 * (or a full read), so files beyond this cap report sha256:null instead of
 * risking a Bridge-process memory blow-up on a multi-GB target. 128 MiB is
 * far beyond any real source file an edit guard needs to cover.
 */
const GET_FILE_INFO_HASH_MAX_BYTES = 128 * 1024 * 1024;

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

/**
 * Refuse to clobber an existing destination unless the caller explicitly asked
 * for overwrite. Shared by moveFile and copyFile, which used to carry the same
 * lstat/ENOENT dance verbatim: one copy of the guard so the two tools cannot
 * drift apart on when a destination is replaceable.
 */
async function refuseExistingDestination(destination: string): Promise<void> {
  try {
    await fs.lstat(destination);
    throw new Error("Destination already exists; set overwrite=true to replace it.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function createDirectory(args: Args): Promise<unknown> {
  const dir = await securePath(requiredFileArg(args, "path"), true);
  // fs.mkdir({recursive:true}) resolves to the first directory path it CREATED
  // and to undefined when the target already existed. A constant created:true
  // claimed a creation that did not happen on every repeat call.
  const firstCreated = await fs.mkdir(dir, { recursive: true });
  return { path: String(args.path), created: firstCreated !== undefined };
}

export async function moveFile(args: Args): Promise<unknown> {
  const source = await securePath(requiredFileArg(args, "source"));
  const destination = await securePath(requiredFileArg(args, "destination"), true);
  refuseSelfDestruction(source, "move");
  refuseSelfDestruction(destination, "move onto");
  if (args.overwrite === true) await refuseFileOverDirectory(source, destination, args);
  if (args.overwrite !== true) await refuseExistingDestination(destination);
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
  const source = await securePath(requiredFileArg(args, "source"));
  const destination = await securePath(requiredFileArg(args, "destination"), true);
  // A file copied onto a directory is refused by fs.cp itself (see the move
  // guard above), but a DIRECTORY copied onto one is not: fs.cp merges the
  // source tree over it, force-overwriting same names. Aimed at the workspace
  // root, the data directory or a drive root, overwrite:true therefore
  // silences and answers success — the deletion-less twin of "move onto",
  // aimed at exactly the ground this guard exists for.
  refuseSelfDestruction(destination, "copy onto");
  if (args.overwrite !== true) await refuseExistingDestination(destination);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: args.overwrite === true });
  return { source: String(args.source), destination: String(args.destination) };
}

export async function deleteFile(args: Args): Promise<unknown> {
  const target = await securePath(requiredFileArg(args, "path"));
  refuseSelfDestruction(target, "delete");
  await fs.rm(target, { recursive: args.recursive === true, force: false });
  return { path: String(args.path), deleted: true };
}

export async function getFileInfo(args: Args): Promise<unknown> {
  const file = await securePath(requiredFileArg(args, "path"));
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
    (f, c) => writeFileAtomic(f, c));
  return { applied: true, files: changed, changes };
}
