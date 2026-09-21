/**
 * Operator-facing activity copy for the TUI.
 *
 * The audit log keeps the raw protocol and process lines. The dashboard only
 * answers "what is this MCP call doing?" — no session hashes, no HTTP traces,
 * no JSON argument dumps.
 */

import { visualWidth } from "./text.js";

export type ActivityLike = {
  tool: string;
  status: string;
  message: string;
  args_summary?: string;
};

const PROCESS_STARTED = /^Started [0-9a-f]+:\s*(.+)$/i;
const BOILER_REQUEST = /^Request received\.?$/i;
const BOILER_DONE = /^Completed in \d+ ms\.?$/i;
const BOILER_FAIL = /^Failed in \d+ ms:\s*(.*)$/i;
const REQUEST_COMMAND = /^Request received · command:\s*(.+?)(?:\s·\s+cwd:.*)?$/i;
const BRIDGE_STARTED = /^Started:\s*https?:\/\//i;

const MESSAGE_CAP = 56;

/** Transport / process lifecycle rows stay in the log, not on the dashboard. */
export function tuiActivityVisible(entry: ActivityLike): boolean {
  if (entry.tool === "mcp" || entry.tool === "process") return false;
  return true;
}

export function tuiActivityMessage(entry: ActivityLike): string {
  const raw = entry.message.replace(/\s+/g, " ").trim();

  if (entry.tool === "process") {
    const started = PROCESS_STARTED.exec(raw);
    if (started) return clip(firstCommand(stripCwd(started[1] ?? "")));
    return clip(stripCwd(raw));
  }

  if (BRIDGE_STARTED.test(raw)) return "Started";

  const fromArgs = hintFromSummary(entry.args_summary, entry.tool);
  if (fromArgs) return clip(fromArgs);

  const requestCommand = REQUEST_COMMAND.exec(raw);
  if (requestCommand) return clip(firstCommand(requestCommand[1] ?? ""));

  if (BOILER_REQUEST.test(raw) || BOILER_DONE.test(raw)) return "";

  const failed = BOILER_FAIL.exec(raw);
  if (failed) return clip(failed[1] ?? "");

  if (raw.startsWith("{") && raw.includes(":")) return "";
  return clip(raw);
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
  const url = quotedField(summary, "url");
  const port = unquotedField(summary, "port");
  const ms = unquotedField(summary, "ms");
  const cmdId = quotedField(summary, "command_id") ?? unquotedField(summary, "command_id");
  const key = quotedField(summary, "key");
  const value = quotedField(summary, "value") ?? unquotedField(summary, "value");
  const message = quotedField(summary, "message");
  const pattern = quotedField(summary, "pattern");
  const patchFile = quotedField(summary, "patch_file");
  const source = quotedField(summary, "source");
  const destination = quotedField(summary, "destination");
  const todosCount = arrayCount(summary, "todos");
  const callsCount = arrayCount(summary, "calls");
  const mode = quotedField(summary, "mode");
  const section = quotedField(summary, "section");

  if (tool === "search_files" && query) return query;
  if (tool === "find_files" && pattern) return path ? `${pattern} (${path})` : pattern;
  if (tool === "file_op") {
    if ((op === "move" || op === "copy") && source && destination) {
      return `${op} ${source} → ${destination}`;
    }
    if (op && path) return `${op} ${path}`;
    if (op) return op;
  }
  if (tool === "service") {
    const target = name ?? (quotedField(summary, "group") ? `group:${quotedField(summary, "group")}` : undefined);
    if (action && target) return `${action} ${target}`;
    if (action) return action;
    if (target) return target;
  }
  if (tool === "process_control") {
    if (action && cmdId) return `${action} ${cmdId.slice(0, 8)}`;
    if (action) return action;
  }
  if (tool === "connectivity") {
    if (url) return url;
    if (port) return `port ${port}`;
  }
  if (tool === "send_to_shell") {
    if (name && command) return `[${name}] ${firstCommand(command)}`;
    if (command) return firstCommand(command);
  }
  if (tool === "open_shell" || tool === "close_shell") {
    if (name) return name;
  }
  if (tool === "wait") {
    if (ms) return `${ms}ms`;
    if (cmdId) return `pid ${cmdId.slice(0, 8)}`;
  }
  if (tool === "set_todos") {
    if (todosCount !== undefined) return `${todosCount} 项任务`;
  }
  if (tool === "report_progress") {
    if (message) return message;
  }
  if (tool === "batch") {
    if (callsCount !== undefined) return `${callsCount} calls${mode ? ` (${mode})` : ""}`;
  }
  if (tool === "set_config_value") {
    if (key && value !== undefined) return `${key} = ${value}`;
    if (key) return key;
  }
  if (tool === "activity_log" && action) return action;
  if (tool === "bridge_status" && section) return section;
  if (tool === "apply_patch") {
    if (patchFile) return patchFile;
    return "inline patch";
  }

  if (command) return firstCommand(command);
  if (query) return query;
  if (path) return path;
  if (name) return name;
  return "";
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
