import { spawn } from "node:child_process";

export interface ExternalOpenCommand {
  file: string;
  args: string[];
}

export function externalOpenCommand(
  target: string,
  platform: NodeJS.Platform = process.platform,
): ExternalOpenCommand {
  if (platform === "win32") return { file: "explorer.exe", args: [target] };
  if (platform === "darwin") return { file: "open", args: [target] };
  return { file: "xdg-open", args: [target] };
}

/** Open a URL/path without routing user data through a shell command string. */
export async function openExternal(target: string): Promise<void> {
  const command = externalOpenCommand(target);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
      shell: false,
    });
    let settled = false;
    child.once("error", error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}
