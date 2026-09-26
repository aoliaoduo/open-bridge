import { host } from "../host/host.js";
import { state, type UsageStats } from "./state.js";

const USAGE_STATE_PREFIX = "openBridge.usage.";

/** Persisted shape of the cumulative tool-call counters, per workspace. */
export interface UsageSnapshot {
  startedAt: number;
  calls: number;
  successes: number;
  failures: number;
  byTool: Record<string, number>;
  updatedAt: string;
}

let usagePersistTail: Promise<void> = Promise.resolve();

function usageStateKey(): string {
  return `${USAGE_STATE_PREFIX}${state.activeWorkspaceRoot || "unbound"}`;
}

/**
 * Usage counters are loss-tolerant bookkeeping, but they used to schedule a
 * full state.json rewrite (lock, re-read, stringify, fsync, rename) on EVERY
 * counted tool call — two whole-document writes per MCP request once session
 * tickets were counted. Bursts now coalesce into one trailing write; unref'd
 * so a pending flush never delays shutdown.
 */
const USAGE_FLUSH_MS = 2_000;
let usageFlushTimer: ReturnType<typeof setTimeout> | undefined;

/** Write the current counters now, tail-chained like every other state write. */
function writeUsageStats(): void {
  const key = usageStateKey();
  const snapshot: UsageSnapshot = {
    startedAt: state.usage.startedAt,
    calls: state.usage.calls,
    successes: state.usage.successes,
    failures: state.usage.failures,
    byTool: { ...state.usage.byTool },
    updatedAt: new Date().toISOString(),
  };
  usagePersistTail = usagePersistTail
    .then(() => host().state.update(key, snapshot))
    .catch(() => undefined);
}

/** Schedule a debounced persist of the cumulative usage counters. */
export function persistUsageStats(): void {
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = undefined;
    writeUsageStats();
  }, USAGE_FLUSH_MS);
  usageFlushTimer.unref?.();
}

/** Write any pending counters now; used by reset and shutdown. */
export function flushUsageStats(): Promise<void> {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = undefined;
    writeUsageStats();
  }
  return usagePersistTail;
}

function freshUsage(): UsageStats {
  return { startedAt: Date.now(), calls: 0, successes: 0, failures: 0, byTool: {} };
}

/**
 * Reset the cumulative counters of the ACTIVE workspace to zero and persist
 * the reset immediately, so a stale snapshot cannot resurrect the old totals
 * on the next restart. Runs inside the same serialized write tail as every
 * other usage write, so a burst of tool calls around the reset cannot
 * interleave into a torn state (the reset snapshot is the last write of the
 * tail at call time).
 */
export function resetUsageStats(): void {
  state.usage = freshUsage();
  // The reset itself must not be debounceable — a stale snapshot surviving in
  // the timer could resurrect the old totals after a restart — and it must
  // land even when no flush was pending, so it writes unconditionally.
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = undefined;
  }
  writeUsageStats();
  host().ui.update();
}

/**
 * Restore persisted usage counters for the active workspace, so a window reload
 * or Bridge restart no longer zeroes the console stats. Malformed or
 * missing snapshots fall back to fresh counters.
 */
export function loadUsageStats(): UsageStats {
  try {
    const stored = host().state.get<UsageSnapshot | null>(usageStateKey(), null);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return freshUsage();
    const count = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    const byTool: Record<string, number> = {};
    if (stored.byTool && typeof stored.byTool === "object" && !Array.isArray(stored.byTool)) {
      for (const [name, value] of Object.entries(stored.byTool)) {
        const n = count(value);
        if (name && n > 0) byTool[name] = n;
      }
    }
    const startedAt =
      typeof stored.startedAt === "number" && Number.isFinite(stored.startedAt) && stored.startedAt > 0
        ? Math.floor(stored.startedAt)
        : Date.now();
    return {
      startedAt,
      calls: count(stored.calls),
      successes: count(stored.successes),
      failures: count(stored.failures),
      byTool,
    };
  } catch {
    return freshUsage();
  }
}
