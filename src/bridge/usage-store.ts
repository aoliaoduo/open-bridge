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
 * Persist the cumulative usage counters for the active workspace. Tail-chained
 * like persistServices/persistTodos so bursts of tool calls serialize into
 * ordered state writes. Called from the only mutation sites (dispatcher
 * call counting, lifecycle success/failure recording).
 */
export function persistUsageStats(): void {
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
  persistUsageStats();
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
