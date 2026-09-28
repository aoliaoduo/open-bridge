/**
 * Process-local presentation hints for the TUI activity feed.
 *
 * These hints deliberately never become part of Activity, audit.log or /api/activity:
 * they are display metadata, not audit facts. New calls derive them from structured
 * arguments before serialization; old rows still fall back to args_summary parsing.
 */

const HINT_CACHE_LIMIT = 256;

export type ActivitySubjectKind = "command" | "path" | "query" | "message" | "generic";

export type ActivityHint = {
  action?: string;
  subject: string;
  qualifier?: string;
  subjectKind: ActivitySubjectKind;
  qualifierKind?: ActivitySubjectKind;
};

const hints = new Map<string, ActivityHint>();

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

function lineRange(startLine?: string, endLine?: string): string | undefined {
  if (!startLine && !endLine) return undefined;
  if (startLine && endLine) return startLine === endLine ? startLine : `${startLine}–${endLine}`;
  return startLine ?? endLine;
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
  startLine?: string;
  endLine?: string;
  editsCount?: number;
  todosCount?: number;
  callsCount?: number;
};

/** One semantic formatter shared by live structured args and legacy summaries. */
export function activityHintFromFields(tool: string, fields: ActivityHintFields): ActivityHint | undefined {
  const {
    command, query, path, op, action, name, group, url, port, ms, commandId,
    key, value, message, title, pattern, patchFile, source, destination, mode,
    section, startLine, endLine, editsCount, todosCount, callsCount,
  } = fields;

  if (tool === "run_command" && command) {
    return { action: "命令", subject: firstCommand(command), subjectKind: "command" };
  }
  if (tool === "search_files" && (query || pattern)) {
    return {
      action: "搜索",
      subject: query ?? pattern ?? "",
      ...(path ? { qualifier: path, qualifierKind: "path" as const } : {}),
      subjectKind: "query",
    };
  }
  if (tool === "find_files" && pattern) {
    return {
      action: "查找",
      subject: pattern,
      ...(path ? { qualifier: path, qualifierKind: "path" as const } : {}),
      subjectKind: "query",
    };
  }
  if (tool === "read_files" && path) {
    const range = lineRange(startLine, endLine);
    return {
      action: "读取",
      subject: path,
      ...(range ? { qualifier: range } : {}),
      subjectKind: "path",
    };
  }
  if (tool === "write_file" && path) return { action: "写入", subject: path, subjectKind: "path" };
  if (tool === "list_directory") return { action: "目录", subject: path || ".", subjectKind: "path" };
  if (tool === "get_file_info" && path) return { action: "信息", subject: path, subjectKind: "path" };
  if (tool === "edit_block" && path) {
    return {
      action: "修改",
      subject: path,
      ...(editsCount !== undefined ? { qualifier: `${editsCount} 处修改` } : {}),
      subjectKind: "path",
    };
  }
  if (tool === "file_op") {
    if ((op === "move" || op === "copy") && source && destination) {
      return {
        action: op === "move" ? "移动" : "复制",
        subject: source,
        qualifier: destination,
        subjectKind: "path",
        qualifierKind: "path",
      };
    }
    if (op && path) {
      const label = op === "delete" ? "删除" : op === "mkdir" ? "建目录" : "文件";
      return { action: label, subject: path, subjectKind: "path" };
    }
    if (op) return { action: "文件", subject: op, subjectKind: "generic" };
  }
  if (tool === "service") {
    const target = name ?? (group ? `group:${group}` : undefined);
    if (target) return { action: "服务", subject: target, ...(action ? { qualifier: action } : {}), subjectKind: "generic" };
    if (action) return { action: "服务", subject: action, subjectKind: "generic" };
  }
  if (tool === "save_service" && name) return { action: "服务", subject: name, qualifier: "保存", subjectKind: "generic" };
  if (tool === "read_service_log" && name) return { action: "日志", subject: name, subjectKind: "generic" };
  if (tool === "process_control") {
    const subject = commandId ? commandId.slice(0, 8) : action;
    if (subject) return { action: "进程", subject, ...(action && commandId ? { qualifier: action } : {}), subjectKind: "generic" };
  }
  if (tool === "read_process_output" && commandId) return { action: "输出", subject: commandId.slice(0, 8), subjectKind: "generic" };
  if (tool === "set_process_policy" && commandId) return { action: "策略", subject: commandId.slice(0, 8), subjectKind: "generic" };
  if (tool === "connectivity") {
    if (url) return { action: "网络", subject: url, subjectKind: "generic" };
    if (port) return { action: "网络", subject: `port ${port}`, subjectKind: "generic" };
  }
  if (tool === "send_to_shell" && command) {
    return {
      action: "Shell",
      subject: firstCommand(command),
      ...(name ? { qualifier: name } : {}),
      subjectKind: "command",
    };
  }
  if ((tool === "open_shell" || tool === "close_shell") && name) {
    return { action: "Shell", subject: name, qualifier: tool === "open_shell" ? "打开" : "关闭", subjectKind: "generic" };
  }
  if (tool === "wait") {
    if (ms) return { action: "等待", subject: `${ms}ms`, subjectKind: "generic" };
    if (commandId) return { action: "等待", subject: commandId.slice(0, 8), qualifier: "进程", subjectKind: "generic" };
  }
  if (tool === "set_todos" && todosCount !== undefined) return { action: "任务", subject: `${todosCount} 项`, qualifier: "更新", subjectKind: "generic" };
  if (tool === "report_progress" && message) return { action: "进度", subject: message, subjectKind: "message" };
  if (tool === "batch" && callsCount !== undefined) {
    return {
      action: mode === "parallel" ? "并行" : "批量",
      subject: `${callsCount} 项`,
      ...(mode && mode !== "parallel" ? { qualifier: mode } : {}),
      subjectKind: "generic",
    };
  }
  if (tool === "run_script") return { action: "脚本", subject: source ? firstCommand(source) : "运行脚本", subjectKind: "command" };
  if (tool === "set_config_value") {
    if (key) return { action: "配置", subject: key, ...(value !== undefined ? { qualifier: value } : {}), subjectKind: "generic" };
  }
  if (tool === "activity_log" && action) return { action: "活动", subject: action, subjectKind: "generic" };
  if (tool === "bridge_status" && section) {
    const label = ({ overview: "概览", auth: "认证", locks: "锁", sessions: "会话" } as Record<string, string>)[section] ?? section;
    return { action: "状态", subject: label, subjectKind: "generic" };
  }
  if (tool === "apply_patch") return { action: "补丁", subject: patchFile || "inline patch", subjectKind: patchFile ? "path" : "generic" };
  if (tool === "notify") return { action: "通知", subject: message ?? title ?? "发送通知", subjectKind: "message" };

  if (command) return { subject: firstCommand(command), subjectKind: "command" };
  if (query) return { subject: query, subjectKind: "query" };
  if (path) return { subject: path, subjectKind: "path" };
  if (name) return { subject: name, subjectKind: "generic" };
  return undefined;
}

export function buildActivityPresentationHint(
  tool: string,
  args: Record<string, unknown>,
  redact: (text: string) => string = text => text,
): ActivityHint | undefined {
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
  const startLine = scalarValue(args.start_line, redact);
  const endLine = scalarValue(args.end_line, redact);
  const editsCount = Array.isArray(args.edits) ? args.edits.length : undefined;
  const todosCount = Array.isArray(args.todos) ? args.todos.length : undefined;
  const callsCount = Array.isArray(args.calls) ? args.calls.length : undefined;

  return activityHintFromFields(tool, {
    command, query, path, op, action, name, group, url, port, ms, commandId,
    key, value, message, title, pattern, patchFile, source, destination, mode,
    section, startLine, endLine, editsCount, todosCount, callsCount,
  });
}

export function rememberActivityHint(invocationId: string | undefined, hint: ActivityHint | undefined): void {
  if (!invocationId || !hint?.subject) return;
  if (hints.has(invocationId)) hints.delete(invocationId);
  hints.set(invocationId, { ...hint });
  while (hints.size > HINT_CACHE_LIMIT) {
    const oldest = hints.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    hints.delete(oldest);
  }
}

export function activityHint(invocationId: string | undefined): ActivityHint | undefined {
  const hint = invocationId ? hints.get(invocationId) : undefined;
  return hint ? { ...hint } : undefined;
}

export function clearActivityHints(): void {
  hints.clear();
}
