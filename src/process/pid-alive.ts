/**
 * Does this PID exist? Signal 0 performs the existence check without
 * delivering anything, and one failure mode is NOT an existence answer:
 *
 *   - ESRCH: no such process — the record is stale, recycle it;
 *   - EPERM: the process EXISTS but this one may not signal it (on Windows,
 *     an instance running elevated, or in another session, answers EPERM to
 *     a same-user probe). Collapsing that into "gone" made an elevated
 *     instance invisible to `open-bridge instances`, let `stop --pid` refuse
 *     a running target, and let a same-directory `serve` recycle the live
 *     serve lock as "stale" and start a second instance on the workspace.
 *
 * `signal` is injectable so the EPERM/ESRCH truth table is testable without
 * spawning (or needing privilege to hit) real processes.
 */
export function pidAlive(
  pid: number,
  signal: (pid: number) => void = probe => process.kill(probe, 0),
): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    signal(pid);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
