/**
 * Behaviour annotations for the advertised tool catalog.
 *
 * These are the MCP `ToolAnnotations` hints: they tell a client what a tool
 * *does* so the client can decide how to present or gate it. They deliberately
 * change **nothing** about what the Bridge will do — the file-access policy, the
 * concurrency model and the tool set are untouched, no call is refused, and no
 * confirmation is demanded by the server. That is the whole point: this is
 * information for the model and the host UI, not a new gate. The capability-
 * first rule for this project is that safety features may add understanding but
 * must never subtract reach.
 *
 * Hints are conservative in the direction that matters:
 *
 *  - `readOnlyHint: true` is claimed only where a tool cannot alter the
 *    workspace, a process, the saved services, the log, or the Bridge config.
 *    Tools that merely read *host* state (sessions, locks, usage) are still
 *    read-only — they observe, they do not mutate.
 *  - `destructiveHint` is left **unset (undefined) where it does not apply**, and
 *    explicitly `false` for additive writes that cannot lose data (create,
 *    append, copy onto a new path). This matters because the spec's default is
 *    `true`: saying nothing is a stronger claim than saying `false`, so a tool
 *    that only adds must say so rather than inherit "destructive".
 *  - `idempotentHint: true` means repeating the call with the same arguments
 *    lands in the same state. `wait`, `check_*`, and every read qualify;
 *    `run_command`, `start_process` and `wait_process` do not, because a second
 *    invocation runs a second thing.
 *  - `openWorldHint: true` marks interaction with something outside this
 *    machine's workspace/process table (the network, the tunnel, an external
 *    endpoint). It is the one hint that is about reach rather than mutation.
 *
 * Kept beside `tool-catalog.ts` rather than inline in `tool-definitions.ts`
 * (whose entries are a single `as const` literal) so the hints are a typed,
 * separately testable table and the tool list stays free of per-entry noise.
 * `listToolDefinitions()` merges them at emission time, so `tools/list` reports
 * the same annotations on both protocol eras.
 */

/** The MCP `ToolAnnotations` fields, with the spec's defaults made explicit. */
export interface ToolAnnotations {
  /** The tool does not modify its environment. */
  readOnlyHint: boolean;
  /**
   * The tool may perform destructive updates. Left `undefined` when the
   * distinction does not apply, per the spec, rather than being defaulted to
   * `true` — an absent hint is not a claim.
   */
  destructiveHint?: boolean;
  /** Repeated calls with the same arguments have no additional effect. */
  idempotentHint: boolean;
  /** The tool may interact with an open world beyond this machine. */
  openWorldHint: boolean;
}

/** Read-only: observes the workspace or host and cannot change either. */
const READ: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
/** Read-only, but reaches the network (a port, an HTTP endpoint, the tunnel). */
const READ_NETWORK: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

/**
 * Writes that only add: a create, an append, a copy onto a new path. Repeating
 * one cannot destroy what was already there, so `destructiveHint` is explicitly
 * `false` rather than left to inherit the spec's `true`.
 */
const ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/**
 * Writes that can lose or overwrite existing content, or that run arbitrary
 * work. `destructiveHint` is deliberately omitted: the spec already treats an
 * absent hint as "may be destructive", and claiming `false` here would be a
 * promise the Bridge cannot keep for, say, an arbitrary shell command.
 */
const MUTATING: ToolAnnotations = { readOnlyHint: false, idempotentHint: false, openWorldHint: false };

/** Starts or stops supervised work; a repeat is a second start/stop, not a no-op. */
const PROCESS_CONTROL: ToolAnnotations = { readOnlyHint: false, idempotentHint: false, openWorldHint: false };

/**
 * A push reaches the operator through the network and is one more event per
 * call once the dedupe window passes — visible from the outside, not a no-op,
 * and it destroys nothing.
 */
const OUTBOUND: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

/**
 * Every advertised tool's hints. Exhaustive by construction: a tool missing from
 * this table is a bug the test suite catches, not a silently unannotated entry.
 */
const TOOL_ANNOTATIONS: Readonly<Record<string, ToolAnnotations>> = {
  // ---- Workspace reading -------------------------------------------------
  list_directory: READ,
  find_files: READ,
  search_files: READ,
  read_files: READ,
  get_file_info: READ,
  workspace_brief: READ,
  list_skills: READ,
  review_changes: READ,
  get_todos: READ,

  // ---- Workspace writing -------------------------------------------------
  // create/copy are additive but delete is not, so the family carries the
  // stronger hint: one conservative entry beats a per-action table nobody reads.
  file_op: MUTATING,
  // An overwrite can lose what was there; append mode cannot, but the tool
  // supports both, so the stronger case wins.
  write_file: MUTATING,
  edit_block: MUTATING,
  apply_patch: MUTATING,
  set_todos: MUTATING,
  report_progress: ADDITIVE,

  // ---- Command and process execution -------------------------------------
  run_command: MUTATING,
  // A script composes real tool calls, so it inherits the strongest thing any of them
  // can do: it runs arbitrary work. No hint here may pretend otherwise.
  run_script: MUTATING,
  start_process: PROCESS_CONTROL,
  interact_with_process: MUTATING,
  open_shell: PROCESS_CONTROL,
  send_to_shell: MUTATING,
  close_shell: PROCESS_CONTROL,
  process_control: PROCESS_CONTROL,
  set_process_policy: MUTATING,
  wait: READ,

  // ---- Process inspection ------------------------------------------------
  get_process_snapshot: READ,
  read_process_output: READ,

  // ---- Connectivity probes (these leave the machine) ----------------------
  connectivity: READ_NETWORK,

  // ---- Saved service orchestration ---------------------------------------
  save_service: MUTATING,
  // start/stop are process control, delete is destructive: the family takes the
  // stronger of what its actions can do.
  service: MUTATING,
  service_status: READ_NETWORK,
  read_service_log: READ,

  // ---- Phone notifications -------------------------------------------------
  notify: OUTBOUND,

  // ---- Bridge introspection ----------------------------------------------
  bridge_status: READ,
  get_config: READ,
  // recent/search only read; clear truncates the log, so the family says so.
  activity_log: MUTATING,
  get_usage_stats: READ,
  set_config_value: MUTATING,

  // ---- Batching ----------------------------------------------------------
  // A batch's effect is whatever its members do, so it inherits the weakest
  // guarantee: not read-only, possibly destructive, not idempotent.
  batch: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },

};

/** Hints for one tool, or `undefined` when it carries none. */
export function annotationsFor(name: string): ToolAnnotations | undefined {
  return TOOL_ANNOTATIONS[name];
}
