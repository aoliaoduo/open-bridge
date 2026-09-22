import { execFileSync } from "node:child_process";

/** Whether a `git` binary can be run at all — the suites skip without one. */
export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Deterministic git invocation for fixture repositories. */
export function git(cwd: string, args: string[]): void {
  execFileSync("git", [
    "-c", "user.email=tui@test",
    "-c", "user.name=tui",
    "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main",
    "-c", "core.autocrlf=false",
    ...args,
  ], { cwd, stdio: "ignore", windowsHide: true });
}
