import { record, state, redactSensitiveText, type SessionState } from "./state.js";
import { host } from "../host/host.js";
import { persistUsageStats } from "./usage-store.js";
import { deriveLockPlan, type LockPlanContext } from "./lock-plan.js";
import { acquireLocks, DEFAULT_HOLD_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS } from "./resource-locks.js";
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
  createDirectory, moveFile, copyFile, deleteFile, getFileInfo, applyPatchTool,
} from "./file-tools.js";
import {
  runOrStartProcess, readProcessOutput, interactWithProcess,
  forceTerminate, restartProcess, waitProcess, waitTool,
  setProcessPolicy, getProcessSnapshot, listSessions, setTodos,
} from "./process-tools.js";
import {
  checkPortTool, checkHttpTool, saveService, listServices, startService, stopService,
  restartService, deleteService, serviceStatus, startAllServices, stopAllServices,
  readServiceLogTool,
} from "./service-tools.js";
import { batchTool } from "./batch.js";
import { buildArgsSummary } from "./args-summary.js";
import { reviewChanges } from "./review.js";
import {
  getBridgeStatus, getConfig, setConfigValue, getRecentActivity, getUsageStats,
  getDiagnostics, lsp, reportProgress, getTodos, searchActivityLogTool, clearActivityLogTool,
  workspaceBrief, getAuthStatus, getLockStatus,
} from "./meta-tools.js";
import { openShell, sendToShell, closeShell, listShells } from "./shell-sessions.js";
import { enrichFsError, suggestionHint } from "./error-hints.js";
import type { JsonArgs } from "./json-args.js";

type Args = JsonArgs;
type Handler = (args: Args, session?: SessionState) => unknown | Promise<unknown>;

/** Tool name -> handler. Mirrors TOOL_DEFINITIONS (validated by the contract test). */
const HANDLERS: Record<string, Handler> = {
  list_directory: listDirectory,
  find_files: findFiles,
  search_files: searchFiles,
  read_files: readFiles,
  write_file: writeFile,
  edit_block: editBlock,
  create_directory: createDirectory,
  move_file: moveFile,
  copy_file: copyFile,
  delete_file: deleteFile,
  get_file_info: getFileInfo,
  apply_patch: applyPatchTool,

  run_command: (a) => runOrStartProcess(a, "run_command"),
  start_process: (a) => runOrStartProcess(a, "start_process"),
  interact_with_process: interactWithProcess,
  force_terminate: forceTerminate,
  restart_process: restartProcess,
  wait_process: waitProcess,
  wait: waitTool,
  set_process_policy: setProcessPolicy,
  get_process_snapshot: getProcessSnapshot,
  read_process_output: readProcessOutput,


  open_shell: openShell,
  send_to_shell: sendToShell,
  close_shell: closeShell,
  list_shells: listShells,

  check_port: checkPortTool,
  check_http: checkHttpTool,

  save_service: saveService,
  list_services: listServices,
  start_service: startService,
  stop_service: stopService,
  restart_service: restartService,
  delete_service: deleteService,
  service_status: serviceStatus,
  start_all_services: startAllServices,
  stop_all_services: stopAllServices,
  read_service_log: readServiceLogTool,

  list_sessions: listSessions,
  get_bridge_status: getBridgeStatus,
  get_auth_status: getAuthStatus,
  get_lock_status: getLockStatus,
  get_config: getConfig,
  set_config_value: setConfigValue,
  get_recent_activity: getRecentActivity,
  get_usage_stats: getUsageStats,
  get_diagnostics: getDiagnostics,
  lsp: lsp,
  review_changes: reviewChanges,
  workspace_brief: () => workspaceBrief(),
  set_todos: (a, session) => setTodos(a, session),
  get_todos: getTodos,
  search_activity_log: searchActivityLogTool,
  clear_activity_log: clearActivityLogTool,
  report_progress: reportProgress,
  batch: batchTool,
};

/** Invoke one tool, updating usage stats and the activity log. Throws on unknown/failed tools. */
export async function invoke(
  name: string,
  args: Args,
  session?: SessionState,
  options?: { countUsage?: boolean },
): Promise<unknown> {
  // Include useful execution context in the log while redacting bridge secrets.
  let requestSummary = "Request received.";
  if (name === "run_command" || name === "start_process") {
    const command = typeof args.command === "string" ? redactSensitiveText(args.command.trim()).slice(0, 300) : "";
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : ".";
    requestSummary = command ? `Request received · command: ${command} · cwd: ${cwd}` : requestSummary;
  } else if (name === "start_service" || name === "restart_service" || name === "stop_service") {
    requestSummary = `Request received · service: ${String(args.name ?? "")}`;
  }
  // Redacted argument summary for the audit log (T-1): secrets in parameters
  // are scrubbed by redactSensitiveText before the summary is recorded.
  const argsSummary = buildArgsSummary(args ?? {}, redactSensitiveText);
  record(name, "running", requestSummary, argsSummary);

  // Record<string, Handler> indexing does not admit undefined; cast so the
  // unknown-name branch below stays reachable to the type checker.
  const handler = HANDLERS[name] as Handler | undefined;
  // Count every resolved request, known name or not: the MCP layer records exactly
  // one success/failure per request, so skipping unknown names here (the original
  // F1) let every typo'd call add a failure without a call and broke
  // calls == successes + failures. byTool stays restricted to known tools so
  // typo'd names cannot pollute the per-tool stats. Batch sub-calls pass
  // countUsage:false because they are counted once via the outer MCP request.
  if (options?.countUsage !== false) {
    state.usage.calls += 1;
    if (handler) state.usage.byTool[name] = (state.usage.byTool[name] ?? 0) + 1;
    persistUsageStats();
  }
  if (!handler) throw new Error(`Unknown tool: "${name}".${suggestionHint(name, Object.keys(HANDLERS))}`);

  const lease = await acquireForCall(name, args);
  try {
    const result = await handler(args ?? {}, session);
    // A declared-resource spawn keeps its lease until the process exits, so the
    // resource stays reserved for the process's lifetime.
    if (lease.handOff && handOffToProcess(lease.release, result)) return result;
    lease.release();
    return result;
  } catch (error) {
    lease.release();
    throw enrichFsError(error);
  }
}

/**
 * Move a lease onto the spawned command so its exit releases it. Returns false
 * when the call did not leave a live process (nothing was spawned, or it exited
 * immediately), in which case the caller releases the lease itself.
 */
function handOffToProcess(release: () => void, result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const id = (result as Record<string, unknown>).command_id;
  if (typeof id !== "string" || !id) return false;
  const command = state.commands.get(id);
  if (!command || command.done) return false;
  const prior = command.releaseResourceLocks;
  // Idempotent wrapper: an auto-restart can carry the handle onto a replacement
  // command and the hold-timeout backstop may fire first.
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
  release: () => void;
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
