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

function hintFromSummary(summary: string | undefined, tool: string): string {
  if (!summary) return "";
  const command = quotedField(summary, "command") ?? quotedField(summary, "cmd");
  const query = quotedField(summary, "query");
  const path = quotedField(summary, "path") ?? quotedField(summary, "paths");
  if (tool === "search_files" && query) return query;
  if (command) return firstCommand(command);
  if (query) return query;
  if (path) return path;
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
