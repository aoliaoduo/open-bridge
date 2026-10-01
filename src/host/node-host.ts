/**
 * File-backed Host composition root for the standalone Node app.
 *
 * Persistence mechanics, logging and timezone policy live in focused sibling
 * modules; this file decides how those infrastructure adapters form one Host.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DEFAULTS } from "../bridge/config/config-defaults.js";
import { FileLog } from "./file-log.js";
import { FileConfig, FileSecretStore, FileStateStore } from "./file-store.js";
import {
  host as active,
  setHost,
  type Host,
  type UiChannel,
} from "./host.js";

export { FileLog, FILE_LOG_MAX_BYTES } from "./file-log.js";
export { FileConfig, FileSecretStore, FileStateStore } from "./file-store.js";
export { localLogStamp, localUtcOffset, normalizeTimezone } from "./timezone.js";

function packageVersion(): string {
  try {
    const manifest = fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(manifest) as { version: string }).version;
  } catch {
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

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The web console currently polls, so these are intentionally no-op invalidation
 * hooks. Keeping the Host port means a future push transport does not leak into
 * bridge domain modules.
 */
class ConsolePushChannel implements UiChannel {
  update(): void {}
  refresh(): void {}
}

export interface NodeHost extends Host {
  readonly config: FileConfig;
  /** Change the active project root at runtime (project switch). */
  setProjectRoot(root: string): void;
  configPath(): string;
  /** The bridge activity log (file + live line stream). */
  readonly bridgeLog: FileLog;
}

/** Build and install the standalone Node host. */
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
  const version = options.version ?? packageVersion();

  let projectRoot = path.resolve(options.projectRoot ?? process.cwd());

  // dist/host/node-host.js -> <package root>/vendor/rg[.exe].
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

/** The installed host, typed with its Node-specific helpers. */
export function nodeHost(): NodeHost {
  const current = active();
  if (!("setProjectRoot" in current)) {
    throw new Error("Expected the file-backed Node host to be installed.");
  }
  return current as NodeHost;
}
