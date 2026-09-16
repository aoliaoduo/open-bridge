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
 *
 * This file is the ENTRY POINT, not the implementation. It owns three things:
 * the help text, `serve` (the only command that boots the whole Bridge in this
 * process), and the dispatch table. Everything else lives in ./cli/*:
 *
 *   cli/args.ts            argument parsing + fail()
 *   cli/format.ts          terminal column width (CJK-aware padding)
 *   cli/registry.ts        the per-directory runtime records + loopback client
 *   cli/query-commands.ts  stop / status / url / prompt — talk to a live instance
 *   cli/inspect-commands.ts instances / logs / health
 *   cli/local-commands.ts  config / token / doctor — local state, no instance
 *
 * Why the split is shaped this way: it was one 1100-line file where the only
 * boundary was a comment banner. The grouping follows what each command NEEDS
 * (a live instance / the local data dir / nothing), because that is what
 * determines how it can fail — not the alphabet.
 *
 * Two dependencies are INJECTED into those modules rather than imported by
 * them (setDefaultHome, setHostInstaller). AGENTS.md pins node-host.ts to
 * exactly two importers and this file is one of them; splitting the CLI must
 * not quietly become a third. See the note in cli/registry.ts.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { installNodeHost, localUtcOffset, normalizeTimezone, resolveDefaultHome } from "./host/node-host.js";
import { t } from "./bridge/cli-i18n.js";
import { state } from "./bridge/state.js";
import { currentWorkspaceRoot } from "./bridge/paths.js";
import { loadServices } from "./bridge/services.js";
import { loadUsageStats } from "./bridge/usage-store.js";
import { start, stop } from "./bridge/lifecycle.js";
import { setExtraRouteHandler, setLocalServerReadyHook } from "./bridge/route-hooks.js";
import { markHostProcess } from "./bridge/stop-guard.js";
import { armShutdownDeadline } from "./bridge/shutdown-deadline.js";
import { apiRouteHandler, setShutdownHook } from "./server/api-router.js";

import { fail, parseArgs, type ParsedArgs } from "./cli/args.js";
import { padLabel } from "./cli/format.js";
import {
  holderOfPort, legacyRuntimePath, pidAlive, portAvailable, readOneRuntime, readRuntime,
  runtimePath, serveLockPath, setDefaultHome, type RuntimeInfo,
} from "./cli/registry.js";
import { cmdPrompt, cmdStatus, cmdStop, cmdUrl } from "./cli/query-commands.js";
import { cmdHealth, cmdInstances, cmdLogs } from "./cli/inspect-commands.js";
import { cmdConfig, cmdDoctor, cmdToken, setHostInstaller } from "./cli/local-commands.js";
import { VERSION } from "./cli/version.js";


// A function, not a const: the language is resolved from the environment at
// call time, and a module-level template literal would freeze whatever the
// language happened to be when this file was first imported.
const HELP = (): string => t(`open-bridge ${VERSION} — standalone MCP bridge for local workspaces

用法:
  open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]
  open-bridge stop [--pid N] | status | url | instances | health | prompt
  open-bridge logs [--tail N] [--follow] [--clear]
  open-bridge config [list] [get KEY] [set KEY VALUE] [path]
  open-bridge token create [--label L] [--ttl SEC] | list | revoke ID | delete ID | rotate ID
  open-bridge doctor
  open-bridge version

说明:
  serve     前台启动 Bridge；控制台地址打印在终端
  stop      停止「当前目录」那个实例（没有则按唯一运行中的实例；--pid N 指定别的实例）
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
`, `open-bridge ${VERSION} — standalone MCP bridge for local workspaces

Usage:
  open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]
  open-bridge stop [--pid N] | status | url | instances | health | prompt
  open-bridge logs [--tail N] [--follow] [--clear]
  open-bridge config [list] [get KEY] [set KEY VALUE] [path]
  open-bridge token create [--label L] [--ttl SEC] | list | revoke ID | delete ID | rotate ID
  open-bridge doctor
  open-bridge version

Commands:
  serve     Start the Bridge in the foreground; the console URL is printed here
  stop      Stop the instance for THIS directory (or the only running one); --pid N picks another
            Commands the instance itself started (through its own MCP tools) are
            refused: that would cut the connection being used to ask. To really
            stop it, a human adds --force in a terminal
  status    Same target, but prints state, project root, MCP URL and exposure
  instances List every instance sharing this data directory (one per directory)
  logs      Read, follow or clear the log file (~/.open-bridge/logs/bridge.log)
  health    Check a running instance: listener, tunnel, exposure, tool count
  prompt    Print the onboarding prompt for an AI client (MCP URL included)
  config    The config file lives at ~/.open-bridge/config.json (OPEN_BRIDGE_HOME moves it)
  token     Manage Bearer tokens; the plaintext is shown once, at create/rotate

Workspace = current directory:
  Run open-bridge serve in directory A and A is this run's workspace, the base
  for every relative path. Run it again in B and that is a second, independent
  instance; both can be online at once.
  --root DIR overrides it; open-bridge instances shows who is running.
`);
const SERVE_HELP = (): string => t(`open-bridge serve — 启动一个实例（前台运行，Ctrl+C 停止）

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
`, `open-bridge serve — start one instance (foreground; Ctrl+C stops it)

Usage:
  open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]

Flags:
  --port N     Listen port (config default; if taken, a free port is used and reported). 0 = random
  --root DIR   This run's workspace, the boundary the AI can see. Defaults to the current directory
  --home DIR   Data directory, default ~/.open-bridge (OPEN_BRIDGE_HOME does the same)
  --no-tunnel  Local use only: do not start an ngrok tunnel
  --open       Open the console in a browser once started
  --help, -h   Print this text and start nothing

Behaviour:
  * Foreground: server logs and all three addresses (console / local MCP / public MCP)
    print in this terminal. Ctrl+C is a clean stop (runtime record and start lock are
    cleared); closing the window takes the tunnel and the server down with it.
  * One instance per directory: if this directory already has one, startup is refused
    and its console URL is printed instead.
  * A fixed port is not what keeps the public URL stable — the route token is derived
    from the workspace, so the same directory keeps the same address.
`);

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
    console.log(SERVE_HELP());
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
    fail(t(`--port 需要一个整数值，收到: ${String(portFlag)}`, `--port needs an integer, got: ${String(portFlag)}`));
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    fail(t(`--port 必须是 0-65535 的整数，收到: ${String(portFlag)}`, `--port must be an integer from 0 to 65535, got: ${String(portFlag)}`));
  }
  const projectRoot = path.resolve(root ?? process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    fail(t(`项目根目录不存在: ${projectRoot}`, `Project root does not exist: ${projectRoot}`));
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
    fail(t(
      `该目录已有实例在运行 (pid ${existing.pid}, 端口 ${existing.port})。它的控制台: http://127.0.0.1:${existing.port}/console/`
        + " ；先 open-bridge stop，或换一个目录/端口再用。",
      `This directory already has an instance running (pid ${existing.pid}, port ${existing.port}). Its console: http://127.0.0.1:${existing.port}/console/`
        + " . Run open-bridge stop first, or use a different directory or port.",
    ));
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
        fail(t(`该目录有一个实例正在启动 (pid ${lockPid})。请稍候，或用 open-bridge instances 查看。`, `An instance for this directory is still starting (pid ${lockPid}). Wait a moment, or check open-bridge instances.`));
      }
    }
    try { fs.rmSync(serveLock, { force: true }); } catch { /* best-effort reclaim */ }
    try {
      fs.writeFileSync(serveLock, JSON.stringify({ pid: process.pid, root: projectRoot }), { flag: "wx" });
    } catch (error) {
      fail(t(`无法创建启动锁 ${serveLock}: `, `Could not create the start lock ${serveLock}: `) + (error instanceof Error ? error.message : String(error)));
    }
  };
  claimServeLock();

  // Instances share one config file, so the configured port may belong to the
  // instance that is already up in another directory. An explicit --port still
  // wins: someone who asked for 18080 may have a bookmark or firewall rule on
  // it, so we say what is wrong instead of quietly serving somewhere else.
  const desiredPort = nodeHost.config.get<number>("port", 0);
  if (desiredPort > 0 && !(await portAvailable(desiredPort))) {
    // Who holds it decides what the operator can do next, so say it rather than
    // leaving them to guess. A Bridge instance is addressable (`stop --pid`); a
    // foreign program is not, and gets the platform's own owner check instead.
    const holder = holderOfPort(nodeHost.storageDir(), desiredPort);
    const occupied = holder
      ? t(
        `端口 ${desiredPort} 已被占用：pid ${holder.pid} 正在 ${holder.root} 上运行。停止它：open-bridge stop --pid ${holder.pid}；或改用其他端口：open-bridge serve --port ${desiredPort + 1}。`,
        `Port ${desiredPort} is in use by pid ${holder.pid}, serving ${holder.root}. Stop it with open-bridge stop --pid ${holder.pid}, or use another port: open-bridge serve --port ${desiredPort + 1}.`,
      )
      : t(
        `端口 ${desiredPort} 已被占用，且不是本机任何一个 Bridge 实例（占用者是别的程序，${process.platform === "win32" ? `netstat -ano | findstr :${desiredPort}` : `lsof -i :${desiredPort}`} 可查）。改用其他端口：open-bridge serve --port ${desiredPort + 1}。`,
        `Port ${desiredPort} is in use, and no Bridge instance on this machine claims it, so another program holds it (${process.platform === "win32" ? `netstat -ano | findstr :${desiredPort}` : `lsof -i :${desiredPort}`} names it). Use another port: open-bridge serve --port ${desiredPort + 1}.`,
      );
    if (port !== undefined) fail(occupied);
    console.log(`[open-bridge] ${occupied}` + t(" 本次改用系统分配的端口。", " Falling back to a system-assigned port for this run."));
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
  console.log(`  ${padLabel(t("Web 控制台:", "Web console:"), 14)}${consoleUrl}`);
  console.log(`  ${padLabel(t("本地 MCP URL:", "Local MCP URL:"), 14)}http://127.0.0.1:${state.port}/mcp/${state.routeToken}`);
  // state.tunnelUrl is set only while a tunnel is actually published, so its
  // presence alone decides whether a public URL exists at all.
  const publicLabel = t("公网 MCP URL:", "Public MCP URL:");
  if (state.tunnelUrl) console.log(`  ${padLabel(publicLabel, 14)}${state.tunnelUrl}`);
  else console.log(`  ${padLabel(publicLabel, 14)}${t("（未开启隧道，仅本机可用）", "(no tunnel; this machine only)")}`);
  if (state.tunnelUrl && nodeHost.config.get<boolean>("auth.enabled", false) !== true) {
    console.log(t(
      "  ⚠️  公网可达且未开启鉴权：拿到该 URL 的人都能读写本机文件、执行命令。",
      "  ⚠️  Reachable from the internet with no auth: anyone holding this URL can read and write files here and run commands.",
    ));
    console.log(t(
      "  要收紧：去控制台「安全」页签发令牌并打开 Bearer 门禁，或用「轮换端点」作废旧链接。",
      "  To close it: issue a token and turn on the Bearer gate on the console's Security page, or rotate the endpoint to void the old link.",
    ));
  }
  console.log(`  ${padLabel(t("日志:", "Log:"), 14)}${nodeHost.bridgeLog.path()}`);
  console.log("");
  console.log(t(
    "  接入 AI 客户端：open-bridge prompt  →  复制提示词并粘贴给客户端",
    "  Connect an AI client: open-bridge prompt  →  copy the prompt and paste it into the client",
  ));
  console.log("");
  console.log(t("Ctrl+C 停止。", "Ctrl+C to stop."));

  if (openConsole) {
    const { spawn } = await import("node:child_process");
    const cmd = process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", consoleUrl] : [consoleUrl];
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  }
}

// --- main -------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Before anything can log: a POSIX-style TZ (`CST-8`) leaves Node in UTC
  // without a word of complaint, which makes every timestamp this process
  // writes silently wrong. Repairing it here covers serve and the read-only
  // commands alike — `logs` printing stamps from a differently-configured
  // process than the one that wrote them would be its own small nightmare.
  normalizeTimezone();
  // Hand the command modules the two things they must not import themselves
  // (see this file's header): the default data dir, and a way to install a
  // host. Done once here, before any command can ask for either.
  setDefaultHome(resolveDefaultHome());
  setHostInstaller(installNodeHost, localUtcOffset);
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
      console.log(HELP());
      return;
    default:
      fail(t(`未知命令: ${parsed.command}`, `Unknown command: ${parsed.command}`) + `\n\n${HELP()}`);
  }
}

