import * as path from "node:path";
import * as fs from "node:fs/promises";

/**
 * Relative input stays anchored to the workspace root; absolute input stays explicit.
 *
 * A relative input may not leave the workspace. `path.resolve` cannot fail on one
 * -- walking up is precisely what it does -- so `../../x` used to resolve to a
 * real path one or more levels above the workspace and be handed straight to the
 * filesystem. Through the tool surface that meant `apply_patch` with
 * `*** Add File: ../../ob-escape.txt` created a file outside the workspace and
 * reported success, and a `cwd` of `../..` ran a command outside it.
 *
 * The containment test is deliberately against the WORKSPACE anchor rather than
 * the allowed roots: in unrestricted mode the single allowed root is the whole
 * drive, so an escape from the workspace lands comfortably inside it and passes
 * every policy check on the way out.
 *
 * Absolute paths are left alone: naming an absolute location is a caller saying
 * exactly where it means, and that is the policy's call to make, not this
 * function's.
 */
export function resolveFromWorkspace(workspaceRoot: string, input = "."): string {
  const workspace = path.resolve(workspaceRoot);
  if (path.isAbsolute(input)) return path.resolve(input);
  const resolved = path.resolve(workspace, input || ".");
  if (!isWithinAllowedRoots(resolved, [workspace])) {
    throw new Error(
      `Relative path "${input}" resolves to ${resolved}, outside the workspace ${workspace}. ` +
      `Relative paths stay inside the workspace; use an absolute path to name a location outside it.`,
    );
  }
  return resolved;
}

/** Return true when fullPath is inside one of the configured roots. */
export function isWithinAllowedRoots(fullPath: string, roots: readonly string[]): boolean {
  const candidate = path.resolve(fullPath);
  return roots.some(root => {
    const base = path.resolve(root);
    const relative = path.relative(base, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

/**
 * Resolve a user supplied path and apply the complete file policy in one call.
 * Relative paths remain anchored to the active workspace, and may not leave it
 * (enforced in resolveFromWorkspace, before this function's mode check). In
 * unrestricted mode the remaining policy checks are skipped on purpose -- an
 * explicit absolute path may point anywhere -- but that skip is why the
 * workspace anchor has to be enforced upstream of it.
 */
export async function resolveSecurePath(
  workspaceRoot: string,
  input = ".",
  options: { unrestricted: boolean; allowedRoots: readonly string[]; allowMissing?: boolean },
): Promise<string> {
  const full = resolveFromWorkspace(workspaceRoot, input);
  if (options.unrestricted) return full;
  if (!isWithinAllowedRoots(full, options.allowedRoots)) {
    throw new Error("Path is outside configured allowed directories.");
  }
  await rejectSymlinkChain(full, { workspaceRoot, ...options });
  return full;
}

/**
 * Reject a symlink anywhere on the path chain (restricted mode only).
 *
 * Shared by resolveSecurePath and by bridge/paths.ts' rejectSymlink, which used
 * to carry a second, subtly different copy of this walk (unresolved roots, so
 * the loop could walk past a configured root and apply the wrong policy).
 */
export async function rejectSymlinkChain(
  full: string,
  options: { workspaceRoot: string; allowedRoots: readonly string[]; allowMissing?: boolean },
): Promise<void> {
  const allowMissing = options.allowMissing === true;
  const roots = options.allowedRoots.map(root => path.resolve(root));
  let current = full;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed: ${path.relative(path.resolve(options.workspaceRoot), current)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !allowMissing) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current || roots.some(base => current === base)) break;
    current = parent;
  }
}
