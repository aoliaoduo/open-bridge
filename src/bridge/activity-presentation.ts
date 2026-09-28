/**
 * Process-local presentation hints for the TUI activity feed.
 *
 * These hints deliberately never become part of Activity, audit.log or /api/activity:
 * they are display metadata, not audit facts. New calls derive them from structured
 * arguments before serialization; old rows still fall back to args_summary parsing.
 */

const HINT_CACHE_LIMIT = 256;
const hints = new Map<string, string>();

function textValue(value: unknown, redact: (text: string) => string): string | undefined {
  if (typeof value === "string") {
    const cleaned = redact(value).replace(/\s+/g, " ").trim();
    return cleaned || undefined;
  }
  return undefined;
}

function firstString(value: unknown, redact: (text: string) => string): string | undefined {
  if (typeof value === "string") return textValue(value, redact);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textValue(item, redact);
      if (text) return text;
    }
  }
  return undefined;
}

function scalarValue(value: unknown, redact: (text: string) => string): string | undefined {
  if (typeof value === "string") return textValue(value, redact);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function firstCommand(value: string): string {
  return (value.split(/\s+&&\s+/)[0] ?? value).trim();
}

export type ActivityHintFields = {
  command?: string;
  query?: string;
  path?: string;
  op?: string;
  action?: string;
  name?: string;
  group?: string;
  url?: string;
  port?: string;
  ms?: string;
  commandId?: string;
  key?: string;
  value?: string;
  message?: string;
  title?: string;
  pattern?: string;
  patchFile?: string;
  source?: string;
  destination?: string;
  mode?: string;
  section?: string;
  editsCount?: number;
  todosCount?: number;
  callsCount?: number;
};

/** One semantic formatter shared by live structured args and legacy summaries. */
export function formatActivityHint(tool: string, fields: ActivityHintFields): string {
  const {
    command, query, path, op, action, name, group, url, port, ms, commandId,
    key, value, message, title, pattern, patchFile, source, destination, mode,
    section, editsCount, todosCount, callsCount,
  } = fields;

  if (tool === "search_files" && (query || pattern)) return query ?? pattern ?? "";
  if (tool === "find_files" && pattern) return path ? `${pattern} (${path})` : pattern;
  if (tool === "list_directory") return path || ".";
  if (tool === "get_file_info" && path) return path;
  if (tool === "edit_block") {
    if (path && editsCount !== undefined) return `${path} (${editsCount} 处修改)`;
    if (path) return path;
  }
  if (tool === "file_op") {
    if ((op === "move" || op === "copy") && source && destination) return `${op} ${source} → ${destination}`;
    if (op && path) return `${op} ${path}`;
    if (op) return op;
  }
  if (tool === "service") {
    const target = name ?? (group ? `group:${group}` : undefined);
    if (action && target) return `${action} ${target}`;
    return action ?? target ?? "";
  }
  if (tool === "save_service" && name) return `保存服务 ${name}`;
  if (tool === "read_service_log" && name) return `服务日志 ${name}`;
  if (tool === "process_control") {
    if (action && commandId) return `${action} ${commandId.slice(0, 8)}`;
    if (action) return action;
  }
  if (tool === "read_process_output" && commandId) return `进程输出 ${commandId.slice(0, 8)}`;
  if (tool === "set_process_policy" && commandId) return `重启策略 ${commandId.slice(0, 8)}`;
  if (tool === "connectivity") {
    if (url) return url;
    if (port) return `port ${port}`;
  }
  if (tool === "send_to_shell") {
    if (name && command) return `[${name}] ${firstCommand(command)}`;
    if (command) return firstCommand(command);
  }
  if ((tool === "open_shell" || tool === "close_shell") && name) return name;
  if (tool === "wait") {
    if (ms) return `${ms}ms`;
    if (commandId) return `pid ${commandId.slice(0, 8)}`;
  }
  if (tool === "set_todos" && todosCount !== undefined) return `${todosCount} 项任务`;
  if (tool === "report_progress" && message) return message;
  if (tool === "batch" && callsCount !== undefined) return `${callsCount} calls${mode ? ` (${mode})` : ""}`;
  if (tool === "run_script") return source ? firstCommand(source) : "运行脚本";
  if (tool === "set_config_value") {
    if (key && value !== undefined) return `${key} = ${value}`;
    if (key) return key;
  }
  if (tool === "activity_log" && action) return action;
  if (tool === "bridge_status" && section) return section;
  if (tool === "apply_patch") return patchFile || "inline patch";
  if (tool === "notify") return message ?? title ?? "发送通知";

  if (command) return firstCommand(command);
  if (query) return query;
  if (path) return path;
  if (name) return name;
  return "";
}

export function buildActivityHint(
  tool: string,
  args: Record<string, unknown>,
  redact: (text: string) => string = text => text,
): string {
  const command = firstString(args.command ?? args.cmd, redact);
  const query = textValue(args.query, redact);
  const path = firstString(args.path ?? args.paths, redact);
  const op = textValue(args.op, redact);
  const action = textValue(args.action, redact);
  const name = textValue(args.name, redact);
  const group = textValue(args.group, redact);
  const url = textValue(args.url, redact);
  const port = scalarValue(args.port, redact);
  const ms = scalarValue(args.ms, redact);
  const commandId = scalarValue(args.command_id, redact);
  const key = textValue(args.key, redact);
  const value = scalarValue(args.value, redact);
  const message = textValue(args.message, redact);
  const title = textValue(args.title, redact);
  const pattern = textValue(args.pattern, redact);
  const patchFile = textValue(args.patch_file, redact);
  const source = textValue(args.source, redact);
  const destination = textValue(args.destination, redact);
  const mode = textValue(args.mode, redact);
  const section = textValue(args.section, redact);
  const editsCount = Array.isArray(args.edits) ? args.edits.length : undefined;
  const todosCount = Array.isArray(args.todos) ? args.todos.length : undefined;
  const callsCount = Array.isArray(args.calls) ? args.calls.length : undefined;

  return formatActivityHint(tool, {
    command, query, path, op, action, name, group, url, port, ms, commandId,
    key, value, message, title, pattern, patchFile, source, destination, mode,
    section, editsCount, todosCount, callsCount,
  });
}

export function rememberActivityHint(invocationId: string | undefined, hint: string): void {
  if (!invocationId || !hint) return;
  if (hints.has(invocationId)) hints.delete(invocationId);
  hints.set(invocationId, hint);
  while (hints.size > HINT_CACHE_LIMIT) {
    const oldest = hints.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    hints.delete(oldest);
  }
}

export function activityHint(invocationId: string | undefined): string | undefined {
  return invocationId ? hints.get(invocationId) : undefined;
}

export function clearActivityHints(): void {
  hints.clear();
}
