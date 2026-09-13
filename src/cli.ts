/**
 * open-bridge CLI — the standalone host entry.
 *
 * Commands:
 *   serve     start the Bridge (HTTP + MCP + console), stays in the foreground
 *   stop      stop a running instance (via its local shutdown endpoint)
 *   status    show the running instance's state
 *   url       print the active MCP URL
 *   instances every live instance sharing this data dir (one per directory)
 *   logs      read / follow / clear the instance log
 *   health    live check: listener, tunnel, exposure, tool count
 *   prompt    the ready-made "connect your AI to me" message
 *   config    list / get / set / path configuration
 *   token     create / list / revoke / delete / rotate auth tokens
 *   doctor    environment diagnostics
 *   version / help
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { request as httpRequest } from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { createRequire } from "node:module";
import { installNodeHost, resolveDefaultHome } from "./host/node-host.js";
import { CONFIG_DEFAULTS } from "./bridge/config-defaults.js";
import { state } from "./bridge/state.js";
import { currentWorkspaceRoot, workspaceSuffixFor } from "./bridge/paths.js";
import { loadServices } from "./bridge/services.js";
import { loadUsageStats } from "./bridge/usage-store.js";
import { start, stop } from "./bridge/lifecycle.js";
import { setExtraRouteHandler, setLocalServerReadyHook } from "./bridge/route-hooks.js";
import { markHostProcess, selfStopRefusal } from "./bridge/stop-guard.js";
import { armShutdownDeadline } from "./bridge/shutdown-deadline.js";
import { apiRouteHandler, setShutdownHook } from "./server/api-router.js";
import {
  deleteToken, listTokenViews, mintToken, revokeToken, rotateToken,
} from "./http/auth.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const VERSION: string = pkg.version;

const HELP = `open-bridge ${VERSION} — standalone MCP bridge for local workspaces

用法:
  open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]
  open-bridge stop | status | url | instances | health | prompt
  open-bridge logs [--tail N] [--follow] [--clear]
  open-bridge config [list] [get KEY] [set KEY VALUE] [path]
  open-bridge token create [--label L] [--ttl SEC] | list | revoke ID | delete ID | rotate ID
  open-bridge doctor
  open-bridge version

说明:
  serve     前台启动 Bridge；控制台地址打印在终端
  stop      停止「当前目录」那个实例（没有则按唯一运行中的实例）
            由该实例自己启动的命令（例如走它的 MCP 工具执行）会被拒绝——那等于立刻断掉
            自己正在用的连接；要真停，由人在终端里加 --force
  status    同上，打印状态、项目根、MCP URL 与暴露情况
  instances 列出共用同一数据目录的所有实例（一个目录一个实例）
  logs      读取/跟踪/清空日志文件（~/.open-bridge/logs/bridge.log）
  health    对运行中的实例做一次体检：监听、隧道、暴露、工具数
  prompt    打印给 AI 客户端的接入提示词（含 MCP URL，可直接粘贴）
  config    配置文件位于 ~/.open-bridge/config.json（OPEN_BRIDGE_HOME 可改）
  token     管理 Bearer 令牌；明文只在 create/rotate 时显示一次

工作区 = 当前目录:
  在 A 目录运行 open-bridge serve，A 就是这次运行的工作区（相对路径的基准）；
  在 B 目录再跑一次，就是第二个实例，两个实例互不干扰、可同时在线。
  用 --root DIR 可以覆盖，用 open-bridge instances 看谁在跑。
`;

type ParsedArgs = { command: string; rest: string[]; flags: Map<string, string | true> };

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, rest: positional, flags };
}

function fail(message: string): never {
  console.error(`open-bridge: ${message}`);
  process.exit(1);
}

// --- runtime registry -------------------------------------------------------

function runtimePath(home: string, root: string): string {
  return path.join(home, `runtime-${workspaceSuffixFor(root)}.json`);
}

/**
 * Startup lock for one workspace root, created with `wx` BEFORE the listener
 * binds. The runtime-record check above is read-then-act: two `serve`s in the
 * same directory within the same second both saw no record, both bound
 * (different ephemeral ports), and the later runtime write hid the first
 * instance for good. The lock file closes that window; it is removed on
 * shutdown and treated as stale when its pid is gone.
 */
function serveLockPath(home: string, root: string): string {
  return path.join(home, `serve-${workspaceSuffixFor(root)}.lock`);
}

/** The pre-multi-instance record: one file for whichever instance wrote last. */
function legacyRuntimePath(home: string): string {
  return path.join(home, "runtime.json");
}

interface RuntimeInfo { pid: number; port: number; root: string; startedAt: string }

function readOneRuntime(file: string): RuntimeInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeInfo;
    if (typeof raw.pid === "number" && typeof raw.port === "number") return raw;
  } catch { /* absent or corrupt */ }
  return undefined;
}

/**
 * The runtime record for ONE workspace root.
 *
 * The record used to be a single shared `runtime.json`, so starting a Bridge in
 * a second directory overwrote the first record — and then refused to start at
 * all ("已有实例在运行"), even though two directories are two independent
 * workspaces. It is now keyed by the same per-root suffix the route token uses,
 * so each directory has its own instance and its own record. The old file is
 * still read, and honoured only when it names this root, so an instance started
 * by an older build keeps being found.
 */
function readRuntime(home: string, root: string): RuntimeInfo | undefined {
  const own = readOneRuntime(runtimePath(home, root));
  if (own) return own;
  const legacy = readOneRuntime(legacyRuntimePath(home));
  if (legacy && legacy.root && path.resolve(legacy.root) === path.resolve(root)) return legacy;
  return undefined;
}

/** Every live instance sharing this data dir, newest first. */
function readAllRuntimes(home: string): RuntimeInfo[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(home)) {
      if (/^runtime(-[0-9a-f]{24})?\.json$/.test(entry)) files.push(path.join(home, entry));
    }
  } catch { /* no data dir yet */ }
  const seen = new Set<string>();
  const live: RuntimeInfo[] = [];
  for (const file of files) {
    const info = readOneRuntime(file);
    if (!info || !info.root || !pidAlive(info.pid)) continue;
    const key = path.resolve(info.root);
    if (seen.has(key)) continue;
    seen.add(key);
    live.push(info);
  }
  return live.sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
}

/**
 * The instance a bare command acts on: this directory's own Bridge when one is
 * running, otherwise the only live instance on this machine (so `status` typed
 * in the wrong folder still answers instead of pretending nothing runs) — and
 * never an arbitrary pick among several, which would act on another workspace.
 */
function resolveInstance(home: string, root: string): { runtime?: RuntimeInfo; note?: string; live: RuntimeInfo[] } {
  const own = readRuntime(home, root);
  if (own && pidAlive(own.pid)) return { runtime: own, live: readAllRuntimes(home) };
  const live = readAllRuntimes(home);
  if (live.length === 1) {
    return { runtime: live[0], note: `当前目录不是它的项目根（${live[0].root}），按唯一运行中的实例执行。`, live };
  }
  return { live };
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Console token for talking to a running instance from a second process. */
async function consoleTokenFor(home: string, root: string): Promise<string> {
  const secrets = JSON.parse(await fsp.readFile(path.join(home, "secrets.json"), "utf8")) as Record<string, string>;
  const token = secrets[`openBridge.routeToken.${workspaceSuffixFor(root)}`];
  if (!token) throw new Error("找不到该实例的路由令牌（secrets.json 无记录）。");
  return token;
}

/** Best-effort console token: reads are loopback-gated, so a miss is not fatal. */
async function consoleTokenOrUndefined(home: string, root: string): Promise<string | undefined> {
  try { return await consoleTokenFor(home, root); } catch { return undefined; }
}

interface HttpJsonResult { status: number; body: unknown }

/**
 * One-shot JSON request over node:http, with the connection closed immediately.
 *
 * The CLI deliberately avoids global fetch() here: undici parks keep-alive
 * sockets in a process-global dispatcher, and calling process.exit() while
 * those handles are closing trips a libuv assertion on Windows
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" in src\win\async.c).
 * A dedicated agent-less socket leaves nothing behind to race the exit.
 */
function httpJson(
  port: number,
  pathname: string,
  options: { method?: string; token?: string; timeoutMs?: number } = {},
): Promise<HttpJsonResult> {
  const { method = "GET", token, timeoutMs = 5_000 } = options;
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["x-open-bridge-console"] = token;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: pathname, method, headers, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk as Buffer));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try { body = text ? JSON.parse(text) : undefined; } catch { /* keep raw text */ }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    // A recorded port that accepts but never answers (the listener died while
    // the process lives on, another program grabbed the port) would hang
    // stop/status/instances forever — bound every request.
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end();
  });
}


const SERVE_HELP = `open-bridge serve — 启动一个实例（前台运行，Ctrl+C 停止）

用法:
  open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]

参数:
  --port N     监听端口（默认取配置；被占用时自动改用空闲端口并提示）。0 = 随机端口
  --root DIR   这次运行的工作区（AI 能看到的边界）。默认＝当前目录
  --home DIR   数据目录，默认 ~/.open-bridge（OPEN_BRIDGE_HOME 同效）
  --no-tunnel  只在本机使用，不启动 ngrok 隧道
  --open       启动后用浏览器打开控制台
  --help, -h   只打印这段说明，不启动任何东西

行为:
  * 前台运行：服务端日志与三个地址（控制台 / 本地 MCP / 公网 MCP）打印在这个终端里；
    Ctrl+C 是干净停止（清掉 runtime 记录与启动锁），关闭窗口会连带隧道与服务一起停。
  * 一个目录一个实例：本目录已有实例在跑时会拒绝启动，并打印它的控制台地址。
  * 端口固定与否不影响公网 URL —— 路由令牌按工作区生成，同一个目录的地址是稳定的。
`;

// --- serve ------------------------------------------------------------------

async function cmdServe(parsed: ParsedArgs): Promise<void> {
  // `serve --help` used to START a server: dispatch routed the flag into this
  // function and nothing here looked at it, so a stray help request published a
  // listener, a runtime record and a public URL (it really happened during
  // development, from a script that only wanted the usage text). Help now prints
  // and returns before a lock, a port or a registry file is touched.
  // Note the second half: parseArgs only treats `--`-prefixed arguments as flags,
  // so a single-dash `-h` arrives as a positional and has to be looked for.
  if (parsed.flags.has("help") || parsed.flags.has("h") || parsed.rest.includes("-h")) {
    console.log(SERVE_HELP);
    return;
  }
  const home = parsed.flags.get("home") as string | undefined;
  const root = parsed.flags.get("root") as string | undefined;
  const portFlag = parsed.flags.get("port");
  const noTunnel = parsed.flags.has("no-tunnel");
  const openConsole = parsed.flags.has("open");

  // `let`: a configured (non-explicit) port that is already taken is replaced
  // by an ephemeral one below, which the config facade picked up a few lines on.
  let port = typeof portFlag === "string" ? Number(portFlag) : undefined;
  if (portFlag !== undefined && typeof portFlag !== "string") {
    // `serve --port --no-tunnel` parsed the flag as boolean true; Number(true)
    // is 1, which silently tried to bind port 1.
    fail(`--port 需要一个整数值，收到: ${String(portFlag)}`);
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    fail(`--port 必须是 0-65535 的整数，收到: ${String(portFlag)}`);
  }
  const projectRoot = path.resolve(root ?? process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    fail(`项目根目录不存在: ${projectRoot}`);
  }

  // Everything spawned from here on (run_command, shells, services, the tunnel)
  // inherits this stamp, which is what lets `stop` tell "issued from inside the
  // instance" apart from "a human at a terminal" — see stop-guard.ts.
  markHostProcess();

  const { host: nodeHost } = installNodeHost({ homeDir: home, projectRoot, version: VERSION });
  // CLI flags override file config without persisting them.
  const innerGet = nodeHost.config.get.bind(nodeHost.config);
  nodeHost.config.get = <T,>(key: string, fallback: T): T => {
    if (key === "port" && port !== undefined) return port as T;
    if (key === "tunnelProvider" && noTunnel) return "none" as T;
    return innerGet(key, fallback);
  };

  const existing = readRuntime(nodeHost.storageDir(), projectRoot);
  if (existing && pidAlive(existing.pid)) {
    // A double-clicked launcher lands here while an instance is already up,
    // so hand out the console address instead of only refusing.
    fail(`该目录已有实例在运行 (pid ${existing.pid}, 端口 ${existing.port})。它的控制台: http://127.0.0.1:${existing.port}/console/`
      + " ；先 open-bridge stop，或换一个目录/端口再用。");
  }

  // Claim the startup slot before touching the network (see serveLockPath).
  const serveLock = serveLockPath(nodeHost.storageDir(), projectRoot);
  const claimServeLock = (): void => {
    try {
      fs.writeFileSync(serveLock, JSON.stringify({ pid: process.pid, root: projectRoot }), { flag: "wx" });
      return;
    } catch {
      // EEXIST: either a concurrent starter or a crashed one. An alive pid that
      // is not ours wins; anything else (dead pid, corrupt file) is stale.
      let lockPid = 0;
      try {
        lockPid = (JSON.parse(fs.readFileSync(serveLock, "utf8")) as { pid?: number }).pid ?? 0;
      } catch { /* unreadable: treat as stale */ }
      if (lockPid && lockPid !== process.pid && pidAlive(lockPid)) {
        fail(`该目录有一个实例正在启动 (pid ${lockPid})。请稍候，或用 open-bridge instances 查看。`);
      }
    }
    try { fs.rmSync(serveLock, { force: true }); } catch { /* best-effort reclaim */ }
    try {
      fs.writeFileSync(serveLock, JSON.stringify({ pid: process.pid, root: projectRoot }), { flag: "wx" });
    } catch (error) {
      fail(`无法创建启动锁 ${serveLock}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  claimServeLock();

  // Instances share one config file, so the configured port may belong to the
  // instance that is already up in another directory. An explicit --port still
  // wins: someone who asked for 18080 may have a bookmark or firewall rule on
  // it, so we say what is wrong instead of quietly serving somewhere else.
  const desiredPort = nodeHost.config.get<number>("port", 0);
  if (desiredPort > 0 && !(await portAvailable(desiredPort))) {
    if (port !== undefined) {
      fail(`端口 ${desiredPort} 已被占用（可能是另一个实例）。改用其他端口：open-bridge serve --port ${desiredPort + 1}；open-bridge instances 可查看谁在跑。`);
    }
    console.log(`[open-bridge] 配置端口 ${desiredPort} 已被占用，本次改用系统分配的端口。`);
    port = 0;
  }

  // Boot the core the same way the extension's activate() did.
  state.activeWorkspaceRoot = currentWorkspaceRoot();
  loadServices();
  state.usage = loadUsageStats();
  setExtraRouteHandler(apiRouteHandler);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[open-bridge] ${signal} received, stopping...`);
    // Armed before the first await: whatever the graceful path ends up waiting
    // on, the operator said stop and this ends with a dead process.
    const cancelDeadline = armShutdownDeadline(() => {
      console.error("[open-bridge] shutdown did not finish in time; exiting now.");
      process.exit(0);
    });
    try { await stop(); } catch { /* best-effort */ }
    await fsp.rm(runtimePath(nodeHost.storageDir(), projectRoot), { force: true }).catch(() => undefined);
    await fsp.rm(serveLock, { force: true }).catch(() => undefined);
    // An instance started by an older build writes the legacy file too.
    const legacy = readOneRuntime(legacyRuntimePath(nodeHost.storageDir()));
    if (legacy && legacy.pid === process.pid) {
      await fsp.rm(legacyRuntimePath(nodeHost.storageDir()), { force: true }).catch(() => undefined);
    }
    cancelDeadline();
    process.exit(0);
  };
  setShutdownHook(() => shutdown("shutdown request"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Closing the console window is how a launcher user stops everything: Node
  // reports that as SIGHUP on Windows, and Ctrl+Break arrives as SIGBREAK.
  // Neither was handled, so the process could stay alive with the window gone -
  // and the next start was then refused, because the runtime file still named a
  // live pid.
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  // A stray rejected promise used to kill the whole process (Node's default):
  // every session, the tunnel and the console died with it, and the log showed
  // nothing. The per-request path answers 400 on its own now; this is the last
  // line of defence for rejections from timers, peers and third-party internals.
  process.on("unhandledRejection", reason => {
    const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    try { nodeHost.bridgeLog.write(`[ERROR] unhandled rejection: ${text}`); } catch { /* no host yet */ }
    console.error(`[open-bridge] unhandled rejection: ${text}`);
  });

  console.log(`[open-bridge] v${VERSION}  starting...`);
  console.log(`[open-bridge] project root: ${projectRoot}`);
  console.log(`[open-bridge] data dir:    ${nodeHost.storageDir()}`);

  // Published the moment the listener binds (setLocalServerReadyHook), not when
  // start() resolves: with a tunnel configured that can be seconds later, and
  // while a tunnel is failing it never resolves at all — during which
  // `open-bridge status` reported nothing running while the console was serving.
  // The write is synchronous so a `status` that races the bind cannot miss it.
  const runtimeFile = runtimePath(nodeHost.storageDir(), projectRoot);
  const startedAt = new Date().toISOString();
  const publishRuntime = (): void => {
    try {
      fs.writeFileSync(runtimeFile, JSON.stringify({
        pid: process.pid,
        port: state.port,
        root: projectRoot,
        startedAt,
      } satisfies RuntimeInfo, null, 2));
    } catch {
      // Best-effort: without the file, status falls back to the loopback probe.
    }
  };
  setLocalServerReadyHook(publishRuntime);

  await start();
  // Safety net for the paths where the hook does not fire, e.g. start()
  // short-circuiting because the Bridge was already running.
  publishRuntime();

  const consoleUrl = `http://127.0.0.1:${state.port}/console/`;
  console.log("");
  console.log(`  Web 控制台:  ${consoleUrl}`);
  console.log(`  本地 MCP URL: http://127.0.0.1:${state.port}/mcp/${state.routeToken}`);
  // state.tunnelUrl is set only while a tunnel is actually published, so its
  // presence alone decides whether a public URL exists at all.
  if (state.tunnelUrl) console.log(`  公网 MCP URL: ${state.tunnelUrl}`);
  else console.log("  公网 MCP URL: （未开启隧道，仅本机可用）");
  if (state.tunnelUrl && nodeHost.config.get<boolean>("auth.enabled", false) !== true) {
    console.log("  ⚠️  公网可达且未开启鉴权：拿到该 URL 的人都能读写本机文件、执行命令。");
    console.log("      要收紧：控制台「令牌」页签发令牌并开启 Bearer 鉴权，或用「轮换端点」作废旧链接。");
  }
  console.log(`  日志:        ${nodeHost.bridgeLog.path()}`);
  console.log("");
  console.log("  接入 AI 客户端：open-bridge prompt  →  复制提示词并粘贴给客户端");
  console.log("");
  console.log("Ctrl+C 停止。");

  if (openConsole) {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", consoleUrl] : [consoleUrl];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  }
}

// --- stop / status / url ----------------------------------------------------

function resolveHome(parsed: ParsedArgs): string {
  const home = parsed.flags.get("home") as string | undefined;
  return home ? path.resolve(home) : resolveDefaultHome();
}

/** Can we bind this port on loopback right now? */
async function portAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** The workspace root a bare command means: the directory it was typed in. */
function cwdRoot(): string {
  return path.resolve(process.cwd());
}

async function cmdStop(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const root = cwdRoot();
  const { runtime, note } = resolveInstance(home, root);
  if (note) console.log(`注: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) {
    console.log("没有正在运行的实例。");
    await fsp.rm(runtimePath(home, root), { force: true }).catch(() => undefined);
    // Also clear a startup lock left behind by an instance that was killed
    // abruptly (Windows has no SIGTERM, so its handler never ran): otherwise the
    // next `serve` in this directory is refused because of a dead pid. A lock
    // whose process is still alive belongs to a serve that is booting RIGHT NOW
    // and is left alone.
    const staleLock = serveLockPath(home, root);
    let stalePid = 0;
    try {
      stalePid = (JSON.parse(fs.readFileSync(staleLock, "utf8")) as { pid?: number }).pid ?? 0;
    } catch { /* absent or unreadable: nothing to protect */ }
    if (!stalePid || !pidAlive(stalePid)) {
      await fsp.rm(staleLock, { force: true }).catch(() => undefined);
    }
    return;
  }
  if (!parsed.flags.has("force")) {
    const refusal = selfStopRefusal(process.env, runtime.pid, `http://127.0.0.1:${runtime.port}/console/`);
    if (refusal) fail(refusal);
  }

  let shutdownError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = await consoleTokenFor(home, runtime.root);
      const res = await httpJson(runtime.port, "/api/shutdown", { method: "POST", token });
      if (res.status !== 200) throw new Error(`shutdown 返回 ${res.status}`);
      console.log("已发送停止指令。");
      return;
    } catch (error) {
      shutdownError = error;
      await new Promise(resolve => setTimeout(resolve, 400));
      // The endpoint answers and then closes the listener, so a reset socket can
      // race the reply. If the process is gone, the stop worked.
      if (!pidAlive(runtime.pid)) {
        console.log("已停止（响应在途时连接被关闭，但实例确实退出了）。");
        return;
      }
    }
  }
  console.error(`停止失败 (${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)})，尝试直接终止进程。`);
  try {
    if (process.platform === "win32") {
      // TerminateProcess via process.kill() leaves the ngrok child alive and
      // holding the reserved domain — the exact mess lifecycle's own error
      // text tells people to clean up with taskkill. Kill the whole tree.
      const { execFileSync } = await import("node:child_process");
      execFileSync("taskkill.exe", ["/pid", String(runtime.pid), "/T", "/F"], { stdio: "ignore", timeout: 3_000, windowsHide: true });
    } else {
      process.kill(runtime.pid);
    }
    console.log("进程已终止。");
  } catch { fail("进程终止失败。"); }
}

/** The runtime record's port may have been taken by an unrelated program; a non-JSON answer must not crash the CLI. */
function statusBodyOf(res: HttpJsonResult): Record<string, unknown> {
  const body = res.body as { status?: unknown } | undefined;
  const status = body?.status;
  if (!status || typeof status !== "object") fail("实例端口返回了意外内容（该端口可能已被其他程序占用）。用 open-bridge instances 核对。");
  return status as Record<string, unknown>;
}

async function cmdStatus(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { runtime, note, live } = resolveInstance(home, cwdRoot());
  if (note) console.log(`注: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) {
    console.log("状态: 未运行");
    if (live.length > 1) console.log(`（本机还有 ${live.length} 个其他目录的实例，用 open-bridge instances 查看）`);
    return;
  }
  const res = await httpJson(runtime.port, "/api/status", { token: await consoleTokenOrUndefined(home, runtime.root) });
  if (res.status !== 200) fail(`status 请求失败: HTTP ${res.status}`);
  const status = statusBodyOf(res);
  console.log(`状态: ${String(status.state)} (pid ${runtime.pid})`);
  console.log(`项目根: ${runtime.root}`);
  if (status.local_url) console.log(`本地 MCP: ${String(status.local_url)}`);
  if (status.public_url) console.log(`公网 MCP: ${String(status.public_url)}`);
  else console.log("公网 MCP: （未开启隧道，仅本机可用）");
  if (status.exposure === "public-open") {
    console.log("⚠️  公网可达且未开启鉴权：拿到该 URL 的人都能读写本机文件、执行命令。可用「令牌」页开启 Bearer 鉴权。");
  }
  console.log(`会话: ${String(status.active_sessions)}  命令: ${String(status.active_commands)}  工具: ${String(status.tool_count)}`);
}

async function cmdUrl(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { runtime, note } = resolveInstance(home, cwdRoot());
  if (note) console.log(`注: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) fail("没有正在运行的实例。");
  const res = await httpJson(runtime!.port, "/api/status", { token: await consoleTokenOrUndefined(home, runtime.root) });
  if (res.status !== 200) fail(`status 请求失败: HTTP ${res.status}`);
  const status = statusBodyOf(res);
  const url = String(status.mcp_url ?? "") || String(status.local_url ?? "");
  if (!url) fail("实例在运行但还没有 MCP URL。");
  console.log(url);
}

/**
 * Print the ready-made opening message for an AI client.
 *
 * The console has always been able to hand this out, but until now nothing
 * outside the browser could: the standalone build exported webAiPrompt() and
 * never called it, so the onboarding text the VS Code extension offered was
 * unreachable. This is the terminal's way to it — paste the output straight
 * into ChatGPT/Claude/Cursor and the client has the URL (and the bearer note
 * when that gate is on).
 */
async function cmdPrompt(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { runtime, note } = resolveInstance(home, cwdRoot());
  if (note) console.log(`注: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) fail("没有正在运行的实例。先 open-bridge serve。");
  const res = await httpJson(runtime.port, "/api/prompt", {
    token: await consoleTokenOrUndefined(home, runtime.root),
  });
  if (res.status !== 200) fail(`prompt 请求失败: HTTP ${res.status}`);
  const body = res.body as { prompt?: string; error?: string };
  if (!body.prompt) fail(body.error ?? "实例在运行，但暂时没有可用的提示词。");
  console.log(body.prompt);
}

// --- instances / logs / health ----------------------------------------------

/**
 * Every live instance sharing this data dir.
 *
 * The standalone app supports one Bridge per directory, and they share one data
 * dir (config, tokens, peer registry) — so the only honest answer to "what is
 * running?" is a list, not a single record.
 */
async function cmdInstances(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const live = readAllRuntimes(home);
  if (live.length === 0) {
    console.log("没有正在运行的实例。");
    return;
  }
  const here = cwdRoot();
  console.log(`${live.length} 个实例正在运行（数据目录 ${home}）：`);
  for (const info of live) {
    let extra = "";
    try {
      const res = await httpJson(info.port, "/api/status", { token: await consoleTokenOrUndefined(home, info.root) });
      if (res.status === 200) {
        const s = (res.body as { status?: Record<string, unknown> }).status;
        if (s && typeof s === "object") {
          extra = ` · ${String(s.tunnel_role ?? "none")} · ${String(s.exposure ?? "?")} · 会话 ${String(s.active_sessions ?? "?")} · 工具 ${String(s.tool_count ?? "?")}`;
        }
      }
    } catch {
      extra = " · (状态不可读)";
    }
    const isHere = path.resolve(info.root) === here;
    console.log(`  pid ${info.pid}  端口 ${info.port}  ${info.root}${extra}${isHere ? "  ← 当前目录" : ""}`);
  }
}

/**
 * The instance log.
 *
 * The VS Code extension could show its log in a terminal, copy it, and clear
 * it; the standalone app had a log file nobody could reach from the terminal.
 */
async function cmdLogs(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const file = path.join(home, "logs", "bridge.log");
  if (parsed.flags.has("clear")) {
    try {
      fs.writeFileSync(file, "");
      console.log(`已清空日志: ${file}`);
    } catch (error) {
      fail(`清空失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    console.log(`还没有日志: ${file}`);
    return;
  }
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  const tailFlag = parsed.flags.get("tail");
  const wanted = typeof tailFlag === "string" ? Number(tailFlag) : 200;
  const count = parsed.flags.has("follow") ? 60 : (Number.isFinite(wanted) ? Math.max(1, Math.min(5000, wanted)) : 200);
  const shown = lines.slice(-count);
  console.log(`# ${file}（共 ${lines.length} 行，显示最后 ${shown.length} 行）`);
  if (shown.length > 0) console.log(shown.join("\n"));
  if (!parsed.flags.has("follow")) return;
  console.log("-- 跟踪中，Ctrl+C 退出 --");
  // The file can vanish between the read above and this stat (rotation, a
  // concurrent `logs --clear`): start from 0 instead of crashing the CLI —
  // the interval's own try/catch re-reads once it comes back.
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* starts over when it reappears */ }
  const timer = setInterval(() => {
    try {
      const stat = fs.statSync(file);
      if (stat.size < size) size = 0; // the file was cleared or rotated
      if (stat.size === size) return;
      const stream = fs.createReadStream(file, { start: size, end: stat.size - 1 });
      // Decode ONCE for the whole slice: per-chunk String(data) split multibyte
      // UTF-8 characters at the read boundary and printed replacement glyphs
      // for every CJK log line that straddled a chunk edge.
      const parts: Buffer[] = [];
      stream.on("data", data => { parts.push(data as Buffer); });
      stream.on("end", () => {
        size = stat.size;
        process.stdout.write(Buffer.concat(parts).toString("utf8"));
      });
    } catch { /* file gone; keep waiting for it to come back */ }
  }, 1000);
  await new Promise<void>(resolve => { process.on("SIGINT", () => { clearInterval(timer); resolve(); }); });
}

/**
 * One-shot health report for a running instance: listener, tunnel, exposure,
 * tool count, and — when a tunnel is published — a real round trip through the
 * public URL, which is the only check that proves a client could connect.
 */
async function cmdHealth(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { runtime, note } = resolveInstance(home, cwdRoot());
  if (note) console.log(`注: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) fail("没有正在运行的实例。先 open-bridge serve。");
  const token = await consoleTokenOrUndefined(home, runtime.root);
  const res = await httpJson(runtime.port, "/api/status", { token });
  if (res.status !== 200) fail(`status 请求失败: HTTP ${res.status}`);
  const status = (res.body as { status: Record<string, unknown> }).status;
  const lines: string[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    lines.push(`  [${ok ? "OK" : "!!"}] ${name}: ${detail}`);
  };
  check("instance", true, `pid ${runtime.pid}, 端口 ${runtime.port}`);
  check("workspace", true, String(status.workspace_root ?? runtime.root));
  check("state", status.state === "running", String(status.state));
  check("tools", Number(status.tool_count ?? 0) > 0, `${String(status.tool_count ?? 0)} 个工具（${String(status.tool_profile ?? "?")}）`);
  const publicUrl = typeof status.public_url === "string" ? status.public_url : "";
  check("tunnel", true, publicUrl ? `${String(status.tunnel_role ?? "?")} — ${publicUrl}` : "未开启（仅本机可用）");
  if (publicUrl && token) {
    const origin = new URL(publicUrl).origin;
    const started = Date.now();
    try {
      const probe = await fetch(`${origin}/healthz/${token}`, {
        headers: { "ngrok-skip-browser-warning": "true" },
        signal: AbortSignal.timeout(8000),
      });
      check("public reachability", probe.ok, `HTTP ${probe.status} in ${Date.now() - started} ms（公网真的能连上）`);
    } catch (error) {
      check("public reachability", false, `探测失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const exposure = String(status.exposure ?? "local");
  check("exposure", exposure !== "public-open", exposure === "public-open"
    ? "公网可达且未开启鉴权：拿到 URL 的人都能读写文件、执行命令（令牌页可开启 Bearer）"
    : exposure);
  // Only a compiled instance can answer this; under `npm run dev` the field is
  // absent and the line is skipped rather than guessed.
  if (status.build_stale === true) {
    check("build", false, "磁盘上的 dist 比运行中的实例新：关掉承载实例的终端窗口，再双击一键启动脚本重新启动即可换上新构建");
  } else if (status.build_stale === false) {
    check("build", true, "与运行中的实例一致");
  }
  console.log(`open-bridge health (v${VERSION})`);
  console.log(lines.join("\n"));
}

// --- config -----------------------------------------------------------------

function coerceForKey(key: string, raw: string): unknown {
  const declared = (CONFIG_DEFAULTS as Record<string, unknown>)[key];
  if (declared === undefined) fail(`未知配置项: ${key}（config list 查看全部）`);
  if (typeof declared === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    fail(`${key} 需要 true/false，收到: ${raw}`);
  }
  if (typeof declared === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) fail(`${key} 需要数字，收到: ${raw}`);
    return n;
  }
  if (Array.isArray(declared)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) return parsed;
    } catch { /* fall through */ }
    fail(`${key} 需要 JSON 字符串数组，如 '["a","b"]'`);
  }
  return raw;
}

async function cmdConfig(parsed: ParsedArgs): Promise<void> {
  const { host: nodeHost } = installNodeHost({ homeDir: parsed.flags.get("home") as string | undefined, version: VERSION });
  const [sub = "list", key, value] = parsed.rest;
  switch (sub) {
    case "list": {
      const rows = Object.entries(CONFIG_DEFAULTS).map(([k, fallback]) => {
        const effective = nodeHost.config.get(k, fallback);
        return `  ${k} = ${JSON.stringify(effective)}`;
      });
      console.log(rows.join("\n"));
      return;
    }
    case "get": {
      if (!key) fail("用法: open-bridge config get KEY");
      const declared = (CONFIG_DEFAULTS as Record<string, unknown>)[key];
      if (declared === undefined) fail(`未知配置项: ${key}`);
      console.log(JSON.stringify(nodeHost.config.get(key, declared)));
      return;
    }
    case "set": {
      if (!key || value === undefined) fail("用法: open-bridge config set KEY VALUE");
      await nodeHost.config.update(key, coerceForKey(key, value));
      console.log(`${key} 已保存。`);
      return;
    }
    case "path":
      console.log(nodeHost.configPath());
      return;
    default:
      fail(`未知 config 子命令: ${sub}`);
  }
}

// --- token ------------------------------------------------------------------

async function cmdToken(parsed: ParsedArgs): Promise<void> {
  installNodeHost({ homeDir: parsed.flags.get("home") as string | undefined, version: VERSION });
  const [sub, ...rest] = parsed.rest;
  switch (sub) {
    case "create": {
      const label = parsed.flags.get("label") as string | undefined;
      const ttl = parsed.flags.get("ttl") as string | undefined;
      const ttlSeconds = ttl === undefined ? null : Number(ttl);
      if (ttlSeconds !== null && (!Number.isInteger(ttlSeconds) || ttlSeconds < 0)) {
        fail("--ttl 必须是非负整数秒（0 = 永久）。");
      }
      const minted = await mintToken({ label, ttlSeconds });
      console.log(`令牌已创建 (id: ${minted.id})`);
      console.log(`明文（只显示这一次）: ${minted.secret}`);
      console.log(`有效期: ${minted.permanent ? "永久" : minted.expires_at}`);
      return;
    }
    case "list": {
      const tokens = await listTokenViews();
      if (!tokens.length) { console.log("没有令牌。"); return; }
      for (const token of tokens) {
        const state_ = token.revoked ? "已吊销" : token.expired ? "已过期" : "有效";
        console.log(`  ${token.id}  ${token.label}  [${state_}]  使用 ${token.use_count} 次`);
      }
      return;
    }
    case "revoke": {
      if (!rest[0]) fail("用法: open-bridge token revoke ID");
      const result = await revokeToken(rest[0]);
      console.log(`已吊销 ${result.revoked.length} 个令牌。`);
      return;
    }
    case "delete": {
      if (!rest[0]) fail("用法: open-bridge token delete ID");
      const result = await deleteToken(rest[0]);
      console.log(`已删除 ${result.deleted.length} 个令牌。`);
      return;
    }
    case "rotate": {
      if (!rest[0]) fail("用法: open-bridge token rotate ID");
      const rotated = await rotateToken(rest[0]);
      console.log(`令牌已轮换 (id: ${rotated.id})`);
      console.log(`新明文（只显示这一次）: ${rotated.secret}`);
      return;
    }
    default:
      fail(`未知 token 子命令: ${sub ?? "(空)"}。支持 create/list/revoke/delete/rotate。`);
  }
}

// --- doctor -----------------------------------------------------------------

async function cmdDoctor(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { host: nodeHost } = installNodeHost({ homeDir: home, version: VERSION });
  const lines: string[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    lines.push(`  [${ok ? "OK" : "!!"}] ${name}: ${detail}`);
  };

  const [major] = process.versions.node.split(".").map(Number);
  check("node", major >= 22, `${process.versions.node} (需要 >= 22)`);
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
    check("data dir", true, home);
  } catch (error) {
    check("data dir", false, `${home}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rg = nodeHost.bundledRipgrep();
  check("ripgrep", rg !== undefined, rg ?? "未内置，将回退到 PATH 中的 rg");
  const ngrokExe = nodeHost.config.get("ngrokExecutable", "ngrok");
  check("tunnel provider", true, `${nodeHost.config.get("tunnelProvider", "ngrok")} (${ngrokExe})`);
  const domain = nodeHost.config.get("ngrokDomain", "");
  check("ngrok domain", true, domain || "未配置（serve 时隧道需要，可先 --no-tunnel 本地用）");
  check("config file", true, nodeHost.configPath());
  const live = readAllRuntimes(home);
  check("instance", true, live.length === 0
    ? "未运行"
    : `${live.length} 个实例：${live.map(info => `pid ${info.pid} @ ${info.root}`).join("；")}`);

  console.log(`open-bridge doctor (v${VERSION})`);
  console.log(lines.join("\n"));
}

// --- main -------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case "serve": case "start": return cmdServe(parsed);
    case "stop": return cmdStop(parsed);
    case "status": return cmdStatus(parsed);
    case "url": return cmdUrl(parsed);
    case "instances": case "list": return cmdInstances(parsed);
    case "logs": return cmdLogs(parsed);
    case "health": return cmdHealth(parsed);
    case "prompt": return cmdPrompt(parsed);
    case "config": return cmdConfig(parsed);
    case "token": return cmdToken(parsed);
    case "doctor": return cmdDoctor(parsed);
    case "version": case "--version": case "-v":
      console.log(VERSION);
      return;
    case "help": case "--help": case "-h":
      console.log(HELP);
      return;
    default:
      fail(`未知命令: ${parsed.command}\n\n${HELP}`);
  }
}
