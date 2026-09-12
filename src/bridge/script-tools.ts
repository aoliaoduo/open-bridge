/**
 * The `run_script` handler: argument validation, the catalog filter, and the
 * ordinary dispatcher handed to the sandbox.
 *
 * This module is deliberately thin. Everything that decides *how* a script runs
 * lives in ./script-sandbox.js (mechanism, injectable, unit-tested); everything
 * that decides *what a script may touch* is the Bridge's existing answers —
 * the advertised catalog of this instance (`listToolDefinitions()`, so the
 * operator's toolProfile and the host's capabilities apply exactly as they do to
 * a direct `tools/list`) and the dispatcher (`invoke`), so locks, audit logging,
 * redaction and error semantics are not re-implemented here.
 *
 * Sub-calls pass `countUsage: false`, matching `batch`: the outer `run_script`
 * request is the one place usage successes/failures are recorded, so
 * `calls == successes + failures` keeps holding. Visibility is not lost — the
 * envelope reports `calls` and a per-tool `by_tool` breakdown, and every
 * sub-call still lands in the audit log with its own `record()` line.
 */

import type { JsonArgs } from "./json-args.js";
import type { SessionState } from "./state.js";
import { listToolDefinitions } from "./tool-catalog.js";
import {
  clampScriptCalls,
  clampScriptTimeout,
  normalizeScriptSource,
  runScriptInSandbox,
  type ScriptRunEnvelope,
} from "./script-sandbox.js";

export async function runScript(args: JsonArgs, session?: SessionState): Promise<ScriptRunEnvelope> {
  const source = normalizeScriptSource(args.source);
  const timeoutMs = clampScriptTimeout(args.timeout_ms);
  const maxCalls = clampScriptCalls(args.max_calls);
  const allowedTools = new Set(listToolDefinitions().map(tool => tool.name));
  // Lazy import: dispatcher imports this module's handler at load time (same
  // dependency direction as batch.ts), so a static import would be a cycle.
  const { invoke } = await import("./dispatcher.js");
  return await runScriptInSandbox({
    source,
    timeoutMs,
    maxCalls,
    allowedTools,
    callTool: (name, callArgs) => invoke(name, callArgs, session, { countUsage: false }),
  });
}
