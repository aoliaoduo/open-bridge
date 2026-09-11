/**
 * Service log persistence helpers (P1-3).
 *
 * Logs live under the extension global storage — `service-logs/<wsHash8>/<name>.log` —
 * so they survive Bridge restarts and never dirty the workspace. A saved
 * service may override the location with an explicit `log_file` (resolved by
 * the caller via workspacePath). This module stays free of vscode/state
 * imports so the pure helpers remain unit-testable outside the extension host.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Service log files rotate to a single .1 generation at this size. */
export const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Replace every character outside [a-zA-Z0-9_-] with `_` (service log file names). */
export function sanitizeServiceLogName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Resolve the log file path for a service: an explicit `logFile` override
 * (resolved by the caller-supplied resolver, e.g. workspacePath) wins;
 * otherwise the default is <storageDir>/service-logs/<first 8 chars of
 * workspaceHash>/<sanitized name>.log.
 */
export function serviceLogFilePath(
  service: { name: string; logFile?: string },
  opts: { storageDir: string; workspaceHash: string; resolvePath: (input: string) => string },
): string {
  if (service.logFile) return opts.resolvePath(service.logFile);
  return path.join(
    opts.storageDir,
    "service-logs",
    opts.workspaceHash.slice(0, 8),
    `${sanitizeServiceLogName(service.name)}.log`,
  );
}

/**
 * Ensure the log's directory exists and rotate the live file to `.1` when it
 * reaches SERVICE_LOG_MAX_BYTES (one previous generation, mirroring the audit
 * log). A failed rename (the file held open on Windows) skips rotation so the
 * next append retries it — truncating there destroyed the un-rotated history.
 */
export async function prepareServiceLog(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const stat = await fs.stat(filePath);
    if (stat.size >= SERVICE_LOG_MAX_BYTES) {
      await fs.rename(filePath, `${filePath}.1`).catch(() => undefined);
    }
  } catch {
    // Missing log on first run is expected.
  }
}

export interface ServiceLogRead {
  offset: number;
  next_offset: number;
  output: string;
  output_bytes: number;
  truncated: boolean;
}

/**
 * Read a byte range of a log file. `offset === undefined` reads the trailing
 * `maxBytes` (aligned with read_process_output semantics); a missing file
 * reads as empty.
 */
export async function readServiceLogRange(filePath: string, offset: number | undefined, maxBytes: number): Promise<ServiceLogRead> {
  let size = 0;
  let start = 0;
  let data: Buffer = Buffer.alloc(0);
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      size = stat.size;
      start = offset === undefined ? Math.max(0, size - maxBytes) : Math.max(0, Math.min(offset, size));
      const length = Math.min(maxBytes, size - start);
      if (length > 0) {
        data = Buffer.alloc(length);
        await handle.read(data, 0, length, start);
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const end = start + data.length;
  return {
    offset: start,
    next_offset: end,
    output: data.toString("utf8"),
    output_bytes: size,
    truncated: start > 0 || end < size,
  };
}
