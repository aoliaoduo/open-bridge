/**
 * The handlers behind the merged tool families.
 *
 * Each function here is a thin, explicit switch over one discriminator
 * (`service{action}`, `file_op{op}`, …) that calls the very same handler the
 * single-purpose tool used to call. Nothing about the work changes: the
 * underlying functions keep their own validation, locking semantics and error
 * messages, and this layer's only job is to route the request and to reject a
 * discriminator value the catalog does not offer.
 *
 * Two deliberate properties:
 *
 *  - **Arguments are re-picked per branch.** `file_op{op:"delete"}` forwards
 *    `path`/`recursive` and nothing else, so a stray `source` cannot reach a
 *    handler that never expected it (and the lock planner, which reads the same
 *    arguments, sees exactly what will happen).
 *  - **An unknown discriminator is an error, not a guess.** The message lists
 *    the accepted values, because the caller's next move — fix the argument and
 *    call again — is the whole point of a family tool.
 */

import {
  checkHttpTool, checkPortTool, deleteService, listServices, restartService,
  serviceStatus, startAllServices, startService, stopService, stopAllServices,
} from "./service-tools.js";
import { forceTerminate, listSessions, restartProcess, waitProcess, waitTool } from "./process-tools.js";
import { copyFile, createDirectory, deleteFile, moveFile } from "./file-tools.js";
import {
  clearActivityLogTool, getAuthStatus, getBridgeStatus, getLockStatus,
  getRecentActivity, searchActivityLogTool,
} from "./meta-tools.js";
import { listShells, openShell } from "./shell-sessions.js";
import { FAMILY_ACTIONS, FAMILY_PARAMS } from "./tool-call-shape.js";

type Args = Record<string, unknown>;

/** Copy the named arguments that are present, so nothing else reaches the handler. */
function pick(args: Args, keys: readonly string[]): Args {
  const out: Args = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

/** The discriminator value a family call cannot run without. */
function required(args: Args, family: keyof typeof FAMILY_ACTIONS): string {
  const key = FAMILY_PARAMS[family];
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Missing "${key}". Pass one of: ${FAMILY_ACTIONS[family].join(", ")}.`);
}

/** Reject a value the catalog does not offer, naming the ones that exist. */
function invalid(family: keyof typeof FAMILY_ACTIONS, value: string): Error {
  return new Error(`Unknown ${FAMILY_PARAMS[family]} "${value}" for ${family}. Valid values: ${FAMILY_ACTIONS[family].join(", ")}.`);
}

// ---------------------------------------------------------------------------
// service — start / stop / restart / delete one service, or a whole group
// ---------------------------------------------------------------------------

export async function serviceFamily(args: Args): Promise<unknown> {
  const action = required(args, "service");
  switch (action) {
    case "start":
      return startService(pick(args, ["name"]));
    case "stop":
      return stopService(pick(args, ["name"]));
    case "restart":
      return restartService(pick(args, ["name"]));
    case "delete":
      return deleteService(pick(args, ["name"]));
    case "start_all":
      return startAllServices(pick(args, ["group", "parallel"]));
    case "stop_all":
      return stopAllServices(pick(args, ["group"]));
    default:
      throw invalid("service", action);
  }
}

// ---------------------------------------------------------------------------
// service_status — live state (default) or the definitions without probing
// ---------------------------------------------------------------------------

export function serviceStatusFamily(args: Args): Promise<unknown> {
  const detail = typeof args.detail === "string" && args.detail.trim() ? args.detail.trim() : "live";
  if (detail === "definitions") return Promise.resolve(listServices());
  if (detail !== "live") throw invalid("service_status", detail);
  return serviceStatus(pick(args, ["name", "group", "timeout_ms"]));
}

// ---------------------------------------------------------------------------
// file_op — create / copy / move / delete
// ---------------------------------------------------------------------------

export function fileOpFamily(args: Args): Promise<unknown> {
  const op = required(args, "file_op");
  switch (op) {
    case "create_directory":
      return createDirectory(pick(args, ["path"]));
    case "copy":
      return copyFile(pick(args, ["source", "destination", "overwrite"]));
    case "move":
      return moveFile(pick(args, ["source", "destination", "overwrite"]));
    case "delete":
      return deleteFile(pick(args, ["path", "recursive"]));
    default:
      throw invalid("file_op", op);
  }
}

// ---------------------------------------------------------------------------
// process_control — restart or terminate a supervised process
// ---------------------------------------------------------------------------

export function processControlFamily(args: Args): Promise<unknown> {
  const action = required(args, "process_control");
  switch (action) {
    case "restart":
      return restartProcess(pick(args, ["command_id", "delay_ms"]));
    case "terminate":
      return forceTerminate(pick(args, ["command_id"]));
    default:
      throw invalid("process_control", action);
  }
}

// ---------------------------------------------------------------------------
// wait — a fixed number of milliseconds, or one process's exit
// ---------------------------------------------------------------------------

export function waitFamily(args: Args): Promise<unknown> {
  // command_id wins when both are present: waiting for a process the caller
  // named is never the same intent as sleeping, and a caller that passed both
  // meant the process.
  if (typeof args.command_id === "string" && args.command_id.trim()) {
    return waitProcess(pick(args, ["command_id", "timeout_ms"]));
  }
  if (args.ms !== undefined) return Promise.resolve(waitTool(pick(args, ["ms"])));
  throw new Error('wait needs "ms" (sleep) or "command_id" (wait for that process to exit).');
}

// ---------------------------------------------------------------------------
// bridge_status — one section of the Bridge's own state
// ---------------------------------------------------------------------------

export function bridgeStatusFamily(args: Args): Promise<unknown> | unknown {
  const section = typeof args.section === "string" && args.section.trim() ? args.section.trim() : "overview";
  switch (section) {
    case "overview":
      return getBridgeStatus();
    case "auth":
      return getAuthStatus();
    case "locks":
      return getLockStatus();
    case "sessions":
      return listSessions();
    default:
      throw invalid("bridge_status", section);
  }
}

// ---------------------------------------------------------------------------
// activity_log — the audit log: recent / search / clear
// ---------------------------------------------------------------------------

export function activityLogFamily(args: Args): Promise<unknown> | unknown {
  const action = typeof args.action === "string" && args.action.trim() ? args.action.trim() : "recent";
  switch (action) {
    case "recent":
      return getRecentActivity(pick(args, ["max_results"]));
    case "search":
      return searchActivityLogTool(pick(args, ["tool", "status", "query", "since", "limit", "offset"]));
    case "clear":
      return clearActivityLogTool();
    default:
      throw invalid("activity_log", action);
  }
}

// ---------------------------------------------------------------------------
// connectivity — a TCP port or an HTTP endpoint
// ---------------------------------------------------------------------------

export function connectivityFamily(args: Args): Promise<unknown> {
  const explicit = typeof args.target === "string" && args.target.trim() ? args.target.trim() : "";
  // Inferring the target from the arguments the caller did provide keeps the
  // common case to one argument: `{url}` is HTTP, `{port}` is TCP.
  const target = explicit || (args.url !== undefined ? "http" : args.port !== undefined ? "port" : "");
  switch (target) {
    case "port":
      return checkPortTool(pick(args, ["host", "port", "timeout_ms", "scope"]));
    case "http":
      return checkHttpTool(pick(args, ["url", "timeout_ms", "max_redirects", "scope"]));
    case "":
      throw new Error('connectivity needs "url" (HTTP) or "port" (TCP), or an explicit target of "http" or "port".');
    default:
      throw invalid("connectivity", target);
  }
}

// ---------------------------------------------------------------------------
// open_shell — open one, or list the open ones
// ---------------------------------------------------------------------------

export function openShellFamily(args: Args): Promise<unknown> | unknown {
  // `list: true` is how the old list_shells call arrives here; a truthy value is
  // enough because a caller that says `list: "true"` clearly meant the list.
  if (args.list) return listShells();
  return openShell(pick(args, ["name", "cwd"]));
}
