/**
 * Tee-based capture helpers for the visible-terminal mode (run_command /
 * start_process with visible=true).
 *
 * The managed process keeps running under our hidden shell (full lifecycle
 * control: kill, stdin, exit code), while its merged output ALSO flows into a
 * capture file that a user-visible `tail -f` terminal follows. Pure module,
 * no vscode imports.
 */
import * as os from "node:os";
import * as path from "node:path";

/** Directory holding tee capture files for visible terminals. */
export function visibleCaptureDir(): string {
  return path.join(os.tmpdir(), "open-bridge-visible");
}

/** Capture file for one managed command. */
export function visibleCapturePath(id: string): string {
  return path.join(visibleCaptureDir(), `${id}.log`);
}

/** POSIX-style path for embedding in a bash command line (Git Bash on Windows). */
export function bashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True for bash/sh-style shells (Git Bash on Windows). */
export function isBashLikeShell(shellFile: string): boolean {
  const n = shellFile.toLowerCase().replace(/\\/g, "/");
  return n.includes("bash") || n.endsWith("/sh") || n.endsWith("/sh.exe") || n.includes("/bin/sh");
}

/**
 * Command that follows the capture file in the user's shell: `tail -f` for
 * bash/sh, `Get-Content -Wait` for PowerShell (where tail does not exist).
 */
export function tailCommandForShell(shellFile: string, captureFile: string): string {
  return isBashLikeShell(shellFile)
    ? `tail -f '${bashPath(captureFile)}'`
    : `Get-Content -Wait -Path '${captureFile}'`;
}

/**
 * Like wrapWithTee but appends to the capture file (tee -a) so a service log
 * accumulates across restarts; the shell still exits with the wrapped
 * command's own code (PIPESTATUS), not tee's.
 */
export function wrapWithTeeAppend(commandText: string, captureFile: string): string {
  const file = bashPath(captureFile).replace(/'/g, `'\\''`);
  return `( ${commandText} ) 2>&1 | tee -a '${file}'; exit \${PIPESTATUS[0]}`;
}

/**
 * Wrap a command so its merged stdout/stderr also lands in `captureFile`
 * while the shell still exits with the wrapped command's own exit code
 * (PIPESTATUS), not tee's.
 */
export function wrapWithTee(commandText: string, captureFile: string): string {
  const file = bashPath(captureFile).replace(/'/g, `'\\''`);
  return `( ${commandText} ) 2>&1 | tee '${file}'; exit \${PIPESTATUS[0]}`;
}
