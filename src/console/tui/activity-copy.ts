/**
 * Operator-facing activity copy for the TUI.
 *
 * The audit log keeps the raw protocol and process lines. The dashboard only
 * answers "what is this MCP call doing?" — no session hashes, no HTTP traces,
 * no JSON argument dumps.
 */

import { FAILURE_LINE_PATTERN } from "../../bridge/failure-line.js";
import {
  activityHintFromFields,
  transportToolHint,
  type ActivityHint,
  type ActivitySubjectKind,
} from "../../bridge/activity-presentation.js";

export type ActivityLike = {
  tool: string;
  status: string;
  message: string;
  args_summary?: string;
  /** Process-local TUI hint; never part of the public Activity/audit contract. */
  operator_hint?: ActivityHint;
};

export type ActivityPresentation = {
  action: string;
  subject: string;
  qualifier?: string;
  subjectKind: ActivitySubjectKind;
  qualifierKind?: ActivitySubjectKind;
  failure?: string;
  durationMs?: number;
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

const ACTION_LABELS: Record<string, string> = {
  workspace_brief: "项目", review_changes: "审查", get_todos: "任务", set_todos: "任务",
  report_progress: "进度", list_skills: "技能", get_config: "配置", set_config_value: "配置",
  get_usage_stats: "统计", get_process_snapshot: "进程", read_process_output: "输出",
  process_control: "进程", set_process_policy: "策略", service_status: "服务", service: "服务",
  save_service: "服务", read_service_log: "日志", list_directory: "目录", read_files: "读取",
  write_file: "写入", get_file_info: "信息", search_files: "搜索", find_files: "查找",
  edit_block: "修改", apply_patch: "补丁", run_command: "命令", start_process: "进程",
  run_script: "脚本", batch: "批量", connectivity: "网络", open_shell: "Shell",
  send_to_shell: "Shell", close_shell: "Shell", wait: "等待", notify: "通知",
  activity_log: "活动", bridge_status: "状态", mcp: "MCP", process: "进程", bridge: "Bridge",
};

const DEFAULT_SUBJECTS: Record<string, string> = {
  workspace_brief: "项目概况",
  review_changes: "代码变更",
  get_todos: "任务清单",
  list_skills: "可用技能",
  get_config: "系统配置",
  get_usage_stats: "统计信息",
  get_process_snapshot: "进程快照",
  service_status: "服务状态",
  list_directory: ".",
};



function full(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripCwd(value: string): string {
  return value.replace(/\s*\(cwd:\s*.+\)$/i, "").trim();
}

function firstCommand(value: string): string {
  return (value.split(/\s+&&\s+/)[0] ?? value).trim();
}

function actionFor(tool: string, hint?: ActivityHint): string {
  return hint?.action ?? ACTION_LABELS[tool] ?? tool;
}

function failureReason(entry: ActivityLike, raw: string): string | undefined {
  if (entry.status !== "error" && entry.status !== "warning") return undefined;
  if (FAILURE_LINE_PATTERN.test(raw)) return full(raw.replace(FAILURE_LINE_PATTERN, ""));
  if (BOILER_REQUEST.test(raw) || BOILER_DONE.test(raw) || raw === "") return undefined;
  return raw;
}

const MCP_METHOD_LABELS: Record<string, string> = {
  initialize: "初始化",
  "server/discover": "服务发现",
  "tools/list": "工具列表",
  "tools/call": "工具调用",
  ping: "Ping",
  "notifications/initialized": "初始化通知",
  other: "其他请求",
};

export type McpTransportInfo = {
  method: string;
  toolName?: string;
  httpStatus?: number;
  durationMs?: number;
  formatLabel?: string;
  aborted: boolean;
  failure?: string;
};

export function tuiMcpTransportInfo(entry: ActivityLike): McpTransportInfo | undefined {
  if (entry.tool !== "mcp") return undefined;
  const raw = full(entry.message);
  const parts = raw.split(" · ").map(part => part.trim()).filter(Boolean);
  const route = /^([^/]+)\/(.+)$/.exec(parts[0] ?? "");
  if (!route) return undefined;
  const method = route[2] ?? "other";
  const httpPart = parts.find(part => /^HTTP \d{3}$/.test(part));
  const httpStatus = httpPart ? Number.parseInt(httpPart.slice(5), 10) : undefined;
  const durationPart = parts.find(part => /^\d+(?:\.\d+)?ms$/.test(part));
  const durationMs = durationPart ? Number.parseFloat(durationPart.slice(0, -2)) : undefined;
  const format = parts.find(part => part === "json" || part === "sse" || part === "no-body");
  const formatLabel = format === "json" ? "JSON" : format === "sse" ? "SSE" : format === "no-body" ? "无正文" : undefined;
  const toolHashPart = parts.find(part => part.startsWith("tool "));
  const toolName = method === "tools/call"
    ? transportToolHint(toolHashPart?.slice("tool ".length).trim())
    : undefined;
  const aborted = parts.includes("client-aborted");
  const failure = aborted ? "客户端中断"
    : httpStatus !== undefined && httpStatus >= 400 ? `HTTP ${httpStatus}`
    : entry.status === "warning" ? "传输警告"
    : entry.status === "error" ? "传输失败"
    : undefined;
  return {
    method,
    ...(toolName ? { toolName } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(formatLabel ? { formatLabel } : {}),
    aborted,
    ...(failure ? { failure } : {}),
  };
}

function mcpPresentation(entry: ActivityLike, _raw: string): ActivityPresentation | undefined {
  const info = tuiMcpTransportInfo(entry);
  if (!info) return undefined;
  const qualifier = [
    info.httpStatus !== undefined ? `HTTP ${info.httpStatus}` : undefined,
    info.formatLabel,
  ].filter(Boolean).join(" · ") || undefined;
  return {
    action: "MCP",
    subject: info.toolName ?? MCP_METHOD_LABELS[info.method] ?? info.method,
    ...(qualifier ? { qualifier } : {}),
    subjectKind: "generic",
    ...(info.failure ? { failure: info.failure } : {}),
    ...(info.durationMs !== undefined ? { durationMs: info.durationMs } : {}),
  };
}

function fromHint(tool: string, hint: ActivityHint, failure?: string): ActivityPresentation {
  return {
    action: actionFor(tool, hint),
    subject: full(hint.subject),
    ...(hint.qualifier ? { qualifier: full(hint.qualifier) } : {}),
    subjectKind: hint.subjectKind,
    ...(hint.qualifierKind ? { qualifierKind: hint.qualifierKind } : {}),
    ...(failure ? { failure } : {}),
  };
}

/** Semantic headline model; width policy belongs only to renderer.ts. */
export function tuiActivityPresentation(entry: ActivityLike): ActivityPresentation {
  const raw = full(entry.message);
  if (entry.tool === "mcp") {
    const parsed = mcpPresentation(entry, raw);
    if (parsed) return parsed;
  }
  const failure = failureReason(entry, raw);

  if (entry.tool === "process") {
    const started = PROCESS_STARTED.exec(raw);
    const subject = started ? full(firstCommand(stripCwd(started[2] ?? ""))) : full(stripCwd(raw));
    return { action: "进程", subject, subjectKind: "command", ...(failure ? { failure } : {}) };
  }
  if (BRIDGE_STARTED.test(raw)) {
    return { action: "Bridge", subject: "已启动", subjectKind: "generic", ...(failure ? { failure } : {}) };
  }

  const hint = entry.operator_hint ?? hintFromSummary(entry.args_summary, entry.tool);
  if (hint) return fromHint(entry.tool, hint, failure);

  const requestCommand = REQUEST_COMMAND.exec(raw);
  if (requestCommand) {
    return {
      action: actionFor(entry.tool),
      subject: full(firstCommand(requestCommand[1] ?? "")),
      subjectKind: "command",
      ...(failure ? { failure } : {}),
    };
  }

  const fallback = DEFAULT_SUBJECTS[entry.tool];
  if (fallback && (BOILER_REQUEST.test(raw) || BOILER_DONE.test(raw) || raw === "")) {
    return {
      action: actionFor(entry.tool),
      subject: fallback,
      subjectKind: entry.tool === "list_directory" ? "path" : "generic",
      ...(failure ? { failure } : {}),
    };
  }

  if (failure) return { action: actionFor(entry.tool), subject: "", subjectKind: "generic", failure };
  if (BOILER_REQUEST.test(raw) || BOILER_DONE.test(raw)) return { action: actionFor(entry.tool), subject: "", subjectKind: "generic" };
  if (raw.startsWith("{") && raw.includes(":")) return { action: actionFor(entry.tool), subject: "", subjectKind: "generic" };
  return { action: actionFor(entry.tool), subject: raw, subjectKind: "message" };
}

function combinedHeadline(presentation: ActivityPresentation): string {
  const main = [presentation.subject, presentation.qualifier].filter(Boolean).join(" · ");
  if (!presentation.failure) return main;
  return main ? `${main} · ${presentation.failure}` : presentation.failure;
}

/** Enter detail: headline first, then the redacted audit args and full failure reason. */
export function tuiActivityDetail(entry: ActivityLike): string {
  const presentation = tuiActivityPresentation(entry);
  const main = [presentation.subject, presentation.qualifier].filter(Boolean).join(" · ");
  const parts: string[] = [];
  if (main) parts.push(main);
  if (entry.args_summary) parts.push(`参数 ${entry.args_summary}`);
  if (entry.tool === "mcp" && entry.message && entry.message !== main) parts.push(`传输 ${full(entry.message)}`);
  if (presentation.failure) parts.push(presentation.failure);
  return parts.join("\n\n");
}

/** Uncapped one-line headline. Final clipping belongs exclusively to renderer.ts. */
export function tuiActivityMessage(entry: ActivityLike): string {
  return full(combinedHeadline(tuiActivityPresentation(entry)));
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

function hintFromSummary(summary: string | undefined, tool: string): ActivityHint | undefined {
  if (!summary) return undefined;
  return activityHintFromFields(tool, {
    command: quotedField(summary, "command") ?? quotedField(summary, "cmd"),
    query: quotedField(summary, "query"),
    path: quotedField(summary, "path") ?? quotedField(summary, "paths"),
    op: quotedField(summary, "op"),
    action: quotedField(summary, "action"),
    name: quotedField(summary, "name"),
    group: quotedField(summary, "group"),
    url: quotedField(summary, "url"),
    port: unquotedField(summary, "port"),
    ms: unquotedField(summary, "ms"),
    commandId: quotedField(summary, "command_id") ?? unquotedField(summary, "command_id"),
    key: quotedField(summary, "key"),
    value: quotedField(summary, "value") ?? unquotedField(summary, "value"),
    message: quotedField(summary, "message"),
    title: quotedField(summary, "title"),
    pattern: quotedField(summary, "pattern"),
    patchFile: quotedField(summary, "patch_file"),
    source: quotedField(summary, "source"),
    destination: quotedField(summary, "destination"),
    todosCount: arrayCount(summary, "todos"),
    callsCount: arrayCount(summary, "calls"),
    mode: quotedField(summary, "mode"),
    section: quotedField(summary, "section"),
    startLine: unquotedField(summary, "start_line"),
    endLine: unquotedField(summary, "end_line"),
    editsCount: arrayCount(summary, "edits"),
  });
}
