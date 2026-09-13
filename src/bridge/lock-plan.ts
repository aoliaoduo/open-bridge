/**
 * Maps a tool call to the resources it must hold, so `dispatcher.invoke` can
 * serialize the ones that would otherwise race.
 *
 * Key shapes:
 *   file:<abs path>   file contents (writers exclusive, readers shared)
 *   cmd:<command_id>  one managed process's lifecycle
 *   svc:<name|*>      a saved service's lifecycle
 *   res:<key>         a caller-declared resource (build dir, device, port…)
 *
 * Only tools whose effect can actually collide are listed. Discovery-only tools
 * (search_files, find_files, list_directory, review_changes, get_process_snapshot,
 * read_process_output, wait) take no lock: they neither mutate anything
 * nor return file contents, and gating a long blocking read behind an exclusive
 * lock would make a stuck process unkillable.
 *
 * Pure by design: the workspace resolution and patch parsing are injected, so
 * the mapping is unit-testable in plain node.
 */

import type { LockMode } from "./resource-locks.js";

/** Everything this module needs from the outside world. */
export interface LockPlanContext {
  /** Absolute path for a (possibly relative, possibly nonexistent) target. */
  resolvePath(input: string): string;
  /** Absolute paths a patch will touch; empty when it cannot be determined. */
  patchTargets(args: Record<string, unknown>): Promise<string[]>;
  /** Workspace root, used as the coarse fallback key. */
  workspaceRoot(): string;
  /**
   * Lowercased names of saved services in `group` ("" = every group). Consumed
   * to expand start_all/stop_all into concrete svc:<name> keys — the lock
   * table matches by exact string, so a literal "svc:*" key never conflicted
   * with "svc:<name>" and an all-services run could interleave with an
   * individual service op.
   */
  servicesInGroup(group: string): string[];
}

export interface LockPlan {
  keys: string[];
  mode: LockMode;
  label: string;
  /**
   * True for caller-declared resource keys on a spawn tool: the lease must
   * survive the call and be released when the spawned process exits, so a
   * declared port or output directory stays reserved for the process's whole
   * lifetime rather than only while start_process is returning.
   */
  handOffToProcess: boolean;
}

/** Tools that mutate a single named file. */
const SINGLE_PATH_WRITE = new Set(["write_file"]);
/**
 * Tools that read one named path's METADATA (mtime/size/sha256), not contents.
 *
 * It still takes a shared lock, and that is the point: hashing a large file is a
 * long read, and a concurrent `write_file` on the same path must not land in the
 * middle of it. Do not "fix" this entry to match the module doc's
 * "neither mutate nor return file contents" wording by removing the lock.
 */
const SINGLE_PATH_READ = new Set(["get_file_info"]);
/** Process lifecycle mutations, keyed by command id. */
const COMMAND_LIFECYCLE = new Set(["set_process_policy"]);
/** file_op operations that touch exactly one path. */
const FILE_OP_SINGLE = new Set(["create_directory", "delete"]);
/** file_op operations that touch two paths. */
const FILE_OP_PAIR = new Set(["copy", "move"]);
/** service actions that name exactly one service. */
const SERVICE_ACTION_SINGLE = new Set(["start", "stop", "restart", "delete"]);
/** Callers may declare their own resource keys on these. */
const DECLARED_RESOURCES = new Set(["run_command", "start_process", "save_service"]);

function fileKey(input: unknown, ctx: LockPlanContext): string | undefined {
  if (typeof input !== "string" || !input.trim()) return undefined;
  try {
    const resolved = ctx.resolvePath(input);
    if (!resolved) return undefined;
    // Windows filesystems are case-insensitive, so `C:\Foo` and `c:\foo` are the
    // same lock. (Per-directory case sensitivity is exotic; over-locking is safe.)
    const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    return `file:${normalized}`;
  } catch {
    return undefined;
  }
}

function declaredKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(item => `res:${item.trim().toLowerCase()}`)
    .slice(0, 16);
}

function editBlockPaths(args: Record<string, unknown>, ctx: LockPlanContext): string[] {
  const out: string[] = [];
  const direct = fileKey(args.path, ctx);
  if (direct) out.push(direct);
  const edits = args.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const key = fileKey((edit as Record<string, unknown>).path, ctx);
      if (key) out.push(key);
    }
  }
  return out;
}

/**
 * Resolve the lock plan for one tool call, or `undefined` when the call needs
 * no exclusion. Never throws: an unresolvable target simply yields no keys, and
 * the tool reports its own error.
 */
export async function deriveLockPlan(
  name: string,
  args: Record<string, unknown>,
  ctx: LockPlanContext,
): Promise<LockPlan | undefined> {
  const keys: string[] = [];
  let mode: LockMode = "write";

  if (SINGLE_PATH_WRITE.has(name)) {
    const key = fileKey(args.path, ctx);
    if (key) keys.push(key);
  } else if (name === "file_op") {
    // The plan follows the operation, not the family: a delete and a copy of the
    // same path must not look alike to the lock table.
    const op = typeof args.op === "string" ? args.op.trim() : "";
    if (FILE_OP_SINGLE.has(op)) {
      const key = fileKey(args.path, ctx);
      if (key) keys.push(key);
    } else if (FILE_OP_PAIR.has(op)) {
      for (const field of ["source", "destination"]) {
        const key = fileKey(args[field], ctx);
        if (key) keys.push(key);
      }
    }
  } else if (name === "edit_block") {
    keys.push(...editBlockPaths(args, ctx));
  } else if (name === "apply_patch") {
    for (const target of await ctx.patchTargets(args)) {
      const key = fileKey(target, ctx);
      if (key) keys.push(key);
    }
    // A patch whose targets could not be resolved still must not run alongside
    // another patch, so fall back to one coarse exclusive key.
    if (!keys.length) {
      const root = ctx.workspaceRoot();
      if (root) keys.push(fileKey(root, ctx)!);
    }
  } else if (name === "read_files") {
    mode = "read";
    const paths = args.paths;
    if (Array.isArray(paths)) {
      for (const entry of paths) {
        const key = fileKey(entry, ctx);
        if (key) keys.push(key);
      }
    }
  } else if (SINGLE_PATH_READ.has(name)) {
    mode = "read";
    const key = fileKey(args.path, ctx);
    if (key) keys.push(key);
  } else if (COMMAND_LIFECYCLE.has(name) || name === "process_control") {
    // Both process-control actions act on one managed process, so the command id
    // is the resource either way.
    const id = args.command_id;
    if (typeof id === "string" && id.trim()) keys.push(`cmd:${id.trim()}`);
  } else if (name === "service") {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (SERVICE_ACTION_SINGLE.has(action)) {
      const service = args.name;
      if (typeof service === "string" && service.trim()) keys.push(`svc:${service.trim().toLowerCase()}`);
    } else if (action === "start_all" || action === "stop_all") {
      const group = typeof args.group === "string" && args.group.trim() ? args.group.trim().toLowerCase() : "";
      // Expand to the concrete services the batch WILL touch: exact-key matching
      // makes a literal "svc:*" or "svc:<group>" disjoint from "svc:<name>", so
      // stop_all could tear a service down while start/restart of that same
      // service ran next to it. Services saved after this plan was derived are
      // not covered — the batch iterates the same snapshot, so the exposure is
      // theoretical.
      keys.push(...ctx.servicesInGroup(group).map(serviceName => `svc:${serviceName}`));
    }
    // Any other action is refused by the family handler; planning nothing is
    // better than guessing at a resource the call will never touch.
  }

  if (DECLARED_RESOURCES.has(name)) keys.push(...declaredKeys(args.resource_keys));

  const unique = [...new Set(keys)].sort();
  if (!unique.length) return undefined;
  return {
    keys: unique,
    mode,
    label: `${name} · ${unique[0]}`.slice(0, 120),
    // Only declared resource keys are process-scoped. A file/cmd/svc plan is
    // always released when the call returns.
    handOffToProcess: DECLARED_RESOURCES.has(name),
  };
}
