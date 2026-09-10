import * as path from "node:path";

export function defaultShellArgs(file: string): string[] {
  const name = path.basename(file).toLowerCase();
  return name.includes("powershell") || name === "pwsh.exe"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
    : ["-lc"];
}
