import { host } from "../host/host.js";
import * as path from "node:path";
import { sha256 } from "../workspace/file-version.js";
import { rejectSymlinkChain } from "../workspace/workspace-path.js";
import { state, workspaceContext } from "./state.js";

export const root = (): string => workspaceContext.root();

export const currentWorkspaceRoot = (): string => path.resolve(host().projectRoot());

/**
 * The per-workspace state key for ANY root.
 *
 * Route tokens, runtime records and other per-workspace state are all addressed
 * by this suffix, so it must be derived the same way everywhere — the CLI needs
 * it for a directory that has no running Bridge to ask, hence the pure form.
 */
export const workspaceSuffixFor = (rootPath: string): string =>
  sha256(rootPath || "<no-workspace>").slice(0, 24);

/**
 * What that suffix looks like on disk. The generators above and the parsers in
 * the CLI both encode its length, so the 24 lives here once: a data-dir file
 * name is only an instance record if it matches this.
 */
export const WORKSPACE_SUFFIX_PATTERN = "[0-9a-f]{24}";

export const workspaceStateSuffix = (): string => workspaceSuffixFor(state.activeWorkspaceRoot);

export const allowedRoots = (): string[] => workspaceContext.allowedRoots();
export const workspacePath = (input = "."): string => workspaceContext.resolve(input);
export const securePath = (input = ".", allowMissing = false): Promise<string> =>
  workspaceContext.resolveSecure(input, allowMissing);

/** Reject symlinks on the path chain when file access is restricted. */
export async function rejectSymlink(full: string, allowMissing = false): Promise<void> {
  if (workspaceContext.unrestricted()) return;
  await rejectSymlinkChain(full, { workspaceRoot: root(), allowedRoots: allowedRoots(), allowMissing });
}
