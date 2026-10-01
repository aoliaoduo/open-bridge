import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { host } from "../host/host.js";
import type { Activity } from "./activity-model.js";
import { redactSensitiveText } from "./endpoint.js";
import { state, type SessionState } from "./runtime-state.js";

/** audit.log rotates to audit.log.1 independently of bridge.log. */
export const MAX_AUDIT_LOG_BYTES = 1024 * 1024;

export function auditLogPath(): string | undefined {
  const dir = host().storageDir();
  if (!dir) return undefined;
  return path.join(dir, "audit.log");
}

async function appendAuditEntry(entry: Omit<Activity, "at"> & { at: string }): Promise<void> {
  const logPath = auditLogPath();
  if (!logPath) return;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  try {
    const stat = await fs.stat(logPath);
    if (stat.size >= MAX_AUDIT_LOG_BYTES) {
      await fs.rename(logPath, `${logPath}.1`).catch(() => undefined);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`);
}

export function createActivityId(): string {
  return randomUUID();
}

export function record(
  tool: string,
  status: Activity["status"],
  message: string,
  argsSummary?: string,
  details?: { changes?: Activity["changes"]; invocationId?: string },
): void {
  const entry = {
    id: createActivityId(),
    ...(details?.invocationId ? { invocation_id: details.invocationId } : {}),
    at: new Date().toISOString(),
    tool,
    status,
    message: redactSensitiveText(message).slice(0, 500),
    ...(argsSummary !== undefined ? { args_summary: argsSummary } : {}),
    ...(details?.changes?.length ? { changes: details.changes } : {}),
  };
  state.activity.unshift({ ...entry, ts: Date.now() });
  state.activity.splice(200);
  try { host().log(`[${tool}] ${status}: ${entry.message}`); } catch { /* observer only */ }
  try { host().ui.update(); } catch { /* observer only */ }
  void appendAuditEntry(entry).catch(() => undefined);
}

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency";

export function notifyLogging(session: SessionState | undefined, level: LogLevel, message: string): void {
  const server = session?.mcp;
  if (!server) return;
  try {
    const params = { level, data: redactSensitiveText(message).slice(0, 2000), logger: "open-bridge" };
    void Promise.resolve(server.notification({ method: "notifications/message", params })).catch(() => undefined);
  } catch {
    /* advisory only */
  }
}

export function notifyLatestLogging(level: LogLevel, message: string): void {
  notifyLogging(state.latestSession, level, message);
}
