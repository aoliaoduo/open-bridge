import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ParsedArgs } from "./args.js";
import { t } from "./cli-i18n.js";
import {
  installExplorerIntegration,
  uninstallExplorerIntegration,
  type ExplorerOperation,
} from "../platform/windows/explorer.js";
import { launchExplorerWorkspace, normalizeWindowsWorkspace } from "../platform/windows/launcher.js";

export interface WindowsLaunchHandoff {
  parsed: ParsedArgs;
}

function requireWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("This command is available only on Windows.");
  }
}

function printableOperation(operation: ExplorerOperation): string {
  return [operation.file, ...operation.args].map(value => /\s/.test(value) ? JSON.stringify(value) : value).join(" ");
}

export async function cmdExplorer(parsed: ParsedArgs, packageRoot: string): Promise<void> {
  requireWindows();
  const action = parsed.rest[0] ?? "help";
  const dryRun = parsed.flags.has("dry-run");
  const menuTextFlag = parsed.flags.get("menu-text");
  const menuText = typeof menuTextFlag === "string"
    ? menuTextFlag
    : process.env.OPEN_BRIDGE_EXPLORER_MENU_TEXT;

  if (action === "install") {
    const result = await installExplorerIntegration({ packageRoot, menuText, dryRun });
    if (dryRun) {
      for (const operation of result.operations) console.log(printableOperation(operation));
      return;
    }
    console.log(t(
      "Open Bridge 资源管理器右键菜单已安装到当前用户。Windows 11 可能把它放在‘显示更多选项’中。",
      "Open Bridge Explorer context menu installed for the current user. Windows 11 may place it under 'Show more options'.",
    ));
    return;
  }

  if (action === "uninstall") {
    const result = await uninstallExplorerIntegration({ dryRun });
    if (dryRun) {
      for (const operation of result.operations) console.log(printableOperation(operation));
      return;
    }
    console.log(t(
      "Open Bridge 资源管理器右键菜单已从当前用户移除。",
      "Open Bridge Explorer context menu removed for the current user.",
    ));
    return;
  }

  throw new Error(t(
    "用法: open-bridge explorer install [--menu-text TEXT] [--dry-run] | uninstall [--dry-run]",
    "Usage: open-bridge explorer install [--menu-text TEXT] [--dry-run] | uninstall [--dry-run]",
  ));
}

function previousWorkspace(packageRoot: string): string | undefined {
  const file = path.join(packageRoot, "start-open-bridge.last-dir");
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (value && fs.statSync(value).isDirectory()) return value;
  } catch { /* missing/stale is just no previous workspace */ }
  return undefined;
}

async function chooseOneClickWorkspace(packageRoot: string, initial?: string): Promise<string | undefined> {
  const previous = previousWorkspace(packageRoot);
  let raw = initial?.trim() ?? "";
  const rl = createInterface({ input, output });
  try {
    if (!raw) {
      console.log(t(
        "请输入 AI 可以工作的目录。",
        "Workspace directory the AI may work in:",
      ));
      if (previous) console.log(t(`直接回车复用: ${previous}`, `Press Enter to reuse: ${previous}`));
      else console.log(t(`直接回车使用本仓库: ${packageRoot}`, `Press Enter to use this repository: ${packageRoot}`));
      raw = (await rl.question(" > ")).trim();
    }

    const fallback = previous ?? packageRoot;
    const workspace = normalizeWindowsWorkspace(raw || fallback, packageRoot);
    if (!fs.existsSync(workspace)) {
      const answer = (await rl.question(t(
        `目录不存在，立即创建？ ${workspace} [Y/n] `,
        `Directory does not exist. Create it now? ${workspace} [Y/n] `,
      ))).trim().toLowerCase();
      if (answer === "n") return undefined;
      fs.mkdirSync(workspace, { recursive: true });
    }
    if (!fs.statSync(workspace).isDirectory()) throw new Error(`Not a directory: ${workspace}`);
    fs.writeFileSync(path.join(packageRoot, "start-open-bridge.last-dir"), workspace, "utf8");
    return workspace;
  } finally {
    rl.close();
  }
}

/**
 * Hidden command used by the Windows wrappers. It returns a normal CLI serve
 * handoff for foreground launch modes, keeping all Bridge lifecycle semantics
 * in cmdServe instead of duplicating them in scripts.
 */
export async function cmdWindowsLaunch(parsed: ParsedArgs, packageRoot: string): Promise<WindowsLaunchHandoff | undefined> {
  requireWindows();
  const mode = parsed.rest[0] ?? "";

  if (mode === "explorer") {
    const workspace = process.env.OPEN_BRIDGE_EXPLORER_WORKSPACE?.trim();
    if (!workspace) throw new Error("OPEN_BRIDGE_EXPLORER_WORKSPACE is missing.");
    await launchExplorerWorkspace({ workspace, packageRoot });
    return undefined;
  }

  if (mode === "one-click") {
    const initial = parsed.rest[1];
    const workspace = await chooseOneClickWorkspace(packageRoot, initial);
    if (!workspace) return undefined;
    console.log(t(`工作区: ${workspace}`, `Workspace: ${workspace}`));
    const flags = new Map(parsed.flags);
    flags.set("root", workspace);
    flags.delete("open-existing");
    return { parsed: { command: "serve", rest: [], flags } };
  }

  if (mode === "project") {
    const flags = new Map(parsed.flags);
    flags.set("root", packageRoot);
    flags.set("port", "8123");
    flags.delete("open-existing");
    return { parsed: { command: "serve", rest: [], flags } };
  }

  throw new Error("windows-launch expects one of: explorer, one-click, project");
}
