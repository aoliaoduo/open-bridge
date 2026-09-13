/**
 * Tee-based capture helpers.
 *
 * The managed process keeps running under our hidden shell (full lifecycle
 * control: kill, stdin, exit code) while its merged output ALSO flows into a
 * per-service log file that `read_service_log` reads back. Pure module, no
 * vscode imports.
 *
 * This used to carry a second, dead half for a "visible terminal" mode: a
 * capture path plus `tailCommandForShell`, feeding a `tail -f` pane that only
 * an editor host could open. The standalone host's `showVisibleTerminal` was a
 * no-op, so nothing ever wrote that file and nothing ever read it. Both are
 * gone; only the service-log half below is live.
 */
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
 * Wrap a command so its merged stdout/stderr also appends to `captureFile`
 * (tee -a) while the shell still exits with the wrapped command's own exit code
 * (PIPESTATUS), not tee's. Appending is what lets a service log accumulate
 * across restarts.
 */
export function wrapWithTeeAppend(commandText: string, captureFile: string): string {
  const file = bashPath(captureFile).replace(/'/g, `'\\''`);
  return `( ${commandText} ) 2>&1 | tee -a '${file}'; exit \${PIPESTATUS[0]}`;
}

