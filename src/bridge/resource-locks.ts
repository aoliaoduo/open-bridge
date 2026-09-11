/**
 * In-process resource admission control for tool calls.
 *
 * Why this exists: every tool call used to run immediately and concurrently, so
 * two MCP sessions (or two items inside one `batch`) could edit the same file,
 * start the same service twice, or fight over the same build output directory.
 * taskquay built a whole cross-process SQLite subsystem for this; here the
 * Bridge is a single process, so an in-memory scheduler is sufficient and
 * cheaper — and it avoids taskquay's central flaw, where an active claim has no
 * timeout and a crash leaves the lock held forever and needs manual reconcile.
 *
 * Guarantees:
 *  - Multi-key acquisition is atomic: a waiter takes all of its keys or none,
 *    and never holds one while waiting for another. Cycles (deadlock) are
 *    therefore impossible without re-entrancy, and `dispatcher.invoke` is the
 *    only acquisition site, so no handler can re-enter.
 *  - Writers are exclusive; readers share a key but are blocked by a queued
 *    writer so a stream of readers cannot starve one.
 *  - Every hold has a hard cap: overrunning it reclaims the lock, records an
 *    audit entry, and lets the original holder's release become a no-op.
 *  - Every wait has a deadline: a caller gets a clear error instead of hanging.
 *
 * Pure module: no vscode, no fs, no state import — safe to unit test directly.
 */

export type LockMode = "read" | "write";

export interface LockRequest {
  keys: readonly string[];
  mode: LockMode;
  /** Human-readable owner, used in audit lines (tool name + target). */
  label: string;
}

export interface LockTuning {
  /** Hard cap on how long one acquisition may be held before it is reclaimed. */
  holdTimeoutMs: number;
  /** How long a caller waits for a conflicting holder before giving up. */
  waitTimeoutMs: number;
  /** Called when a hold is force-reclaimed, so the Bridge can audit it. */
  onReclaim?: (info: { keys: string[]; label: string; heldMs: number }) => void;
  /** Called once when a caller has been queued longer than this. */
  onContention?: (info: { keys: string[]; label: string; waitedMs: number }) => void;
}

export const DEFAULT_HOLD_TIMEOUT_MS = 300_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
/** Contention older than this is worth an audit line. */
const CONTENTION_NOTICE_MS = 3_000;

export type LockRelease = () => void;

interface Holder {
  keys: string[];
  mode: LockMode;
  label: string;
  acquiredAt: number;
  holdTimer: ReturnType<typeof setTimeout> | undefined;
  released: boolean;
}

interface Waiter {
  keys: string[];
  mode: LockMode;
  label: string;
  /** The tuning THIS waiter was created with; grant/pump must use it, not whatever a later caller brought. */
  tuning: LockTuning;
  enqueuedAt: number;
  resolve: (release: LockRelease) => void;
  reject: (error: Error) => void;
  waitTimer: ReturnType<typeof setTimeout> | undefined;
  contentionTimer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

interface KeySlot {
  readers: Set<Holder>;
  writer?: Holder;
}

const slots = new Map<string, KeySlot>();
const waiting: Waiter[] = [];
const active = new Set<Holder>();

function slotFor(key: string): KeySlot {
  let slot = slots.get(key);
  if (!slot) {
    slot = { readers: new Set() };
    slots.set(key, slot);
  }
  return slot;
}

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some(key => b.includes(key));
}

function canGrant(waiter: Waiter): boolean {
  for (const key of waiter.keys) {
    const slot = slots.get(key);
    if (!slot) continue;
    if (waiter.mode === "write") {
      if (slot.writer || slot.readers.size > 0) return false;
    } else if (slot.writer) {
      return false;
    }
  }
  return true;
}

/**
 * Writer priority: a reader queued behind a conflicting writer waits, so
 * continuous readers cannot starve the writer. Writers never jump readers that
 * arrived earlier (the scan below is in queue order).
 */
function blockedByEarlierWriter(index: number): boolean {
  const waiter = waiting[index];
  if (!waiter || waiter.mode === "write") return false;
  for (let i = 0; i < index; i += 1) {
    const earlier = waiting[i];
    if (earlier.mode === "write" && overlaps(earlier.keys, waiter.keys)) return true;
  }
  return false;
}

function attachHoldTimer(holder: Holder, tuning: LockTuning): void {
  const timeout = tuning.holdTimeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0) return;
  holder.holdTimer = setTimeout(() => {
    const heldMs = Date.now() - holder.acquiredAt;
    tuning.onReclaim?.({ keys: holder.keys, label: holder.label, heldMs });
    releaseHolder(holder);
  }, timeout);
  // Never keep the extension host (or a test runner) alive for a lock timer.
  holder.holdTimer.unref?.();
}

function releaseHolder(holder: Holder): void {
  if (holder.released) return;
  holder.released = true;
  if (holder.holdTimer) clearTimeout(holder.holdTimer);
  active.delete(holder);
  for (const key of holder.keys) {
    const slot = slots.get(key);
    if (!slot) continue;
    if (holder.mode === "write") {
      if (slot.writer === holder) slot.writer = undefined;
    } else {
      slot.readers.delete(holder);
    }
    if (!slot.writer && slot.readers.size === 0) slots.delete(key);
  }
  pump();
}

function grant(waiter: Waiter): void {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.waitTimer) clearTimeout(waiter.waitTimer);
  if (waiter.contentionTimer) clearTimeout(waiter.contentionTimer);
  const tuning = waiter.tuning;
  const holder: Holder = {
    keys: waiter.keys,
    mode: waiter.mode,
    label: waiter.label,
    acquiredAt: Date.now(),
    holdTimer: undefined,
    released: false,
  };
  for (const key of waiter.keys) {
    const slot = slotFor(key);
    if (holder.mode === "write") slot.writer = holder;
    else slot.readers.add(holder);
  }
  active.add(holder);
  attachHoldTimer(holder, tuning);
  waiter.resolve(() => releaseHolder(holder));
}

function pump(): void {
  for (let index = 0; index < waiting.length;) {
    const waiter = waiting[index];
    if (!waiter) break;
    if (blockedByEarlierWriter(index) || !canGrant(waiter)) {
      index += 1;
      continue;
    }
    waiting.splice(index, 1);
    grant(waiter);
    index = 0;
  }
}

/**
 * Merge caller tuning over the defaults. Explicit `undefined` fields are
 * IGNORED (a spread would let `holdTimeoutMs: undefined` disable the timers
 * entirely: locks never reclaimed, waiters waiting forever).
 */
function mergedTuning(tuning?: Partial<LockTuning>): LockTuning {
  const merged: LockTuning = { holdTimeoutMs: DEFAULT_HOLD_TIMEOUT_MS, waitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS };
  if (tuning?.holdTimeoutMs !== undefined) merged.holdTimeoutMs = tuning.holdTimeoutMs;
  if (tuning?.waitTimeoutMs !== undefined) merged.waitTimeoutMs = tuning.waitTimeoutMs;
  if (tuning?.onReclaim) merged.onReclaim = tuning.onReclaim;
  if (tuning?.onContention) merged.onContention = tuning.onContention;
  return merged;
}

/**
 * Acquire every key in `request.keys`, or wait for a conflicting holder.
 * Resolves with an idempotent release function. Rejects on the wait deadline.
 */
export function acquireLocks(request: LockRequest, tuning?: Partial<LockTuning>): Promise<LockRelease> {
  const keys = [...new Set(request.keys.filter(key => typeof key === "string" && key.length > 0))].sort();
  const merged = mergedTuning(tuning);
  // Nothing to serialize on: succeed immediately without touching the queue.
  if (keys.length === 0) return Promise.resolve(() => undefined);

  return new Promise<LockRelease>((resolve, reject) => {
    const waiter: Waiter = {
      keys,
      mode: request.mode,
      label: request.label,
      tuning: merged,
      enqueuedAt: Date.now(),
      resolve,
      reject,
      waitTimer: undefined,
      contentionTimer: undefined,
      settled: false,
    };

    // Fast path: the keys are free AND no queued waiter conflicts with us.
    // The second condition is what preserves writer priority — a fresh reader
    // must not slip past a writer that is already waiting on the same key.
    const conflictsWithQueued = waiting.some(earlier => overlaps(earlier.keys, keys));
    if (!conflictsWithQueued && canGrant(waiter)) {
      grant(waiter);
      return;
    }

    const waitTimeout = merged.waitTimeoutMs;
    if (Number.isFinite(waitTimeout) && waitTimeout > 0) {
      waiter.waitTimer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.contentionTimer) clearTimeout(waiter.contentionTimer);
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        reject(new Error(
          `Timed out after ${Math.round(waitTimeout / 1000)}s waiting for ${keys.join(", ")}. `
          + "Another tool call is still holding it; retry, or raise concurrency.waitTimeoutMs "
          + "(console settings page).",
        ));
      }, waitTimeout);
      waiter.waitTimer.unref?.();
    }

    waiter.contentionTimer = setTimeout(() => {
      if (waiter.settled) return;
      merged.onContention?.({ keys, label: request.label, waitedMs: Date.now() - waiter.enqueuedAt });
    }, CONTENTION_NOTICE_MS);
    waiter.contentionTimer.unref?.();

    waiting.push(waiter);
    // Nothing may be holding our keys yet (an earlier, conflict-free queue
    // entry simply happens to overlap us), so give the scheduler a turn.
    pump();
  });
}

export interface LockSnapshotEntry {
  key: string;
  mode: LockMode;
  label: string;
  held_ms: number;
}

/** Live lock table for the panel / diagnostics. */
export function lockSnapshot(now = Date.now()): {
  held: LockSnapshotEntry[];
  waiting: Array<{ keys: string[]; mode: LockMode; label: string; waited_ms: number }>;
} {
  const held: LockSnapshotEntry[] = [...active]
    .flatMap(holder => holder.keys.map(key => ({
      key,
      mode: holder.mode,
      label: holder.label,
      held_ms: Math.max(0, now - holder.acquiredAt),
    })))
    .sort((a, b) => b.held_ms - a.held_ms);
  return {
    held,
    waiting: waiting.map(waiter => ({
      keys: waiter.keys,
      mode: waiter.mode,
      label: waiter.label,
      waited_ms: Math.max(0, now - waiter.enqueuedAt),
    })),
  };
}

/** Test helper: drop all state. Never called from production paths. */
export function resetLocks(): void {
  for (const holder of [...active]) {
    holder.released = true;
    if (holder.holdTimer) clearTimeout(holder.holdTimer);
  }
  active.clear();
  for (const waiter of waiting.splice(0, waiting.length)) {
    waiter.settled = true;
    if (waiter.waitTimer) clearTimeout(waiter.waitTimer);
    if (waiter.contentionTimer) clearTimeout(waiter.contentionTimer);
  }
  slots.clear();
}
