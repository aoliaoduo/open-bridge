/**
 * Pure planning/aggregation core for the `batch` tool (P2).
 *
 * Kept free of state/dispatcher imports so the aggregation and
 * fail-fast semantics stay unit-testable in plain node (test/batch.test.ts).
 * The dispatcher wiring lives in ./batch.js.
 */

export type BatchMode = "sequential" | "parallel";

export type BatchCall = {
  tool: string;
  arguments?: Record<string, unknown>;
};

export type BatchResultItem = {
  /** Zero-based position in the submitted calls array; stable even for duplicate tool names. */
  index: number;
  tool: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type BatchSummary = {
  mode: BatchMode;
  total: number;
  succeeded: number;
  failed: number;
  stopped_early: boolean;
  results: BatchResultItem[];
};

/** One executor per item; the handler passes in dispatcher.invoke. */
export type BatchExecutor = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

const NESTED_BATCH_ERROR = "nested batch not allowed (a batch call cannot contain another batch)";

/**
 * Run one planned call. A nested `batch` is rejected up front (guards
 * against 20^N fan-out); executor errors are captured as {ok:false, error}
 * and never thrown.
 */
function runOneBatchCall(call: BatchCall, index: number, exec: BatchExecutor): Promise<BatchResultItem> {
  const tool = call.tool;
  if (tool === "batch") {
    return Promise.resolve({ index, tool, ok: false, error: NESTED_BATCH_ERROR });
  }
  return exec(tool, call.arguments ?? {}).then(
    result => ({ index, tool, ok: true, result }),
    error => ({ index, tool, ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
}

function summarize(calls: BatchCall[], results: BatchResultItem[], mode: BatchMode, stoppedEarly: boolean): BatchSummary {
  const failed = results.filter(item => !item.ok).length;
  return {
    mode,
    total: calls.length,
    succeeded: results.length - failed,
    failed,
    stopped_early: stoppedEarly,
    results,
  };
}

/**
 * Execute a batch plan. Every result carries its zero-based submitted index, so
 * a caller can distinguish repeated tools and, after sequential failFast, resume
 * from the first index absent from results. Parallel runs everything via
 * Promise.all and always reports stopped_early:false (failFast is ignored there).
 */
export async function runBatchPlan(
  calls: BatchCall[],
  mode: BatchMode,
  failFast: boolean,
  exec: BatchExecutor,
): Promise<BatchSummary> {
  if (mode === "parallel") {
    const results = await Promise.all(calls.map((call, index) => runOneBatchCall(call, index, exec)));
    return summarize(calls, results, "parallel", false);
  }
  const results: BatchResultItem[] = [];
  let stoppedEarly = false;
  for (const [index, call] of calls.entries()) {
    const result = await runOneBatchCall(call, index, exec);
    results.push(result);
    if (failFast && !result.ok) {
      stoppedEarly = true;
      break;
    }
  }
  return summarize(calls, results, "sequential", stoppedEarly);
}

/**
 * Tolerate the "args" alias for the per-item payload key (S2): an item's
 * arguments live under `arguments`; a plain-object `args` is promoted when
 * `arguments` is absent, `arguments` wins when both are present, and a
 * non-object `args` is ignored. Pure, so it stays unit-testable in node.
 */
export function normalizeBatchCalls(calls: BatchCall[]): BatchCall[] {
  return calls.map(call => {
    const item = call as Record<string, unknown>;
    if (item.arguments === undefined) {
      const args = item.args;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        return { ...call, arguments: args as Record<string, unknown> };
      }
    }
    return call;
  });
}
