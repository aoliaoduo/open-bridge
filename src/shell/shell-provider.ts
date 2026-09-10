import { existsSync } from "node:fs";
import { host } from "../host/host.js";
import { defaultShellArgs } from "./shell-args.js";

export interface ShellSpec {
  file: string;
  args: string[];
}

/** Resolve the configured shell without changing the caller's command text. */
export function resolveShell(): ShellSpec {
  const cfg = host().config;
  const configured = cfg.get<string>("shellPath", "")?.trim();
  const customArgs = cfg.get<string[]>("shellArgs", []);
  const argsFor = (file: string): string[] => customArgs.length ? customArgs : defaultShellArgs(file);
  if (configured) return { file: configured, args: argsFor(configured) };
  if (process.platform === "win32") {
    const git = "C:\\Program Files\\Git\\bin\\bash.exe";
    if (existsSync(git)) return { file: git, args: argsFor(git) };
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    if (existsSync(pwsh)) return { file: pwsh, args: argsFor(pwsh) };
    return { file: "powershell.exe", args: argsFor("powershell.exe") };
  }
  return { file: "/bin/bash", args: argsFor("/bin/bash") };
}
