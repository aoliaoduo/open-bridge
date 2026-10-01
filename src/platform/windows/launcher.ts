import * as fs from "node:fs";
import * as path from "node:path";
import { findOnPath } from "../../shell/which.js";
import { nodeNativeProcessAdapter, type NativeProcessAdapter } from "./native-process.js";

export interface ExplorerLaunchOptions {
  workspace: string;
  packageRoot: string;
  runner?: NativeProcessAdapter;
  terminalPath?: string | null;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  directoryExists?: (directory: string) => boolean;
}

export interface ExplorerLaunchResult {
  mode: "windows-terminal" | "console";
}

function requireWindows(platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    throw new Error("The Windows Explorer launcher is available only on Windows.");
  }
}

export function normalizeWindowsWorkspace(raw: string, baseDir: string): string {
  const trimmed = raw.trim();
  const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  return path.win32.resolve(baseDir, unquoted);
}

export function windowsTerminalLaunchArgs(
  workspace: string,
  packageRoot: string,
  nodeExecutable: string,
): string[] {
  const entry = path.win32.join(packageRoot, "bin", "open-bridge.js");
  const titleName = path.win32.basename(workspace) || workspace;
  return [
    "new-tab",
    "--title",
    `Open Bridge - ${titleName}`,
    "--startingDirectory",
    workspace,
    nodeExecutable,
    entry,
    "launch",
    "--open-existing",
  ];
}

/**
 * Explorer-specific application boundary.
 *
 * Paths stay as argv/cwd values from Node all the way to CreateProcess. No
 * workspace text is embedded into PowerShell, cmd, or another command string.
 */
export async function launchExplorerWorkspace(options: ExplorerLaunchOptions): Promise<ExplorerLaunchResult> {
  const platform = options.platform ?? process.platform;
  requireWindows(platform);
  const workspace = path.win32.resolve(options.workspace);
  const directoryExists = options.directoryExists ?? ((directory: string) =>
    fs.existsSync(directory) && fs.statSync(directory).isDirectory());
  if (!directoryExists(workspace)) {
    throw new Error(`Workspace directory does not exist: ${workspace}`);
  }

  const runner = options.runner ?? nodeNativeProcessAdapter;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const entry = path.win32.join(options.packageRoot, "bin", "open-bridge.js");
  const terminalPath = options.terminalPath === undefined
    ? findOnPath("wt", { platform: "win32" })
    : options.terminalPath ?? undefined;

  if (terminalPath) {
    try {
      const result = await runner.run(
        terminalPath,
        windowsTerminalLaunchArgs(workspace, options.packageRoot, nodeExecutable),
        { cwd: workspace, windowsHide: true, timeoutMs: 5_000 },
      );
      if (result.code === 0) return { mode: "windows-terminal" };
    } catch {
      // A stale Store alias or broken Terminal install is not a Bridge failure.
      // The detached Node console below is the native, shell-free fallback.
    }
  }

  await runner.launch(
    nodeExecutable,
    [entry, "launch", "--open-existing"],
    { cwd: workspace, windowsHide: false },
  );
  return { mode: "console" };
}
