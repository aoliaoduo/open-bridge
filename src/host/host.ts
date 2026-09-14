/**
 * Host abstraction — the single seam between the core Bridge and its host.
 *
 * What the core may depend on is *this interface*, never a concrete host:
 * `node-host.ts` is imported by `src/cli.ts` (which installs the host) and by
 * `src/server/api-router.ts`, and by nothing else in `src/bridge`, `src/http`,
 * `src/mcp`, … That is the checkable rule — it is NOT a ban on Node built-ins:
 * plenty of core modules use `node:fs` or `node:child_process` directly, and
 * that is correct (a file tool that could not touch the filesystem would be
 * pointless). Configuration/secret/state *file paths*, however, must come from
 * `config` / `secrets` / `state` / `storageDir()`, not from a hardcoded path.
 * Everything the host provides — configuration, secret storage, persisted
 * state, notifications, the UI push channel — flows through this interface,
 * injected once at startup via `setHost`. The standalone app wires a
 * file-backed NodeHost; a future desktop shell (Tauri/Electron) can wire its
 * own implementation without touching core.
 */

export type NotifyLevel = "info" | "warn" | "error";

/** Dotted-key configuration source (keys like "auth.enabled", "port"). */
export interface ConfigSource {
  get<T>(key: string, fallback: T): T;
  /** Persist one configuration key; must not throw on success. */
  update(key: string, value: unknown): Promise<void>;
}

/** Secret storage: values must never be readable in plaintext at rest. */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
}

/**
 * Synchronous-read key/value state. Reads come
 * from an in-memory cache hydrated at startup; writes are serialized to disk.
 */
export interface StateStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): Promise<void>;
}

/** Push channel for the web console: coarse-grained UI invalidation. */
export interface UiChannel {
  /** High-frequency incremental invalidation (tool events, session counts). */
  update(): void;
  /** Full structural re-render (Bridge start/stop, service add/remove). */
  refresh(): void;
}

export interface Host {
  readonly config: ConfigSource;
  readonly secrets: SecretStore;
  readonly state: StateStore;
  /** Persistent data directory (audit log, peers registry, service logs). */
  storageDir(): string;
  /** Server version reported in MCP handshake metadata. */
  version(): string;
  /** Path to a bundled ripgrep executable, when the host ships one. */
  bundledRipgrep(): string | undefined;
  /** The active project root anchor for relative paths and command cwd. */
  projectRoot(): string;
  notify(level: NotifyLevel, message: string): void;
  /** Append one line to the activity log surface. */
  log(line: string): void;
  readonly ui: UiChannel;
}

let active: Host | undefined;

export function setHost(next: Host): void {
  active = next;
}

/** The injected host; throws early with a clear message when missing. */
export function host(): Host {
  if (!active) {
    throw new Error(
      "Host services are not initialized. Call setHost(...) at startup before using the Bridge core.",
    );
  }
  return active;
}


