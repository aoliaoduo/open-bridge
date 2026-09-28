/**
 * Operator-facing activity copy for the TUI.
 *
 * The audit log keeps the raw protocol and process lines. The dashboard only
 * answers "what is this MCP call doing?" — no session hashes, no HTTP traces,
 * no JSON argument dumps.
 */

import { FAILURE_LINE_PATTERN } from "../../bridge/failure-line.js";
import { formatActivityHint } from "../../bridge/activity-presentation.js";
import { visualWidth } from "./text.js";

export type ActivityLike = {
  tool: string;
  status: string;
  message: string;
  args_summary?: string;
  /** Process-local TUI hint; never part of the public Activity/audit contract. */
  operator_hint?: string;
};

/**
 * The one writer of this line is processes.ts — `Started <id>: <command>
 * (cwd: <cwd>)`, where the id is randomBytes(8).toString("hex"): 16 lowercase
 * hex digits, always followed by a command and the cwd suffix. Snapshot reads
 * the id out of group 1; the copy below reads the command out of group 2. The
 * two sites used to carry separately tuned regexes; with a single writer,
 * one pattern serves both.
 */
export const PROCESS_STARTED = /^Started ([0-9a-f]+):\s*(.+)$/i;
const BOILER_REQUEST = /^Request received\.?$/i;
const BOILER_DONE = /^Completed in \d+ ms\.?$/i;
const REQUEST_COMMAND = /^Request received · command:\s*(.+?)(?:\s·\s+cwd:.*)?$/i;
const BRIDGE_STARTED = /^Started:\s*https?:\/\//i;

const MESSAGE_CAP = 56;

const TOOL_LABELS: Record<string, string> = {
  workspace_brief: "项目概况",
  review_changes: "审查代码变更",
  get_todos: "读取任务清单",
  list_skills: "可用技能清单",
  get_config: "读取系统配置",
  get_usage_stats: "读取统计信息",
  get_process_snapshot: "进程快照",
  service_status: "服务状态",
  list_directory: "列出目录",
};



function full(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The uncapped operator line — the copy the row shows, without the 56-column
 *  ceiling. Rows keep the cap; the Enter detail page renders this. */
export function tuiActivityDetail(entry: ActivityLike): string {
  const raw = full(entry.message);

  if (entry.tool === "process") {
    const started = PROCESS_STARTED.exec(raw);
    if (started) return full(firstCommand(stripCwd(started[2] ?? "")));
    return full(stripCwd(raw));
  }

  if (BRIDGE_STARTED.test(raw)) return "Started";

  if (entry.operator_hint) return full(entry.operator_hint);

  const fromArgs = hintFromSummary(entry.args_summary, entry.tool);
  if (fromArgs) return full(fromArgs);

  const requestCommand = REQUEST_COMMAND.exec(raw);
  if (requestCommand) return full(firstCommand(requestCommand[1] ?? ""));

  if (TOOL_LABELS[entry.tool]) {
    if (BOILER_REQUEST.test(raw) || BOILER_DONE.test(raw) || raw === "") {
      return TOOL_LABELS[entry.tool]!;
    }
  }

  if (BOILER_REQUEST.test(raw) || BOILER_DONE.test(raw)) return "";

  // Same envelope the dispatcher writes (failure-line.ts): detect the prefix,
  // then the rest of the line is the reason.
  if (FAILURE_LINE_PATTERN.test(raw)) return full(raw.replace(FAILURE_LINE_PATTERN, ""));

  if (raw.startsWith("{") && raw.includes(":")) return "";
  return full(raw);
}

export function tuiActivityMessage(entry: ActivityLike): string {
  return clip(tuiActivityDetail(entry));
}

function stripCwd(value: string): string {
  return value.replace(/\s*\(cwd:\s*.+\)$/i, "").trim();
}

function firstCommand(value: string): string {
  return (value.split(/\s+&&\s+/)[0] ?? value).trim();
}

/**
 * `buildArgsSummary` emits `{command:"git …", timeout_ms:15000}` — not
 * `command: git …`. Pull the operator-facing field and drop the rest.
 */
function quotedField(summary: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = new RegExp(`(?:^|[{\\,])\\s*${escaped}:\\s*"((?:\\\\.|[^"\\\\])*)"`, "i").exec(summary);
  if (quoted?.[1] !== undefined) return quoted[1].replace(/\\"/g, '"');
  const array = new RegExp(`(?:^|[{\\,])\\s*${escaped}:\\s*\\[\\s*"((?:\\\\.|[^"\\\\])*)"`, "i").exec(summary);
  if (array?.[1] !== undefined) return array[1].replace(/\\"/g, '"');
  return undefined;
}

function unquotedField(summary: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[{\\,])\\s*${escaped}:\\s*([a-zA-Z0-9_.:/-]+)`, "i").exec(summary);
  return m?.[1];
}

function arrayCount(summary: string, key: string): number | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[{\\,])\\s*${escaped}:\\s*\\[(\\d+)\\s+items\\]`, "i").exec(summary);
  if (m?.[1]) return parseInt(m[1], 10);
  const mBracket = new RegExp(`(?:^|[{\\,])\\s*${escaped}:\\s*\\[(.*?)\\]`, "i").exec(summary);
  if (mBracket?.[1] !== undefined) {
    const inner = mBracket[1].trim();
    if (!inner) return 0;
    return inner.split(",").length;
  }
  return undefined;
}

function hintFromSummary(summary: string | undefined, tool: string): string {
  if (!summary) return "";
  const command = quotedField(summary, "command") ?? quotedField(summary, "cmd");
  const query = quotedField(summary, "query");
  const path = quotedField(summary, "path") ?? quotedField(summary, "paths");
  const op = quotedField(summary, "op");
  const action = quotedField(summary, "action");
  const name = quotedField(summary, "name");
  const group = quotedField(summary, "group");
  const url = quotedField(summary, "url");
  const port = unquotedField(summary, "port");
  const ms = unquotedField(summary, "ms");
  const cmdId = quotedField(summary, "command_id") ?? unquotedField(summary, "command_id");
  const key = quotedField(summary, "key");
  const value = quotedField(summary, "value") ?? unquotedField(summary, "value");
  const message = quotedField(summary, "message");
  const title = quotedField(summary, "title");
  const pattern = quotedField(summary, "pattern");
  const patchFile = quotedField(summary, "patch_file");
  const source = quotedField(summary, "source");
  const destination = quotedField(summary, "destination");
  const todosCount = arrayCount(summary, "todos");
  const callsCount = arrayCount(summary, "calls");
  const mode = quotedField(summary, "mode");
  const section = quotedField(summary, "section");

  const editsCount = arrayCount(summary, "edits");

  return formatActivityHint(tool, {
    command, query, path, op, action, name, group, url, port, ms,
    commandId: cmdId, key, value, message, title, pattern, patchFile, source,
    destination, mode, section, editsCount, todosCount, callsCount,
  });
}

function clip(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (visualWidth(text) <= MESSAGE_CAP) return text;
  let used = 0;
  let cut = 0;
  let lastBreak = 0;
  for (const ch of text) {
    const w = visualWidth(ch);
    if (used + w > MESSAGE_CAP - 1) break;
    used += w;
    cut += ch.length;
    if (/[\s/\\]/.test(ch)) lastBreak = cut;
  }
  const keep = lastBreak > MESSAGE_CAP / 3 ? lastBreak : cut;
  return `${text.slice(0, keep).trimEnd()}…`;
}
