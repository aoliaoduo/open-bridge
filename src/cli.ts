/**
 * open-bridge CLI — the standalone host entry.
 *
 * Commands:
 *   serve   start the Bridge (HTTP + MCP + console), stays in the foreground
 *   stop    stop a running instance (via its local shutdown endpoint)
 *   status  show the running instance's state
 *   url     print the active MCP URL
 *   config  list / get / set / path configuration
 *   token   create / list / revoke / delete / rotate auth tokens
 *   doctor  environment diagnostics
 *   version / help
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { request as httpRequest } from "node:http";
import * as path from "node:path";
import { createRequire } from "node:module";
import { installNodeHost, resolveDefaultHome } from "./host/node-host.js";
import { CONFIG_DEFAULTS } from "./bridge/config-defaults.js";
import { state } from "./bridge/state.js";
import { currentWorkspaceRoot } from "./bridge/paths.js";
import { loadServices } from "./bridge/services.js";
import { loadUsageStats } from "./bridge/usage-store.js";
import { start, stop, setExtraRouteHandler } from "./bridge/lifecycle.js";
import { apiRouteHandler, setShutdownHook } from "./server/api-router.js";
import {
  deleteToken, listTokenViews, mintToken, revokeToken, rotateToken,
} from "./http/auth.js";
import { sha256 } from "./workspace/file-version.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const VERSION: string = pkg.version;

const HELP = `open-bridge ${VERSION} — standalone MCP bridge for local workspaces

用法:
  open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]
  open-bridge stop
  open-bridge status
  open-bridge url
  open-bridge config [list] [get KEY] [set KEY VALUE] [path]
  open-bridge token create [--label L] [--ttl SEC] | list | revoke ID | delete ID | rotate ID
  open-bridge doctor
  open-bridge version

说明:
  serve    前台启动 Bridge；控制台地址打印在终端（默认项目根 = 当前目录）
  stop     通过本机 shutdown 端点停止运行中的实例
  config   配置文件位于 ~/.open-bridge/config.json（OPEN_BRIDGE_HOME 可改）
  token    管理 Bearer 令牌；明文只在 create/rotate 时显示一次
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

function runtimePath(home: string): string {
  return path.join(home, "runtime.json");
}

interface RuntimeInfo { pid: number; port: number; root: string; startedAt: string }

function readRuntime(home: string): RuntimeInfo | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(runtimePath(home), "utf8")) as RuntimeInfo;
    if (typeof raw.pid === "number" && typeof raw.port === "number") return raw;
  } catch { /* absent or corrupt */ }
  return undefined;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Console token for talking to a running instance from a second process. */
async function consoleTokenFor(home: string, root: string): Promise<string> {
  const suffix = sha256(root || "<no-workspace>").slice(0, 24);
  const secrets = JSON.parse(await fsp.readFile(path.join(home, "secrets.json"), "utf8")) as Record<string, string>;
  const token = secrets[`openBridge.routeToken.${suffix}`];
  if (!token) throw new Error("找不到该实例的路由令牌（secrets.json 无记录）。");
  return token;
}

/** Best-effort console token: reads are loopback-gated, so a miss is not fatal. */
async function consoleTokenOrUndefined(home: string, root: string): Promise<string | undefined> {
  try { return await consoleTokenFor(home, root); } catch { return undefined; }
}

interface HttpJsonResult { status: number; body: unknown }

/**
 * `state.publicUrl` mirrors the loopback URL whenever no tunnel is published,
 * so only an https:// value is genuinely reachable from outside this machine.
 * Labelling the loopback case "公网 MCP URL" told users a private address was
 * public; treat anything else as absent.
 */
function tunnelUrl(value: unknown): string {
  return typeof value === "string" && value.startsWith("https://") ? value : "";
}

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
  options: { method?: string; token?: string } = {},
): Promise<HttpJsonResult> {
  const { method = "GET", token } = options;
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
    req.on("error", reject);
    req.end();
  });
}


// --- serve ------------------------------------------------------------------

async function cmdServe(parsed: ParsedArgs): Promise<void> {
  const home = parsed.flags.get("home") as string | undefined;
  const root = parsed.flags.get("root") as string | undefined;
  const portFlag = parsed.flags.get("port");
  const noTunnel = parsed.flags.has("no-tunnel");
  const openConsole = parsed.flags.has("open");

  const port = portFlag === undefined ? undefined : Number(portFlag);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    fail(`--port 必须是 0-65535 的整数，收到: ${String(portFlag)}`);
  }
  const projectRoot = path.resolve(root ?? process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    fail(`项目根目录不存在: ${projectRoot}`);
  }

  const { host: nodeHost } = installNodeHost({ homeDir: home, projectRoot, version: VERSION });
  // CLI flags override file config without persisting them.
  const innerGet = nodeHost.config.get.bind(nodeHost.config);
  nodeHost.config.get = <T,>(key: string, fallback: T): T => {
    if (key === "port" && port !== undefined) return port as T;
    if (key === "tunnelProvider" && noTunnel) return "none" as T;
    return innerGet(key, fallback);
  };

  const existing = readRuntime(nodeHost.storageDir());
  if (existing && pidAlive(existing.pid)) {
    fail(`已有实例在运行 (pid ${existing.pid}, 端口 ${existing.port})。先 open-bridge stop。`);
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
    try { await stop(); } catch { /* best-effort */ }
    await fsp.rm(runtimePath(nodeHost.storageDir()), { force: true }).catch(() => undefined);
    process.exit(0);
  };
  setShutdownHook(() => shutdown("shutdown request"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(`[open-bridge] v${VERSION}  starting...`);
  console.log(`[open-bridge] project root: ${projectRoot}`);
  console.log(`[open-bridge] data dir:    ${nodeHost.storageDir()}`);

  await start();

  await fsp.writeFile(runtimePath(nodeHost.storageDir()), JSON.stringify({
    pid: process.pid,
    port: state.port,
    root: projectRoot,
    startedAt: new Date().toISOString(),
  } satisfies RuntimeInfo, null, 2));

  const consoleUrl = `http://127.0.0.1:${state.port}/console/`;
  console.log("");
  console.log(`  Web 控制台:  ${consoleUrl}`);
  console.log(`  本地 MCP URL: http://127.0.0.1:${state.port}/mcp/${state.routeToken}`);
  const published = tunnelUrl(state.publicUrl);
  if (published) console.log(`  公网 MCP URL: ${published}`);
  else console.log("  公网 MCP URL: （未开启隧道，仅本机可用）");
  console.log(`  日志:        ${nodeHost.bridgeLog.path()}`);
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

async function cmdStop(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const runtime = readRuntime(home);
  if (!runtime || !pidAlive(runtime.pid)) {
    console.log("没有正在运行的实例。");
    await fsp.rm(runtimePath(home), { force: true }).catch(() => undefined);
    return;
  }
  try {
    const token = await consoleTokenFor(home, runtime.root);
    const res = await httpJson(runtime.port, "/api/shutdown", { method: "POST", token });
    if (res.status !== 200) throw new Error(`shutdown 返回 ${res.status}`);
    console.log("已发送停止指令。");
  } catch (error) {
    console.error(`停止失败 (${error instanceof Error ? error.message : String(error)})，尝试直接终止进程。`);
    try { process.kill(runtime.pid); console.log("进程已终止。"); } catch { fail("进程终止失败。"); }
  }
}

async function cmdStatus(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const runtime = readRuntime(home);
  if (!runtime || !pidAlive(runtime.pid)) {
    console.log("状态: 未运行");
    return;
  }
  const res = await httpJson(runtime.port, "/api/status", { token: await consoleTokenOrUndefined(home, runtime.root) });
  if (res.status !== 200) fail(`status 请求失败: HTTP ${res.status}`);
  const body = res.body as { status: Record<string, unknown> };
  console.log(`状态: ${body.status.state} (pid ${runtime.pid})`);
  console.log(`项目根: ${runtime.root}`);
  if (body.status.local_url) console.log(`本地 MCP: ${body.status.local_url}`);
  const published = tunnelUrl(body.status.public_url);
  if (published) console.log(`公网 MCP: ${published}`);
  else console.log("公网 MCP: （未开启隧道，仅本机可用）");
  console.log(`会话: ${body.status.active_sessions}  命令: ${body.status.active_commands}  工具: ${body.status.tool_count}`);
}

async function cmdUrl(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const runtime = readRuntime(home);
  if (!runtime || !pidAlive(runtime.pid)) fail("没有正在运行的实例。");
  const res = await httpJson(runtime!.port, "/api/status", { token: await consoleTokenOrUndefined(home, runtime.root) });
  if (res.status !== 200) fail(`status 请求失败: HTTP ${res.status}`);
  const body = res.body as { status: { public_url?: string; local_url?: string } };
  const url = tunnelUrl(body.status.public_url) || body.status.local_url;
  if (!url) fail("实例在运行但还没有 MCP URL。");
  console.log(url);
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
  const runtime = readRuntime(home);
  check("instance", true, runtime && pidAlive(runtime.pid) ? `运行中 (pid ${runtime.pid}, 端口 ${runtime.port})` : "未运行");

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
