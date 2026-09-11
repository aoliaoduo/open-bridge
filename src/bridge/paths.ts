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
export const workspaceSuffixFor = (root: string): string =>
  sha256(root || "<no-workspace>").slice(0, 24);

export const workspaceStateSuffix = (): string => workspaceSuffixFor(state.activeWorkspaceRoot);

export const unrestricted = (): boolean => workspaceContext.unrestricted();
export const allowedRoots = (): string[] => workspaceContext.allowedRoots();
export const workspacePath = (input = "."): string => workspaceContext.resolve(input);
export const securePath = (input = ".", allowMissing = false): Promise<string> =>
  workspaceContext.resolveSecure(input, allowMissing);

/** Reject symlinks on the path chain when file access is restricted. */
export async function rejectSymlink(full: string, allowMissing = false): Promise<void> {
  if (unrestricted()) return;
  await rejectSymlinkChain(full, { workspaceRoot: root(), allowedRoots: allowedRoots(), allowMissing });
}
