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
import { fileURLToPath } from "node:url";
import { CONFIG_DEFAULTS } from "../bridge/config-defaults.js";
import {
  host as active,
  setHost,
  type Host, type HostCapabilities, type UiChannel,
} from "./host.js";

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

class FileConfig {
  private readonly file: string;
  private data: Record<string, unknown>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.file = path.join(home, "config.json");
    this.data = readJsonSync(this.file);
  }

  get<T>(key: string, fallback: T): T {
    const declared = (CONFIG_DEFAULTS as Record<string, unknown>)[key];
    const base = declared === undefined ? fallback : coerce(declared, fallback);
    return coerce(this.data[key], base);
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
    const snapshot = { ...this.data };
    this.writeTail = this.writeTail
      .then(() => fsp.writeFile(this.file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"))
      .catch(() => undefined);
    await this.writeTail;
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

class FileStateStore {
  private readonly file: string;
  private data: Record<string, unknown>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.file = path.join(home, "state.json");
    this.data = readJsonSync(this.file);
  }

  get<T>(key: string, fallback: T): T {
    const raw = this.data[key];
    return raw === undefined || raw === null ? fallback : (raw as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data[key] = value;
    const snapshot = { ...this.data };
    this.writeTail = this.writeTail
      .then(() => fsp.writeFile(this.file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"))
      .catch(() => undefined);
    await this.writeTail;
  }
}

class FileSecretStore {
  private readonly file: string;
  private data: Record<string, string>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(home: string) {
    this.file = path.join(home, "secrets.json");
    this.data = readJsonSync(this.file) as Record<string, string>;
    this.restrictPermissions();
  }

  /** Best-effort 0600; POSIX honors chmod, Windows is a no-op. */
  private restrictPermissions(): void {
    try { fs.chmodSync(this.file, 0o600); } catch { /* best-effort */ }
  }

  async get(key: string): Promise<string | undefined> {
    return this.data[key];
  }

  async store(key: string, value: string): Promise<void> {
    this.data[key] = value;
    const snapshot = { ...this.data };
    this.writeTail = this.writeTail
      .then(async () => {
        await fsp.writeFile(this.file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        this.restrictPermissions();
      })
      .catch(() => undefined);
    await this.writeTail;
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

export class FileLog {
  private readonly file: string;
  private tail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(line: string) => void>();

  constructor(logsDir: string) {
    ensureDir(logsDir);
    this.file = path.join(logsDir, "bridge.log");
  }

  write(line: string): void {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    for (const listener of this.listeners) {
      try { listener(stamped); } catch { /* listeners never break logging */ }
    }
    this.tail = this.tail
      .then(() => fsp.appendFile(this.file, `${stamped}\n`, "utf8"))
      .catch(() => undefined);
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
  const log = new FileLog(logsDir);
  const ui = new MultiSubscriberUi();
  const version = options.version ?? "1.0.0-alpha.1";

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

  const nodeHost: NodeHost = {
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

  setHost(nodeHost);
  return { host: nodeHost, ui };
}

/** The installed host, typed with its Node-specific helpers. Throws when not installed. */
export function nodeHost(): NodeHost {
  const current = active();
  if (!("setProjectRoot" in current)) {
    throw new Error("Expected the file-backed Node host to be installed.");
  }
  return current as NodeHost;
}


