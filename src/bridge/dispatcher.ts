import { record, state, redactSensitiveText, type SessionState } from "./state.js";
import { host } from "../host/host.js";
import { persistUsageStats } from "./usage-store.js";
import { deriveLockPlan, type LockPlanContext } from "./lock-plan.js";
import { acquireLocks, DEFAULT_HOLD_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS, type LockRelease } from "./resource-locks.js";
import { workspaceContext } from "./state.js";
import { patchTargetPaths } from "../mcp/patch.js";

/** The real-world wiring for the pure lock planner. */
const LOCK_CONTEXT: LockPlanContext = {
  resolvePath: input => workspaceContext.resolve(input),
  patchTargets: args => patchTargetPaths(args.patch, args.patch_file, workspaceContext),
  workspaceRoot: () => workspaceContext.root(),
  servicesInGroup: group => [...state.services.entries()]
    .filter(([, service]) => !group || String(service.group ?? "").trim().toLowerCase() === group)
    .map(([name]) => name.trim().toLowerCase()),
};
import {
  listDirectory, findFiles, searchFiles, readFiles, writeFile, editBlock,
  getFileInfo, applyPatchTool,
} from "./file-tools.js";
import {
  runOrStartProcess, readProcessOutput, interactWithProcess,
  setProcessPolicy, getProcessSnapshot, setTodos,
} from "./process-tools.js";
import { saveService, readServiceLogTool } from "./service-tools.js";
import { batchTool } from "./batch.js";
import { runScript } from "./script-tools.js";
import { buildArgsSummary } from "./args-summary.js";
import { reviewChanges } from "./review.js";
import {
  getConfig, setConfigValue, getUsageStats, getDiagnostics, lsp,
  reportProgress, getTodos, workspaceBrief,
} from "./meta-tools.js";
import { sendToShell, closeShell } from "./shell-sessions.js";
import {
  activityLogFamily, bridgeStatusFamily, connectivityFamily, fileOpFamily,
  openShellFamily, processControlFamily, serviceFamily, serviceStatusFamily, waitFamily,
} from "./tool-families.js";
import { normalizeToolCall, type CanonicalCall } from "./tool-call-shape.js";
import { listSkills } from "./skills.js";
import { enrichFsError, suggestionHint } from "./error-hints.js";
import type { JsonArgs } from "./json-args.js";

type Args = JsonArgs;
type Handler = (args: Args, session?: SessionState) => unknown | Promise<unknown>;

/**
 * Tool name -> handler. Mirrors TOOL_DEFINITIONS (validated by the contract test).
 *
 * The merged families appear once each and dispatch on their discriminator; the
 * handlers they call are the same functions the single-purpose tools used, so
 * what a name can do never moves — only how many names there are.
 */
const HANDLERS: Record<string, Handler> = {
  // ---- workspace reading -------------------------------------------------
  list_directory: listDirectory,
  find_files: findFiles,
  search_files: searchFiles,
  read_files: readFiles,
  get_file_info: getFileInfo,
  workspace_brief: () => workspaceBrief(),
  list_skills: () => listSkills(),
  review_changes: reviewChanges,
  get_todos: getTodos,

  // ---- workspace writing -------------------------------------------------
  write_file: writeFile,
  edit_block: editBlock,
  apply_patch: applyPatchTool,
  file_op: fileOpFamily,
  set_todos: (a, session) => setTodos(a, session),
  report_progress: reportProgress,

  // ---- commands and supervised processes ---------------------------------
  run_command: (a) => runOrStartProcess(a, "run_command"),
  start_process: (a) => runOrStartProcess(a, "start_process"),
  read_process_output: readProcessOutput,
  interact_with_process: interactWithProcess,
  process_control: processControlFamily,
  wait: waitFamily,
  set_process_policy: setProcessPolicy,
  get_process_snapshot: getProcessSnapshot,

  // ---- persistent shells -------------------------------------------------
  open_shell: openShellFamily,
  send_to_shell: sendToShell,
  close_shell: closeShell,

  // ---- reachability ------------------------------------------------------
  connectivity: connectivityFamily,

  // ---- saved services ----------------------------------------------------
  save_service: saveService,
  service: serviceFamily,
  service_status: serviceStatusFamily,
  read_service_log: readServiceLogTool,

  // ---- Bridge introspection ---------------------------------------------
  bridge_status: bridgeStatusFamily,
  get_config: getConfig,
  set_config_value: setConfigValue,
  activity_log: activityLogFamily,
  get_usage_stats: getUsageStats,
  get_diagnostics: getDiagnostics,
  lsp: lsp,

  // ---- orchestration -----------------------------------------------------
  batch: batchTool,
  run_script: runScript,
};

/** Invoke one tool, updating usage stats and the activity log. Throws on unknown/failed tools. */
export async function invoke(
  name: string,
  args: Args,
  session?: SessionState,
  options?: { countUsage?: boolean },
): Promise<unknown> {
  // One normalization point: a legacy name is rewritten into the call the
  // catalog advertises today, and everything below — handler lookup, lock plan,
  // activity log — works on canonical names only.
  const call = normalizeToolCall(name, args ?? {});
  const tool = call.tool;
  const callArgs = call.args;

  // Include useful execution context in the log while redacting bridge secrets.
  let requestSummary = "Request received.";
  if (tool === "run_command" || tool === "start_process") {
    const command = typeof callArgs.command === "string" ? redactSensitiveText(callArgs.command.trim()).slice(0, 300) : "";
    const cwd = typeof callArgs.cwd === "string" && callArgs.cwd.trim() ? callArgs.cwd.trim() : ".";
    requestSummary = command ? `Request received · command: ${command} · cwd: ${cwd}` : requestSummary;
  } else if (tool === "run_script") {
    // A script's first line, redacted and bounded, is the log's code preview: enough
    // to see what was attempted without dumping a program into the activity log.
    const raw = typeof callArgs.source === "string" ? callArgs.source.replace(/\r\n?/g, "\n").trim() : "";
    const firstLine = raw.split("\n").find(line => line.trim().length > 0) ?? "";
    const scriptLines = raw ? raw.split("\n").length : 0;
    const preview = redactSensitiveText(firstLine.trim()).slice(0, 160);
    requestSummary = preview
      ? `Request received · script: ${preview}${scriptLines > 1 ? ` · ${scriptLines} line(s)` : ""}`
      : requestSummary;
  } else if (tool === "service") {
    const target = typeof callArgs.name === "string" && callArgs.name.trim() ? callArgs.name.trim() : String(callArgs.action ?? "");
    requestSummary = `Request received · service: ${target}`;
  }
  // Redacted argument summary for the audit log (T-1): secrets in parameters
  // are scrubbed by redactSensitiveText before the summary is recorded.
  const argsSummary = buildArgsSummary(callArgs, redactSensitiveText);
  // The audit log keeps the name the caller used (that is the fact worth
  // recording) and states what a legacy name resolved to, so a client still
  // speaking the old vocabulary is visible instead of invisible.
  record(
    name,
    "running",
    call.alias ? `${requestSummary} · legacy name ${call.alias.used} -> ${call.alias.call}` : requestSummary,
    argsSummary,
  );

  // Record<string, Handler> indexing does not admit undefined; cast so the
  // unknown-name branch below stays reachable to the type checker.
  const handler = HANDLERS[tool] as Handler | undefined;
  // Count every resolved request, known name or not: the MCP layer records exactly
  // one success/failure per request, so skipping unknown names here (the original
  // F1) let every typo'd call add a failure without a call and broke
  // calls == successes + failures. byTool stays restricted to known tools so
  // typo'd names cannot pollute the per-tool stats. Batch sub-calls pass
  // countUsage:false because they are counted once via the outer MCP request.
  if (options?.countUsage !== false) {
    state.usage.calls += 1;
    // Counted under the canonical name: usage is about the capability being
    // used, and a legacy spelling must not split a tool's statistics in two.
    if (handler) state.usage.byTool[tool] = (state.usage.byTool[tool] ?? 0) + 1;
    persistUsageStats();
    // Per-session counter for the console's 会话 page: who is actually using
    // this instance, not just how busy it is overall. Batch sub-calls pass
    // countUsage:false, so a batch costs one call on its session too.
    if (session) session.calls += 1;
  }
  if (!handler) throw new Error(`Unknown tool: "${name}".${suggestionHint(name, Object.keys(HANDLERS))}`);

  const lease = await acquireForCall(tool, callArgs);
  try {
    const result = await handler(callArgs, session);
    const answer = call.alias ? annotateLegacyResult(result, call.alias) : result;
    // A declared-resource spawn keeps its lease until the process exits, so the
    // resource stays reserved for the process's lifetime.
    if (lease.handOff && handOffToProcess(lease.release, answer)) return answer;
    lease.release();
    return answer;
  } catch (error) {
    lease.release();
    throw enrichFsError(error);
  }
}

/**
 * Tell a caller that used a legacy name what it became.
 *
 * Only object results are annotated: wrapping an array or a scalar would change
 * the shape a legacy caller is parsing, and a hint is not worth breaking a
 * parser. Those callers still see the note in the activity log.
 */
function annotateLegacyResult(result: unknown, alias: NonNullable<CanonicalCall["alias"]>): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return {
    ...(result as Record<string, unknown>),
    deprecated: { name: alias.used, replaced_by: alias.replaced_by, call: alias.call },
  };
}

/**
 * Move a lease onto the spawned command so its exit releases it. Returns false
 * when the call did not leave a live process (nothing was spawned, or it exited
 * immediately), in which case the caller releases the lease itself.
 */
function handOffToProcess(release: LockRelease, result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const id = (result as Record<string, unknown>).command_id;
  if (typeof id !== "string" || !id) return false;
  const command = state.commands.get(id);
  if (!command || command.done) return false;
  const prior = command.releaseResourceLocks;
  // The resource is now owned by a live process, not by this call, so the
  // hold-timeout backstop MUST be disarmed first. Leaving it armed meant a
  // process that outlived holdTimeoutMs (a dev server, a watch build) had its
  // lock force-reclaimed and handed to the next caller while it was still
  // running — exactly the double-claim `resource_keys` exists to prevent.
  // The lock now lives until the process exits.
  release.handOff?.();
  // Idempotent wrapper: an auto-restart can carry the handle onto a replacement
  // command, so the exit path and any explicit stop must not double-release.
  let released = false;
  const combined = () => {
    if (released) return;
    released = true;
    release();
    prior?.();
  };
  command.releaseResourceLocks = combined;
  return true;
}

interface CallLease {
  release: LockRelease;
  handOff: boolean;
}

/**
 * Take this call's resources before it runs. Every acquisition site is here (the
 * only caller of a handler), so a handler cannot re-enter and a deadlock cycle
 * cannot form. Read-only discovery tools resolve to no plan and pay nothing.
 */
async function acquireForCall(name: string, args: Args): Promise<CallLease> {
  const noop: CallLease = { release: () => undefined, handOff: false };
  const config = host().config;
  if (config.get<boolean>("concurrency.enabled", true) !== true) return noop;

  let plan;
  try {
    plan = await deriveLockPlan(name, args ?? {}, LOCK_CONTEXT);
  } catch {
    return noop; // never block a call because planning failed
  }
  if (!plan) return noop;

  const holdTimeoutMs = positiveOr(config.get<number>("concurrency.holdTimeoutMs", DEFAULT_HOLD_TIMEOUT_MS), DEFAULT_HOLD_TIMEOUT_MS);
  const waitTimeoutMs = positiveOr(config.get<number>("concurrency.waitTimeoutMs", DEFAULT_WAIT_TIMEOUT_MS), DEFAULT_WAIT_TIMEOUT_MS);

  const release = await acquireLocks(plan, {
    holdTimeoutMs,
    waitTimeoutMs,
    onReclaim: info => record(
      "bridge",
      "warning",
      `Lock reclaimed after ${Math.round(info.heldMs / 1000)}s: ${info.label} held ${info.keys.join(", ")}.`,
    ),
    onContention: info => record(
      "bridge",
      "progress",
      `Waiting for ${info.keys.join(", ")} (held by another call): ${info.label}.`,
    ),
  });
  return { release, handOff: plan.handOffToProcess };
}

function positiveOr(value: unknown, fallback: number): number {
  const numeric = Number(value);
  // 0 is meaningful here (the settings page documents it): holdTimeoutMs 0 =
  // never reclaim, waitTimeoutMs 0 = wait forever. Only non-finite or negative
  // values fall back to the default.
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}
