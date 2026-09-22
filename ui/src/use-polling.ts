/**
 * The polling skeleton the live pages share: one immediate call on mount, then
 * every `intervalMs`, with a stale-response guard — a slow reply that lands
 * after a newer poll (or after an action applied fresher state) must not
 * overwrite it.
 *
 * The guard is a monotonic sequence: each poll captures its number and may
 * write state only while it is still the newest. Pages that apply an action's
 * own fresher answer outside the poll call `invalidate()` first, exactly like
 * the hand-written `pollSeq.current += 1` this hook replaces.
 */
import { useEffect, useMemo, useRef } from "react";

/** One live page's polling connection. */
export interface PollHandle {
  /** Run one poll now, under the same guard as the automatic ones. */
  refresh: () => Promise<void>;
  /** Expire every poll already in flight: an action's own (fresher) answer
      must not race the poll it superseded. */
  invalidate: () => void;
}

export function usePolling({ poll, intervalMs }: {
  /** One poll: fetch and apply. Write state only while `fresh()` is true —
      a newer poll or an invalidation makes it false. */
  poll: (fresh: () => boolean) => Promise<void>;
  intervalMs: number;
}): PollHandle {
  const seq = useRef(0);
  // The latest callback without making the timer depend on it: re-creating the
  // interval (or re-firing the immediate first poll) on every render would
  // turn renders into polls.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  // Stable identity: callers use refresh/invalidate in effects and callbacks.
  const handle = useMemo<PollHandle>(() => ({
    refresh: async () => {
      const mine = ++seq.current;
      await pollRef.current(() => seq.current === mine);
    },
    invalidate: () => { seq.current += 1; },
  }), []);

  useEffect(() => {
    void handle.refresh();
    const timer = setInterval(() => void handle.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [handle, intervalMs]);

  return handle;
}
