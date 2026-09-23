/**
 * The canonical shape of a tool call.
 *
 * The catalog used to carry one tool per verb: six service verbs, four file
 * verbs, four introspection readers, three log readers, two probes. That is a
 * lot of near-identical descriptions for a model to tell apart, so the families
 * are now grouped behind an action parameter — `service{action}`, `file_op{op}`,
 * `process_control{action}`, `bridge_status{section}`, `activity_log{action}`,
 * `connectivity{target}`, plus `wait` covering both sleeping and waiting for a
 * process. The capability behind them is unchanged; only the vocabulary is
 * smaller and more distinct.
 *
 * Names that were advertised before keep working. `start_service`,
 * `force_terminate`, `check_http`, `list_sessions` and the rest are rewritten
 * here into the call the catalog advertises today. Three rules make that safe:
 *
 *  - **One rewrite, one place.** A legacy name maps to exactly one canonical
 *    call, so the rest of the server (handler table, lock planner, annotations,
 *    usage) only ever sees canonical names and cannot drift out of sync with a
 *    second copy of the old vocabulary.
 *  - **Rewrites re-label, they do not drop.** Every field a caller sent is moved
 *    to its canonical name (`name` stays `name`, `command_id` stays
 *    `command_id`); nothing is invented and nothing is discarded.
 *  - **The rewrite is recorded.** `normalizeToolCall` reports which legacy name
 *    was used and what it became, so the dispatcher can say so in the result and
 *    in the audit log instead of silently accepting a name the catalog no longer
 *    offers.
 *
 * Pure by construction: same input, same output, no host access — which is why
 * it can run on every invocation and be tested exhaustively.
 */

import { TOOL_DEFINITIONS } from "../../mcp/tool-definitions.js";

/** A tool call after normalization: an advertised name plus its own vocabulary. */
export interface CanonicalCall {
  /** The name the catalog advertises (a family name for merged tools). */
  tool: string;
  /** Arguments in that tool's vocabulary. */
  args: Record<string, unknown>;
  /** Present only when the caller used a name the catalog no longer advertises. */
  /**
   * `ignored` names the arguments the rewrite could not honour: ones it does not
   * forward at all, and ones whose value the family's discriminator overwrites.
   * The call still does the right thing — that part is by design — but a caller
   * that passed `section: "sessions"` to `get_bridge_status` asked a question and
   * got the overview, and it deserves to be told rather than left to diff.
   */
  alias?: {
    used: string;
    replaced_by: string;
    call: string;
    ignored?: Record<string, { sent: unknown; used?: unknown }>;
  };
}

type Args = Record<string, unknown>;

/**
 * The discriminator each family uses, and the values it accepts. Kept here (not
 * in the handlers) so the vocabulary has one definition that the dispatcher
 * validates against, the tests assert against, and the documentation quotes.
 */
export const FAMILY_PARAMS = {
  service: "action",
  file_op: "op",
  process_control: "action",
  bridge_status: "section",
  activity_log: "action",
  connectivity: "target",
  service_status: "detail",
} as const;

/** Family -> the values its discriminator accepts. */
export const FAMILY_ACTIONS = {
  service: ["start", "stop", "restart", "delete", "start_all", "stop_all"],
  file_op: ["create_directory", "copy", "move", "delete"],
  process_control: ["restart", "terminate"],
  bridge_status: ["overview", "auth", "locks", "sessions"],
  activity_log: ["recent", "search", "clear"],
  connectivity: ["port", "http"],
  service_status: ["live", "definitions"],
} as const;

/**
 * The boolean-typed input arguments of every advertised tool, read from the
 * catalog rather than kept as a second hand-written list: a schema change cannot
 * leave the normalization behind.
 */
const BOOLEAN_ARGS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (TOOL_DEFINITIONS as ReadonlyArray<{
    name: string;
    inputSchema?: { properties?: Record<string, { type?: unknown }> };
  }>).map(definition => [
    definition.name,
    new Set(
      Object.entries(definition.inputSchema?.properties ?? {})
        .filter(([, schema]) => schema?.type === "boolean")
        .map(([key]) => key),
    ),
  ]),
);

/**
 * Read a declared boolean that arrived in another encoding.
 *
 * Schemas say `type: "boolean"`, but clients (and models) encode booleans as
 * strings often enough to matter: `open_shell{list:"false"}` took the truthy
 * branch and listed shells instead of opening one, while
 * `file_op{overwrite:"false"}` was already read strictly. Normalizing at the one
 * entry point keeps every handler's `=== true` check honest instead of asking
 * each of them to re-implement the coercion. Anything that is not
 * true/false/1/0 — "nope", 2, an object — is passed through untouched, so the
 * handler still sees, and reports, a value it cannot read.
 */
function normalizeBooleanArgs(tool: string, args: Args): Args {
  const declared = BOOLEAN_ARGS.get(tool);
  if (!declared || declared.size === 0) return args;
  let out: Args | undefined;
  for (const key of declared) {
    const value = args[key];
    const normalized = value === "true" || value === "1" || value === 1
      ? true
      : value === "false" || value === "0" || value === 0
        ? false
        : undefined;
    if (normalized === undefined || normalized === value) continue;
    out ??= { ...args };
    out[key] = normalized;
  }
  return out ?? args;
}

/** The arguments that select a family's behaviour, in a stable order. */
const DISCRIMINATORS: readonly string[] = [...new Set(Object.values(FAMILY_PARAMS))];

/** How a canonical call is written in a hint: `service{action:"start"}`. */
function describeCanonicalCall(tool: string, args: Args): string {
  for (const key of DISCRIMINATORS) {
    const value = args[key];
    if (typeof value === "string" && value) return `${tool}{${key}:"${value}"}`;
  }
  return tool;
}

/** Copy the named arguments that are actually present (`undefined` is absence). */
export function pick(args: Args, keys: readonly string[]): Args {
  const out: Args = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

/** Re-labeller for one legacy name. */
interface LegacyRewrite {
  /** The advertised tool that replaced this name. */
  tool: string;
  /** The legacy arguments, expressed in that tool's vocabulary. */
  map(args: Args): Args;
}

/**
 * Every name that used to be advertised, and the call it means today.
 *
 * Order inside each rewrite is `...pick(...)` first and the discriminator last,
 * so a caller cannot smuggle a different action through a legacy name.
 */
export const LEGACY_REWRITES: Readonly<Record<string, LegacyRewrite>> = {
  // ---- service: six verbs -> service{action} ------------------------------
  start_service: { tool: "service", map: args => ({ ...pick(args, ["name"]), action: "start" }) },
  stop_service: { tool: "service", map: args => ({ ...pick(args, ["name"]), action: "stop" }) },
  restart_service: { tool: "service", map: args => ({ ...pick(args, ["name"]), action: "restart" }) },
  delete_service: { tool: "service", map: args => ({ ...pick(args, ["name"]), action: "delete" }) },
  start_all_services: { tool: "service", map: args => ({ ...pick(args, ["group", "parallel"]), action: "start_all" }) },
  stop_all_services: { tool: "service", map: args => ({ ...pick(args, ["group"]), action: "stop_all" }) },
  // Listing definitions is the no-probe half of service_status, expressed as
  // `detail` rather than as a separate tool.
  list_services: { tool: "service_status", map: () => ({ detail: "definitions" }) },

  // ---- file system: four verbs -> file_op{op} -----------------------------
  create_directory: { tool: "file_op", map: args => ({ ...pick(args, ["path"]), op: "create_directory" }) },
  copy_file: { tool: "file_op", map: args => ({ ...pick(args, ["source", "destination", "overwrite"]), op: "copy" }) },
  move_file: { tool: "file_op", map: args => ({ ...pick(args, ["source", "destination", "overwrite"]), op: "move" }) },
  delete_file: { tool: "file_op", map: args => ({ ...pick(args, ["path", "recursive"]), op: "delete" }) },

  // ---- supervised processes: two verbs -> process_control{action} ---------
  restart_process: { tool: "process_control", map: args => ({ ...pick(args, ["command_id", "delay_ms"]), action: "restart" }) },
  force_terminate: { tool: "process_control", map: args => ({ ...pick(args, ["command_id"]), action: "terminate" }) },
  // Waiting for a process is the `command_id` half of wait.
  wait_process: { tool: "wait", map: args => pick(args, ["command_id", "timeout_ms"]) },

  // ---- bridge introspection: four readers -> bridge_status{section} -------
  get_bridge_status: { tool: "bridge_status", map: () => ({ section: "overview" }) },
  get_auth_status: { tool: "bridge_status", map: () => ({ section: "auth" }) },
  get_lock_status: { tool: "bridge_status", map: () => ({ section: "locks" }) },
  list_sessions: { tool: "bridge_status", map: () => ({ section: "sessions" }) },

  // ---- audit log: three readers -> activity_log{action} -------------------
  get_recent_activity: { tool: "activity_log", map: args => ({ ...pick(args, ["max_results"]), action: "recent" }) },
  search_activity_log: {
    tool: "activity_log",
    map: args => ({ ...pick(args, ["tool", "status", "query", "since", "limit", "offset"]), action: "search" }),
  },
  clear_activity_log: { tool: "activity_log", map: () => ({ action: "clear" }) },

  // ---- reachability probes: two verbs -> connectivity{target} -------------
  check_port: { tool: "connectivity", map: args => ({ ...pick(args, ["host", "port", "timeout_ms", "scope"]), target: "port" }) },
  check_http: {
    tool: "connectivity",
    map: args => ({ ...pick(args, ["url", "timeout_ms", "max_redirects", "scope"]), target: "http" }),
  },

  // ---- shells: listing folded into the tool that owns them ----------------
  list_shells: { tool: "open_shell", map: () => ({ list: true }) },
};

/** Legacy names in a stable order (docs and tests read this, not the table). */
export function legacyToolNames(): string[] {
  return Object.keys(LEGACY_REWRITES);
}

/**
 * The canonical call for one invocation. A name that is neither advertised nor
 * a known legacy name is returned untouched, so the dispatcher's "unknown tool"
 * error and its did-you-mean hint stay exactly as they were.
 */
export function normalizeToolCall(name: string, args: Args = {}): CanonicalCall {
  const rewrite = LEGACY_REWRITES[name];
  if (!rewrite) return { tool: name, args: normalizeBooleanArgs(name, args) };
  const mapped = rewrite.map(args);
  const ignored = ignoredArguments(args, mapped);
  const canonical = normalizeBooleanArgs(rewrite.tool, mapped);
  return {
    tool: rewrite.tool,
    args: canonical,
    alias: {
      used: name,
      replaced_by: rewrite.tool,
      call: describeCanonicalCall(rewrite.tool, canonical),
      ...(ignored ? { ignored } : {}),
    },
  };
}

/**
 * What the caller sent that the rewrite could not honour.
 *
 * Compared against the mapped arguments *before* boolean normalization, because
 * the question is "did the rewrite keep what I sent", not "did it parse it the
 * way I meant". A key that is absent from the mapped call was dropped; a key
 * whose mapped value is a different primitive was overwritten by the rewrite's
 * own discriminator (`get_bridge_status{section:"sessions"}` becomes
 * `bridge_status{section:"overview"}`: the legacy name means the overview, and
 * the caller's value is what gets lost).
 *
 * Absent when nothing was lost, so the common case pays nothing and callers can
 * check one optional field instead of an always-present empty object.
 */
function ignoredArguments(args: Args, mapped: Args): Record<string, { sent: unknown; used?: unknown }> | undefined {
  const ignored: Record<string, { sent: unknown; used?: unknown }> = {};
  for (const [key, sent] of Object.entries(args)) {
    if (!(key in mapped)) {
      ignored[key] = { sent };
      continue;
    }
    const used = mapped[key];
    if (typeof used !== "object" && used !== sent) ignored[key] = { sent, used };
  }
  return Object.keys(ignored).length ? ignored : undefined;
}
