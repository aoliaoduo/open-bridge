/**
 * The lifecycle transition queue.
 *
 * start/stop/rotate/tunnel-reconnect all mutate the same instance state, so they
 * are serialized through one tail promise instead of racing. It is its own module
 * because both ends need it without depending on each other: lifecycle.ts
 * (start/stop) and tunnel.ts (a scheduled reconnect).
 */
import { state } from "./state.js";

/** Serialize bridge lifecycle transitions so start/stop/rotate cannot overlap. */
export function enqueueLifecycle(task: () => Promise<void>): Promise<void> {
  const next = state.lifecycleTail.then(task, task);
  state.lifecycleTail = next.catch(() => undefined);
  return next;
}
