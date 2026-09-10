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
 * read_process_output, wait_process) take no lock: they neither mutate anything
 * nor return file contents, and gating a long blocking read behind an exclusive
 * lock would make a stuck process unkillable.
 *
 * Pure by design: the workspace resolution and patch parsing are injected, so
 * the mapping is unit-testable without vscode.
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
const SINGLE_PATH_WRITE = new Set(["write_file", "create_directory", "delete_file"]);
/** Tools that mutate two named paths. */
const PAIR_PATH_WRITE = new Set(["move_file", "copy_file"]);
/** Tools that read a named file's contents. */
const SINGLE_PATH_READ = new Set(["get_file_info"]);
/** Process lifecycle mutations, keyed by command id. */
const COMMAND_LIFECYCLE = new Set(["force_terminate", "restart_process", "set_process_policy"]);
/** Service lifecycle, keyed by service name. */
const SERVICE_LIFECYCLE = new Set(["start_service", "stop_service", "restart_service", "delete_service"]);
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
  } else if (PAIR_PATH_WRITE.has(name)) {
    for (const field of ["source", "destination"]) {
      const key = fileKey(args[field], ctx);
      if (key) keys.push(key);
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
  } else if (COMMAND_LIFECYCLE.has(name)) {
    const id = args.command_id;
    if (typeof id === "string" && id.trim()) keys.push(`cmd:${id.trim()}`);
  } else if (SERVICE_LIFECYCLE.has(name)) {
    const service = args.name;
    if (typeof service === "string" && service.trim()) keys.push(`svc:${service.trim().toLowerCase()}`);
  } else if (name === "start_all_services" || name === "stop_all_services") {
    const group = typeof args.group === "string" && args.group.trim() ? args.group.trim().toLowerCase() : "*";
    keys.push(`svc:${group}`);
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
