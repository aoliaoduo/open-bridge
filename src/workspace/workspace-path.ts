import * as path from "node:path";
import * as fs from "node:fs/promises";

/** Relative input stays anchored to the VS Code workspace; absolute input stays explicit. */
export function resolveFromWorkspace(workspaceRoot: string, input = "."): string {
  const workspace = path.resolve(workspaceRoot);
  return path.isAbsolute(input) ? path.resolve(input) : path.resolve(workspace, input || ".");
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
 * Relative paths remain anchored to the active workspace. In unrestricted mode
 * this intentionally preserves the existing semantics and skips policy checks.
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
