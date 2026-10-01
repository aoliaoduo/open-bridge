import * as fs from "node:fs";
import * as path from "node:path";
import { nodeNativeProcessAdapter, type NativeProcessAdapter } from "./native-process.js";

const FOLDER_KEY = "HKCU\\Software\\Classes\\Directory\\shell\\OpenBridge";
const BACKGROUND_KEY = "HKCU\\Software\\Classes\\Directory\\Background\\shell\\OpenBridge";

export interface ExplorerRegistryEntry {
  key: string;
  placeholder: string;
  description: string;
}

export interface ExplorerInstallOptions {
  packageRoot: string;
  menuText?: string;
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  runner?: NativeProcessAdapter;
  exists?: (file: string) => boolean;
}

export interface ExplorerOperation {
  file: "reg.exe";
  args: string[];
  description: string;
  /** Probe first and skip only when the target is genuinely absent. */
  skipWhenMissing?: "key" | "value";
}

export interface ExplorerChangeResult {
  changed: boolean;
  operations: ExplorerOperation[];
}

export const EXPLORER_ENTRIES: readonly ExplorerRegistryEntry[] = [
  { key: FOLDER_KEY, placeholder: "%1\\.", description: "folder" },
  { key: BACKGROUND_KEY, placeholder: "%V\\.", description: "folder background" },
];

export function defaultExplorerMenuText(
  locale: string = Intl.DateTimeFormat().resolvedOptions().locale,
): string {
  return locale.toLowerCase().startsWith("zh") ? "在此启动 Open Bridge" : "Start Open Bridge Here";
}

function requireWindows(platform: NodeJS.Platform): void {
  if (platform !== "win32") {
    throw new Error("Open Bridge Explorer integration is available only on Windows.");
  }
}

function registryCommand(relayPath: string, placeholder: string): string {
  return `wscript.exe "${relayPath}" "${placeholder}"`;
}

export function explorerInstallPlan(relayPath: string, menuText: string): ExplorerOperation[] {
  const operations: ExplorerOperation[] = [];
  for (const entry of EXPLORER_ENTRIES) {
    const commandKey = `${entry.key}\\command`;
    operations.push(
      {
        file: "reg.exe",
        args: ["add", entry.key, "/ve", "/t", "REG_SZ", "/d", menuText, "/f"],
        description: `set ${entry.description} label`,
      },
      {
        file: "reg.exe",
        args: ["delete", entry.key, "/v", "Position", "/f"],
        description: `remove legacy ${entry.description} Position value`,
        skipWhenMissing: "value",
      },
      {
        file: "reg.exe",
        args: ["add", entry.key, "/v", "SeparatorBefore", "/t", "REG_SZ", "/d", "", "/f"],
        description: `add ${entry.description} separator`,
      },
      {
        file: "reg.exe",
        args: ["add", commandKey, "/ve", "/t", "REG_SZ", "/d", registryCommand(relayPath, entry.placeholder), "/f"],
        description: `set ${entry.description} command`,
      },
    );
  }
  return operations;
}

async function applyOperations(
  operations: ExplorerOperation[],
  runner: NativeProcessAdapter,
): Promise<number> {
  let applied = 0;
  for (const operation of operations) {
    if (operation.skipWhenMissing) {
      const key = operation.args[1];
      if (!key) throw new Error(`Invalid registry operation: ${operation.description}`);
      const queryArgs = operation.skipWhenMissing === "value"
        ? ["query", key, "/v", operation.args[3] ?? ""]
        : ["query", key];
      const probe = await runner.run(operation.file, queryArgs, { windowsHide: true, timeoutMs: 5_000 });
      if (probe.code !== 0) continue;
    }

    const result = await runner.run(operation.file, operation.args, { windowsHide: true, timeoutMs: 5_000 });
    if (result.code !== 0) {
      // reg.exe output follows the host console code page, not a portable text
      // encoding. The numeric exit status is the stable cross-locale contract;
      // do not turn an otherwise clear error into mojibake by decoding its text.
      throw new Error(
        `Windows Explorer integration failed while trying to ${operation.description} (reg.exe exit ${String(result.code)}).`,
      );
    }
    applied += 1;
  }
  return applied;
}

export async function installExplorerIntegration(options: ExplorerInstallOptions): Promise<ExplorerChangeResult> {
  const platform = options.platform ?? process.platform;
  requireWindows(platform);
  const relayPath = path.win32.join(options.packageRoot, "scripts", "windows", "context-menu-launch.vbs");
  const exists = options.exists ?? fs.existsSync;
  if (!exists(relayPath)) throw new Error(`Context-menu launcher is missing: ${relayPath}`);

  const menuText = options.menuText?.trim() || defaultExplorerMenuText();
  const operations = explorerInstallPlan(relayPath, menuText);
  if (options.dryRun === true) return { changed: false, operations };

  const applied = await applyOperations(operations, options.runner ?? nodeNativeProcessAdapter);
  return { changed: applied > 0, operations };
}

export async function uninstallExplorerIntegration(options: {
  dryRun?: boolean;
  platform?: NodeJS.Platform;
  runner?: NativeProcessAdapter;
} = {}): Promise<ExplorerChangeResult> {
  const platform = options.platform ?? process.platform;
  requireWindows(platform);
  const runner = options.runner ?? nodeNativeProcessAdapter;
  const operations: ExplorerOperation[] = EXPLORER_ENTRIES.map(entry => ({
    file: "reg.exe",
    args: ["delete", entry.key, "/f"],
    description: `remove ${entry.description} registration`,
    skipWhenMissing: "key",
  }));
  if (options.dryRun === true) return { changed: false, operations };

  // Absence is already the desired state; existing keys are still required to
  // delete successfully, so permission/real mutation failures stay visible.
  const applied = await applyOperations(operations, runner);
  return { changed: applied > 0, operations };
}
