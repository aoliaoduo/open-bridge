import { host } from "../host/host.js";
import * as path from "node:path";
import { sha256 } from "../workspace/file-version.js";
import { rejectSymlinkChain } from "../workspace/workspace-path.js";
import { state, workspaceContext } from "./state.js";

export const root = (): string => workspaceContext.root();

export const currentWorkspaceRoot = (): string => path.resolve(host().projectRoot());

export const workspaceStateSuffix = (): string =>
  sha256(state.activeWorkspaceRoot || "<no-workspace>").slice(0, 24);

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
