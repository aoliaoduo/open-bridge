/**
 * File-backed Host implementation for the standalone Node app.
 *
 * Layout under the data directory (default ~/.open-bridge, override with
 * OPEN_BRIDGE_HOME or --home):
 *
 *   config.json    user configuration (dotted keys, CONFIG_DEFAULTS defaults)
 *   state.json     persisted state (services / todos / usage counters)
 *   secrets.json   persisted workspace route tokens + hashed personal-token records (chmod 600)
 *   audit.log      append-only activity audit trail (rotates at 1 MiB)
 *   logs/          Bridge runtime log
 *   service-logs/  per-workspace saved-service logs (unless log_file overrides)
 *   bridge-peers.json shared-tunnel peer registry (same-machine instances)
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
  type Host, type UiChannel,
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
  } catch (error) {
    // A present-but-unparsable file must not silently become "no settings":
    // auth.enabled would flip back to false and, with a live tunnel, a
    // public-authed endpoint would degrade to public-open with no trace. The
    // log channel does not exist yet at first load (the log settings come
    // FROM this file), so the warning goes to stderr, where the console that
    // owns this process shows it.
    if (fs.existsSync(file)) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[WARN] ${file} could not be parsed (${message}); its settings are ignored and defaults apply. Fix or delete the file.`);
    }
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
 * Defensive copy for store reads and writes. Without it every `get` handed
 * out a live reference — into this.data for stored objects, or into the
 * caller's fallback (often CONFIG_DEFAULTS itself) — so one consumer's
 * push() quietly rewrote the store or the process-global defaults for
 * everyone else. Scalars pass through untouched.
 */
function cloneJson<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
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
    // Snapshot the caller's value: the persist below runs later (inside the
    // file lock), and without the copy a mutation between the call and the
    // write would change what reached the disk.
    const snapshot = cloneJson(value);
    this.data[key] = snapshot;
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
        [key]: snapshot,
      };
      const temp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      // Rename is atomic for a concurrent reader but means nothing to a crash:
      // without a sync the directory entry can survive while the data does not,
      // and the file comes back empty. These three files are config.json,
      // state.json and secrets.json, and an empty secrets.json is a route token
      // nobody can reproduce — the URL every client holds stops working and
      // nothing on screen says why. Best-effort on purpose: a filesystem that
      // cannot sync must not turn a correct write into a failed one.
      await fsp.open(temp, "r+")
        .then(async handle => {
          try { await handle.sync(); } catch { /* not syncable here: the rename still publishes */ }
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
    return cloneJson(coerce(this.data[key], base));
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.write(key, value);
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
    return raw === undefined || raw === null ? cloneJson(fallback) : cloneJson(raw as T);
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

/**
 * The Host contract's console push channel.
 *
 * Honest no-ops today: the web console discovers state by polling, so nothing
 * subscribes and these calls have no receiver. The seam stays in Host because
 * the core is full of call sites that say "the console should hear about
 * this" — a real push transport (SSE, websocket) plugs in here without any of
 * them changing. The old multi-subscriber fanout was deleted rather than
 * wired up: it scheduled microtasks to deliver into a subscriber set that was
 * permanently empty, so the machinery did observable work for nobody.
 */
class ConsolePushChannel implements UiChannel {
  update(): void {}
  refresh(): void {}
}

/** `logs/bridge.log` rotates to a single previous generation at this size. */
export const FILE_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Repair a `TZ` the runtime cannot resolve, so the process stops silently
 * running in UTC.
 *
 * Node resolves `TZ` through ICU, which only speaks IANA names. A POSIX-style
 * value — `CST-8`, the form glibc/Git Bash accept and the form people actually
 * have in their shell profile — is not an error there: ICU reports
 * `Etc/Unknown` and Node quietly runs the whole process in UTC. Nothing logs,
 * nothing throws, and every timestamp is simply hours off. That is how it was
 * found here: logs eight hours behind a correctly-configured UTC+8 machine.
 *
 * The POSIX offset sign is inverted relative to ISO (`CST-8` means UTC+8), and
 * `Etc/GMT-8` uses that very same inverted convention — so a whole-hour offset
 * carries straight across with its sign intact.
 *
 * Deliberately narrow. It only acts when the zone is already unresolvable (the
 * process is provably wrong, so there is nothing working to break), and only
 * for a bare abbreviation plus a whole-hour offset. Anything carrying a DST
 * rule is left alone: `Etc/GMT*` has no DST, so "fixing" it would trade an
 * obviously wrong clock for a subtly wrong one. `doctor` reports what is left.
 *
 * @returns the IANA zone adopted, or undefined if nothing was changed.
 */
export function normalizeTimezone(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const resolved = (): string => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
  };
  // "Unresolvable" has three shapes, and which one you get is platform ICU's
  // business, not ours. Windows answers "Etc/Unknown" for TZ=CST-8; Linux
  // answers "" (resolvedOptions().timeZone is undefined) for the same value.
  // Checking only for "Etc/Unknown" left the repair dead on Linux -- the very
  // platform CI runs -- which is how this stayed invisible until CI said so.
  const unresolvable = (zone: string): boolean => zone === "" || zone === "Etc/Unknown";
  if (!unresolvable(resolved())) return undefined;

  const raw = env.TZ;
  if (raw === undefined || raw === "") return undefined;
  // Abbreviation + whole-hour offset only: no DST field, no ":30" minutes.
  const match = /^[A-Za-z]{3,}([+-]?\d{1,2})$/.exec(raw.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  if (!Number.isInteger(hours) || Math.abs(hours) > 14) return undefined;

  // Etc/GMT0 exists but plain "Etc/GMT" is the conventional spelling for zero.
  const candidate = hours === 0 ? "Etc/GMT" : `Etc/GMT${hours < 0 ? "-" : "+"}${Math.abs(hours)}`;
  const previous = env.TZ;
  env.TZ = candidate;
  if (unresolvable(resolved())) {
    env.TZ = previous; // candidate was no better; leave the evidence intact for doctor
    return undefined;
  }
  return candidate;
}

/**
 * This machine's UTC offset, written the way a human expects: "+08:00".
 *
 * getTimezoneOffset() is minutes BEHIND UTC — UTC+8 reports -480 — so the sign
 * is inverted here rather than at each call site.
 *
 * Kept separate from the log stamp because the two have different readers.
 * `doctor` prints this to prove which zone the process actually resolved, and
 * there it is the whole point of the line. In a log file it was noise: every
 * line carried the same eleven characters, repeated thousands of times, on a
 * prefix whose job is to be skimmed.
 */
export function localUtcOffset(now: Date = new Date()): string {
  const pad = (value: number): string => String(Math.abs(value)).padStart(2, "0");
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  return `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
}

/**
 * Stamp a log line with LOCAL wall-clock time.
 *
 * `toISOString()` is always UTC, so an operator in UTC+8 read every console
 * line eight hours in the past and had to convert in their head to line a log
 * line up with what they had just done. This prefix is read by humans only:
 * nothing parses it back (the machine-readable timestamp is `audit.log`'s
 * `at` field, which stays ISO-8601 UTC precisely because `activity_log`'s
 * `since` filter parses it).
 *
 * No UTC offset: the reader of a bridge log is the person sitting at the
 * machine that wrote it, and their own offset is the one thing they never need
 * telling. Anyone reading the file elsewhere gets the zone from `doctor`, and
 * anything that needs an exact instant reads `audit.log` instead. Milliseconds
 * stay — ordering two events inside the same second is a real need.
 */
export function localLogStamp(now: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    + `.${pad(now.getMilliseconds(), 3)}`;
}

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
    const stamped = `[${localLogStamp()}] ${line}`;
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

export interface NodeHost extends Host {
  readonly config: FileConfig;
  /** Change the active project root at runtime (project switch). */
  setProjectRoot(root: string): void;
  configPath(): string;
  /** The bridge activity log (file + live line stream). */
  readonly bridgeLog: FileLog;
}

/**
 * Build and install the file-backed host, with a couple of Node-specific
 * helpers on top of the Host contract.
 */
export function installNodeHost(options: NodeHostOptions = {}): { host: NodeHost } {
  const home = ensureDir(path.resolve(options.homeDir ?? resolveDefaultHome()));
  const logsDir = ensureDir(path.join(home, "logs"));
  const config = new FileConfig(home);
  const state = new FileStateStore(home);
  const secrets = new FileSecretStore(home);
  const log = new FileLog(logsDir, {
    maxBytes: config.get("logMaxBytes", CONFIG_DEFAULTS.logMaxBytes as number),
  });
  const ui = new ConsolePushChannel();
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
    state,
    storageDir: () => home,
    version: () => version,
    bundledRipgrep: () => rg,
    projectRoot: () => projectRoot,
    notify: (level, message) => {
      log.write(`[${level.toUpperCase()}] ${message}`);
    },
    log: line => { log.write(line); },
    ui,
    setProjectRoot: (root: string) => {
      const resolved = path.resolve(root);
      if (resolved === projectRoot) return;
      projectRoot = resolved;
      log.write(`[INFO] Project root switched: ${resolved}`);
    },
    configPath: () => config.rawFile(),
    bridgeLog: log,
  };

  setHost(installed);
  return { host: installed };
}

/** The installed host, typed with its Node-specific helpers. Throws when not installed. */
export function nodeHost(): NodeHost {
  const current = active();
  if (!("setProjectRoot" in current)) {
    throw new Error("Expected the file-backed Node host to be installed.");
  }
  return current as NodeHost;
}


