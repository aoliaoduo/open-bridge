import * as path from "node:path";

export type ShellDialect = "posix" | "powershell";

/**
 * Which syntax a shell speaks. ONE classification with two consumers: the
 * args the shell is spawned with (defaultShellArgs below) and the dialect
 * the connect-time instructions coach the model in (shell-usage.ts) — two
 * copies of this predicate would drift, and the usage line would end up
 * lying about the interpreter it sits beside.
 */
export function shellDialect(file: string): ShellDialect {
  const name = path.basename(file).toLowerCase();
  return name.includes("powershell") || name === "pwsh.exe" ? "powershell" : "posix";
}

export function defaultShellArgs(file: string): string[] {
  return shellDialect(file) === "powershell"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
    : ["-lc"];
}
