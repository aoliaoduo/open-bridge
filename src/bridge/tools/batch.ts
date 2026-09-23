/**
 * `batch` tool handler (P2): fan out 1-20 tool calls in a single roundtrip.
 * Every item goes through dispatcher.invoke, so usage counting, audit log,
 * redaction, and error semantics are inherited unchanged. The pure
 * planning/aggregation core lives in ./batch-plan.js (unit-tested).
 */
import type { SessionState } from "../state.js";
import type { JsonArgs } from "./json-args.js";
// dispatcher is imported lazily inside batchTool (F5): the static import would
// create a top-level cycle (dispatcher imports batchTool at module load).
import { normalizeBatchCalls, runBatchPlan, type BatchCall, type BatchMode } from "./batch-plan.js";

const MAX_BATCH_CALLS = 20;

export async function batchTool(args: JsonArgs, session?: SessionState): Promise<Record<string, unknown>> {
  const calls = args.calls;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > MAX_BATCH_CALLS) {
    throw new Error(`calls must be an array of 1..${MAX_BATCH_CALLS} {tool, arguments?} entries.`);
  }
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    if (typeof call !== "object" || call === null || typeof call.tool !== "string" || call.tool.length === 0) {
      throw new Error(`calls[${i}].tool must be a non-empty string.`);
    }
    if (
      call.arguments !== undefined &&
      (typeof call.arguments !== "object" || call.arguments === null || Array.isArray(call.arguments))
    ) {
      throw new Error(`calls[${i}].arguments must be a plain object.`);
    }
  }
  if (args.mode !== undefined && args.mode !== "sequential" && args.mode !== "parallel") {
    throw new Error('mode must be "sequential" or "parallel".');
  }
  const mode: BatchMode = args.mode === "parallel" ? "parallel" : "sequential";
  const failFast = args.fail_fast === true;
  const { invoke } = await import("../dispatcher.js");
  // Sub-calls are client-visible only through the outer batch request, which is
  // the single place usage successes/failures are recorded; counting each
  // sub-call here would break calls == successes + failures.
  return runBatchPlan(normalizeBatchCalls(calls as BatchCall[]), mode, failFast, (tool, itemArgs) => invoke(tool, itemArgs, session, { countUsage: false }));
}
