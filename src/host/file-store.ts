import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_DEFAULTS } from "../bridge/config/config-defaults.js";
import type { ConfigSource, SecretStore, StateStore } from "./host.js";

function readJsonSync(file: string): Record<string, unknown> {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch (error) {
    if (fs.existsSync(file)) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WARN] ${file} could not be parsed (${message}); its settings are ignored and defaults apply. Fix or delete the file.`);
    }
    return {};
  }
}

function coerce<T>(raw: unknown, fallback: T): T {
  if (raw === undefined || raw === null) return fallback;
  switch (typeof fallback) {
    case "boolean": return (typeof raw === "boolean" ? raw : fallback) as T;
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? (n as T) : fallback;
    }
    case "string": return (typeof raw === "string" ? raw : fallback) as T;
    case "object":
      if (Array.isArray(fallback)) return (Array.isArray(raw) ? raw : fallback) as T;
      return fallback;
    default: return fallback;
  }
}

function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

/**
 * Cross-process JSON object store.
 *
 * Reads notice other Bridge instances' committed writes. Writes serialize both
 * in-process and across processes, then perform read-merge-rename while holding
 * an ownership-token lock so stale-lock recovery cannot delete a new owner's lock.
 */
class SharedJsonStore {
  protected data: Record<string, unknown> = {};
  private writeTail: Promise<void> = Promise.resolve();
  private loadedMtimeMs = 0;

  constructor(protected readonly file: string) {
    this.data = readJsonSync(file);
    this.loadedMtimeMs = this.mtimeMs();
  }

  private mtimeMs(): number {
    try { return fs.statSync(this.file).mtimeMs; } catch { return 0; }
  }

  protected reload(): void {
    const seen = this.mtimeMs();
    if (seen === 0 || seen <= this.loadedMtimeMs) return;
    const fresh = readJsonSync(this.file);
    this.data = { ...this.data, ...fresh };
    this.loadedMtimeMs = seen;
  }

  protected async write(key: string, value: unknown): Promise<void> {
    this.reload();
    const snapshot = cloneJson(value);
    const previousValue = this.data[key];
    const hadKey = Object.prototype.hasOwnProperty.call(this.data, key);
    this.data[key] = snapshot;
    try {
      await this.persistLocked(key, snapshot);
    } catch (error) {
      if (hadKey) this.data[key] = previousValue;
      else delete this.data[key];
      throw error;
    }
  }

  private async persistLocked(key: string, snapshot: unknown): Promise<void> {
    const next = this.writeTail.then(() => this.withFileLock(async () => {
      const onDisk = readJsonSync(this.file);
      const merged = {
        ...this.data,
        ...onDisk,
        [key]: snapshot,
      };
      const temp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      await fsp.open(temp, "r+")
        .then(async handle => {
          try { await handle.sync(); } catch { /* best effort */ }
          await handle.close();
        })
        .catch(() => undefined);
      await fsp.rename(temp, this.file);
      this.data = merged;
      this.loadedMtimeMs = this.mtimeMs();
    }));
    this.writeTail = next.catch(() => undefined);
    await next;
  }

  private async withFileLock<T>(body: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.lock`;
    const owner = randomBytes(16).toString("hex");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      let handle: Awaited<ReturnType<typeof fsp.open>>;
      try {
        handle = await fsp.open(lock, "wx");
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        try {
          const stat = await fsp.stat(lock);
          if (Date.now() - stat.mtimeMs > 5_000) {
            await fsp.rm(lock, { force: true }).catch(() => undefined);
            continue;
          }
        } catch { /* lock vanished; retry */ }
        await new Promise(resolve => setTimeout(resolve, 15 + Math.random() * 35));
        continue;
      }

      await handle.writeFile(owner, "utf8").catch(() => undefined);
      try {
        return await body();
      } finally {
        await handle.close().catch(() => undefined);
        let currentOwner: string | undefined;
        try {
          currentOwner = await fsp.readFile(lock, "utf8");
        } catch { /* reclaimed/unreadable: never delete on a guess */ }
        if (currentOwner === owner) {
          await fsp.rm(lock, { force: true }).catch(() => undefined);
        }
      }
    }
    throw new Error(
      `${this.file} stayed locked by another process; the update was not saved. Retry once it frees up.`,
    );
  }
}

export class FileConfig extends SharedJsonStore implements ConfigSource {
  constructor(home: string) {
    super(path.join(home, "config.json"));
  }

  get<T>(key: string, fallback: T): T {
    this.reload();
    const declared = (CONFIG_DEFAULTS as Record<string, unknown>)[key];
    const base = declared === undefined ? fallback : coerce(declared, fallback);
    return cloneJson(coerce(this.data[key], base));
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.write(key, value);
  }

  rawFile(): string {
    return this.file;
  }
}

export class FileStateStore extends SharedJsonStore implements StateStore {
  constructor(home: string) {
    super(path.join(home, "state.json"));
  }

  get<T>(key: string, fallback: T): T {
    this.reload();
    const raw = this.data[key];
    return raw === undefined || raw === null ? cloneJson(fallback) : cloneJson(raw as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.write(key, value);
  }
}

export class FileSecretStore extends SharedJsonStore implements SecretStore {
  constructor(home: string) {
    super(path.join(home, "secrets.json"));
    this.restrictPermissions();
  }

  private restrictPermissions(): void {
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort */ }
  }

  async get(key: string): Promise<string | undefined> {
    this.reload();
    const value = this.data[key];
    return typeof value === "string" ? value : undefined;
  }

  async store(key: string, value: string): Promise<void> {
    await this.write(key, value);
    this.restrictPermissions();
  }
}
