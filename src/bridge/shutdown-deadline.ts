/**
 * A deadline for the graceful shutdown, so "stop" always ends in a dead process.
 *
 * The console's stop path awaits several things that are normally quick and not
 * always bounded: managed process teardown, the peer-registry withdrawal (a
 * file lock with retries), the transport closes of every live session, and the
 * listener close. One wedged step used to mean the process stayed alive after
 * Ctrl+C — and then the operator's next start was refused because a live pid
 * still held the port, the runtime file and the serve lock. Measured while
 * probing the launcher: an instance whose console window was closed kept its
 * listener (and its child processes) while its shutdown was stuck.
 *
 * Armed before the first await, so nothing inside the graceful path can dodge
 * it. The happy path calls the returned cancel function and exits on its own.
 */
export const SHUTDOWN_DEADLINE_MS = 10_000;

export function armShutdownDeadline(onTimeout: () => void, ms: number = SHUTDOWN_DEADLINE_MS): () => void {
  // Deliberately NOT unref'd: this timer has to fire even when every handle the
  // process still owns is a stuck one. A finished shutdown calls process.exit()
  // (or the returned cancel) long before it matters.
  const timer = setTimeout(onTimeout, ms);
  return () => clearTimeout(timer);
}
