/**
 * File-backed Host implementation for the standalone Node app.
 *
 * Layout under the data directory (default ~/.open-bridge, override with
 * OPEN_BRIDGE_HOME or --home):
 *
 *   config.json    user configuration (dotted keys, CONFIG_DEFAULTS defaults)
 *   state.json     persisted state (services / todos / usage counters)
 *   secrets.json   route token + hashed auth token records (chmod 600)
 *   audit.log      append-only activity audit trail (rotates at 1 MiB)
 *   logs/          per-run service and bridge logs
 *   peers.json     shared-tunnel peer registry (same-machine instances)
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFAULTS } from "../bridge/config-defaults.js";
import {
  host as active,
  setHost,
  type Host, type HostCapabilities, type UiChannel,
} from "./host.js";

/**
 * The version of this build, read from package.json - the only place it is
 * written. The old fallback was a second literal, so every bump left a stale
 * copy behind for anything that built the host without passing a version
 * (tests, embedders, a hand-made dist).
 */
function packageVersion(): string {
  try {
    // The same relative depth from src/ and from dist/, so it works either way.
    const manifest = fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(manifest) as { version: string }).version;
  } catch {
    // An unreadable manifest must never turn into a startup failure.
    return "0.0.0-unknown";
  }
}

export interface NodeHostOptions {
  /** Root data directory; defaults to $OPEN_BRIDGE_HOME or ~/.open-bridge. */
  homeDir?: string;
  /** Active project root; defaults to process.cwd() at server start. */
  projectRoot?: string;
  version?: string;
  ui?: UiChannel;
}

export function resolveDefaultHome(): string {
  const fromEnv = process.env.OPEN_BRIDGE_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".open-bridge");
}

/** Ensure a directory exists and return it. */
function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonSync(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Coerce a stored value against the declared default's type. */
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

/**
 * A JSON object store shared by every Bridge instance on this machine.
 *
 * One data dir is common to all instances, so a snapshot taken in the
 * constructor is not enough: another instance's keys must become visible without
 * a restart, and a write must never publish a map that predates theirs — that is
 * exactly how a second instance used to drop the first one's route token.
 *
 * Reads reload when the file changed under us; writes re-read, merge, then write
 * to a temp file and rename, so a reader (the CLI reads these files directly)
 * never observes a half-written file.
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

  /** Pick up another instance's writes; the disk wins per key. */
  protected reload(): void {
    const seen = this.mtimeMs();
    if (seen === 0 || seen <= this.loadedMtimeMs) return;
    const fresh = readJsonSync(this.file);
    if (fresh && typeof fresh === "object") this.data = { ...this.data, ...fresh };
    this.loadedMtimeMs = seen;
  }

  protected async write(key: string, value: unknown): Promise<void> {
    this.reload();
    this.data[key] = value;
    // Serialize on the tail but keep THIS caller's promise rejectable: the tail
    // itself swallows errors (so one failed write cannot poison later ones),
    // while the individual caller still learns its update did not land. The
    // old shape awaited the already-caught tail, so a write that silently gave
    // up reported success and the key quietly never reached the disk.
    const next = this.writeTail.then(() => this.withFileLock(async () => {
      // Re-read INSIDE the lock. Merging "just before writing" was not
      // enough: two instances starting together could each read the file
      // before the other's rename landed, and one key would be lost for
      // good. The lock is what makes read-merge-write actually atomic
      // across processes.
      const onDisk = readJsonSync(this.file);
      const merged = {
        ...(onDisk && typeof onDisk === "object" ? onDisk : {}),
        ...this.data,
        [key]: value,
      };
      const temp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      await fsp.rename(temp, this.file);
      this.data = merged;
      this.loadedMtimeMs = this.mtimeMs();
    }));
    this.writeTail = next.catch(() => undefined);
    await next;
  }

  /**
   * A cross-process mutex around writes to a shared file.
   *
   * open(path, "wx") is atomic on every platform this runs on, so the file's
   * own existence is the lock. A crashed writer must not wedge the data dir
   * forever, hence the staleness check; contention is a few milliseconds of
   * jittered backoff because writers here are short-lived.
   *
   * The lock file records WHO holds it, and only that holder may delete it.
   * Without an owner, a reclaimer that took over a stale lock could have its
   * own lock removed by the previous holder's `finally` — the one that stalled
   * (laptop resume, antivirus scan, debugger), resumed, and unconditionally
   * unlinked. A third writer was then free to hold the lock at the same time as
   * the second, both read-merge-wrote, and the later rename silently dropped the
   * other's key — which is the "a second instance ate the first's route token"
   * failure this class exists to prevent.
   */
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
        } catch { /* the lock vanished between EEXIST and stat: retry */ }
        await new Promise(resolve => setTimeout(resolve, 15 + Math.random() * 35));
        continue;
      }
      // Recorded while holding the lock, so a reclaimer that takes over from
      // here sees a different token and the original holder leaves it alone.
      await handle.writeFile(owner, "utf8").catch(() => undefined);
      try {
        return await body();
      } finally {
        await handle.close().catch(() => undefined);
        let currentOwner: string | undefined;
        try {
          currentOwner = await fsp.readFile(lock, "utf8");
        } catch { /* already reclaimed, or unreadable: never delete on a guess */ }
        if (currentOwner === owner) {
          await fsp.rm(lock, { force: true }).catch(() => undefined);
        }
      }
    }
    // Exhausting every attempt means the update did NOT land. Throwing (not
    // returning undefined) is what keeps this honest: a silently dropped
    // secrets/config write reported success and left the operator with a token
    // or setting that only existed in memory. The lock's staleness escape
    // makes a permanent wedge bounded, so this fires only under real contention.
    throw new Error(
      `${this.file} stayed locked by another process; the update was not saved. Retry once it frees up.`,
    );
  }
}

class FileConfig extends SharedJsonStore {
  constructor(home: string) {
    super(path.join(home, "config.json"));
  }

  get<T>(key: string, fallback: T): T {
    this.reload();
    const declared = (CONFIG_DEFAULTS as Record<string, unknown>)[key];
    const base = declared === undefined ? fallback : coerce(declared, fallback);
    return coerce(this.data[key], base);
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.write(key, value);
  }

  /** All effective values (config page rendering). */
  effective(): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const [key, declared] of Object.entries(CONFIG_DEFAULTS)) {
      merged[key] = this.get(key, declared);
    }
    return merged;
  }

  rawFile(): string {
    return this.file;
  }
}

class FileStateStore extends SharedJsonStore {
  constructor(home: string) {
    super(path.join(home, "state.json"));
  }

  get<T>(key: string, fallback: T): T {
    this.reload();
    const raw = this.data[key];
    return raw === undefined || raw === null ? fallback : (raw as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.write(key, value);
  }
}

class FileSecretStore extends SharedJsonStore {
  constructor(home: string) {
    super(path.join(home, "secrets.json"));
    this.restrictPermissions();
  }

  /** Best-effort 0600; POSIX honors chmod, Windows is a no-op. */
  private restrictPermissions(): void {
    try { fs.chmodSync(this.file, 0o600); } catch { /* best-effort */ }
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

class MultiSubscriberUi implements UiChannel {
  private readonly subscribers = new Set<UiChannel>();
  private pending: "update" | "refresh" | undefined;

  subscribe(channel: UiChannel): () => void {
    this.subscribers.add(channel);
    return () => { this.subscribers.delete(channel); };
  }

  update(): void {
    this.schedule("update");
  }

  refresh(): void {
    this.schedule("refresh");
  }

  /** Coalesce bursts: one notification per tick per kind (refresh wins). */
  private schedule(kind: "update" | "refresh"): void {
    if (this.pending === "refresh") return;
    this.pending = kind === "refresh" ? "refresh" : "update";
    queueMicrotask(() => {
      const deliver = this.pending;
      this.pending = undefined;
      if (!deliver) return;
      for (const channel of this.subscribers) {
        try { channel[deliver](); } catch { /* subscriber errors never propagate */ }
      }
    });
  }
}

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
    ensureDir(logsDir);
    this.file = path.join(logsDir, "bridge.log");
    const declared = options.maxBytes === undefined ? FILE_LOG_MAX_BYTES : options.maxBytes;
    this.maxBytes = Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : 0;
  }

  write(line: string): void {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    for (const listener of this.listeners) {
      try { listener(stamped); } catch { /* listeners never break logging */ }
    }
    this.tail = this.tail
      .then(() => this.append(stamped))
      .catch(() => undefined);
  }

  /**
   * Append one stamped line, rotating first when the file has reached the cap.
   *
   * One previous generation (`bridge.log.1`), the same shape audit.log and the
   * service logs use: unbounded growth was the last thing the data directory
   * had no answer for, and bridge.log carries every instance's service output.
   * Rotation is best-effort by construction — a second instance may hold the
   * file open on Windows, where the rename fails — so a failed rotate is
   * SKIPPED (the next append retries) rather than truncating the live file:
   * truncation here destroyed the very history the rename would have kept.
   */
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

  /** Resolves once every queued line has been written (tests, graceful shutdown). */
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

const NODE_CAPABILITIES: HostCapabilities = { lsp: false };

export interface NodeHost extends Host {
  readonly config: FileConfig;
  /** Change the active project root at runtime (project switch). */
  setProjectRoot(root: string): void;
  configPath(): string;
  statePath(): string;
  logsDir(): string;
  /** The bridge activity log (file + live line stream). */
  readonly bridgeLog: FileLog;
}

/**
 * Build and install the file-backed host. Returns the host (with a couple of
 * Node-specific helpers) plus the shared UI channel the API router uses.
 */
export function installNodeHost(options: NodeHostOptions = {}): { host: NodeHost; ui: MultiSubscriberUi } {
  const home = ensureDir(path.resolve(options.homeDir ?? resolveDefaultHome()));
  const logsDir = ensureDir(path.join(home, "logs"));
  const config = new FileConfig(home);
  const state = new FileStateStore(home);
  const secrets = new FileSecretStore(home);
  const log = new FileLog(logsDir, {
    maxBytes: config.get("logMaxBytes", CONFIG_DEFAULTS.logMaxBytes as number),
  });
  const ui = new MultiSubscriberUi();
  // package.json is the only place a version is written. This fallback used to
  // be a second literal, so every bump left a stale copy behind for whoever
  // built the host without passing one (tests, embedders, a hand-made dist).
  const version = options.version ?? packageVersion();

  let projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // dist/host/node-host.js -> <package root>/vendor/rg[.exe] (dev: src/host -> ../vendor).
  // The binary shipped in the npm tarball is Windows-only; on other platforms a
  // packager may drop a native `rg` in the same folder. When neither exists the
  // search tool falls back to PATH's rg, then to its built-in scanner.
  const rgName = process.platform === "win32" ? "rg.exe" : "rg";
  const rgCandidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../vendor",
    rgName,
  );
  const rg = fs.existsSync(rgCandidate) ? rgCandidate : undefined;

  const installed: NodeHost = {
    config,
    secrets,
    globalState: state,
    storageDir: () => home,
    version: () => version,
    bundledRipgrep: () => rg,
    projectRoot: () => projectRoot,
    notify: (level, message) => {
      log.write(`[${level.toUpperCase()}] ${message}`);
    },
    log: line => { log.write(line); },
    ui,
    capabilities: NODE_CAPABILITIES,
    setProjectRoot: (root: string) => {
      const resolved = path.resolve(root);
      if (resolved === projectRoot) return;
      projectRoot = resolved;
      log.write(`[INFO] Project root switched: ${resolved}`);
    },
    configPath: () => config.rawFile(),
    statePath: () => path.join(home, "state.json"),
    logsDir: () => logsDir,
    bridgeLog: log,
  };

  setHost(installed);
  return { host: installed, ui };
}

/** The installed host, typed with its Node-specific helpers. Throws when not installed. */
export function nodeHost(): NodeHost {
  const current = active();
  if (!("setProjectRoot" in current)) {
    throw new Error("Expected the file-backed Node host to be installed.");
  }
  return current as NodeHost;
}


