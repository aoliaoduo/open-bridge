import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { localLogStamp } from "./timezone.js";

/** `logs/bridge.log` rotates to a single previous generation at this size. */
export const FILE_LOG_MAX_BYTES = 10 * 1024 * 1024;

export interface FileLogOptions {
  /** Rotate once the live file has reached this many bytes (0 disables rotation). */
  maxBytes?: number;
}

export class FileLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(line: string) => void>();

  constructor(logsDir: string, options: FileLogOptions = {}) {
    fs.mkdirSync(logsDir, { recursive: true });
    this.file = path.join(logsDir, "bridge.log");
    const declared = options.maxBytes === undefined ? FILE_LOG_MAX_BYTES : options.maxBytes;
    this.maxBytes = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : 0;
  }

  write(line: string): void {
    const stamped = `[${localLogStamp()}] ${line}`;
    for (const listener of this.listeners) {
      try { listener(stamped); } catch { /* listeners never break logging */ }
    }
    this.tail = this.tail
      .then(() => this.append(stamped))
      .catch(() => undefined);
  }

  private async append(stamped: string): Promise<void> {
    if (this.maxBytes > 0) {
      try {
        const stat = await fsp.stat(this.file);
        if (stat.size >= this.maxBytes) {
          await fsp.rename(this.file, `${this.file}.1`).catch(() => undefined);
        }
      } catch { /* missing on first run is expected */ }
    }
    await fsp.appendFile(this.file, `${stamped}\n`, "utf8");
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  path(): string {
    return this.file;
  }
}
