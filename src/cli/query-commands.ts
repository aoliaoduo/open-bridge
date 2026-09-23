/**
 * The commands that ask a RUNNING instance something, or ask it to stop.
 *
 * All four share one shape: resolve which instance this directory means, call
 * its loopback API with the console token, print. They are grouped because
 * that shape — not the individual verbs — is what a reader needs to follow.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

import { t } from "./cli-i18n.js";
import { selfStopRefusal } from "../bridge/lifecycle/stop-guard.js";
import { fail, type ParsedArgs } from "./args.js";
import { padLabel } from "./format.js";
import {
  consoleTokenFor, consoleTokenOrUndefined, cwdRoot, httpJson, pidAlive, readAllRuntimes,
  resolveHome, resolveInstance, runtimePath, serveLockPath, type HttpJsonResult, type RuntimeInfo,
} from "./registry.js";

export async function cmdStop(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const root = cwdRoot();
  // `--pid` answers the one case the directory rule cannot: the instance to stop
  // lives in a directory the operator is no longer in (a folder that moved, a
  // second copy, a refusal that named a pid). Everything else keeps meaning
  // "this directory's instance", so the flag stays opt-in.
  const requestedPid = parsed.flags.get("pid");
  let runtime: RuntimeInfo | undefined;
  let note: string | undefined;
  if (typeof requestedPid === "string") {
    const pid = Number(requestedPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      fail(t(`--pid 需要一个进程号（收到 "${requestedPid}"）。`, `--pid expects a process id (got "${requestedPid}").`));
    }
    runtime = readAllRuntimes(home).find(info => info.pid === pid);
    if (!runtime) {
      fail(t(`本机没有 pid ${pid} 的实例记录。open-bridge instances 列出正在运行的实例。`, `No instance on this machine is recorded as pid ${pid}. open-bridge instances lists what is running.`));
    }
    note = t(`按 --pid ${pid} 指定：${runtime.root}（不是当前目录 ${root}）。`, `Targeted by --pid ${pid}: ${runtime.root} (not the current directory, ${root}).`);
  } else {
    const resolved = resolveInstance(home, root);
    runtime = resolved.runtime;
    note = resolved.note;
  }
  if (note) console.log(`${t("注", "Note")}: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) {
    console.log(t("没有正在运行的实例。", "No instance is running."));
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
      if (res.status !== 200) throw new Error(t(`shutdown 返回 ${res.status}`, `shutdown returned ${res.status}`));
      console.log(t("已发送停止指令。", "Stop request sent."));
      return;
    } catch (error) {
      shutdownError = error;
      await new Promise(resolve => setTimeout(resolve, 400));
      // The endpoint answers and then closes the listener, so a reset socket can
      // race the reply. If the process is gone, the stop worked.
      if (!pidAlive(runtime.pid)) {
        console.log(t("已停止（响应在途时连接被关闭，但实例确实退出了）。", "Stopped. The connection dropped while the reply was in flight, but the instance did exit."));
        return;
      }
    }
  }
  console.error(t("停止失败 (", "Stop failed (") + (shutdownError instanceof Error ? shutdownError.message : String(shutdownError)) + t(")，尝试直接终止进程。", "); killing the process directly."));
  try {
    if (process.platform === "win32") {
      // A bare `taskkill /T /F` reaches only the Windows-visible tree: the
      // MSYS exec-emulation children of the instance's bash sessions and
      // monitored commands (watchers, `npm run dev &`) have parent links that
      // point at dead intermediates and survive as unstoppable strays — the
      // same root cause terminateProcess and closeShell fixed in-process via
      // killWindowsProcessFamily. autoShell() is the same first choice an
      // unconfigured Bridge resolves itself, so the group sweep normally runs
      // under the very Git Bash whose process table holds those rows.
      const { killWindowsProcessFamily } = await import("../process/win-family-kill.js");
      const { autoShell } = await import("../shell/shell-provider.js");
      await killWindowsProcessFamily(runtime.pid, autoShell());
      // The family kill swallows per-member refusals (an already-dead pid is a
      // success, not an error), so verify the outcome instead of trusting it.
      if (pidAlive(runtime.pid)) fail(t("进程终止失败。", "Could not kill the process."));
    } else {
      process.kill(runtime.pid);
    }
    console.log(t("进程已终止。", "Process killed."));
  } catch { fail(t("进程终止失败。", "Could not kill the process.")); }
}

/** The runtime record's port may have been taken by an unrelated program; a non-JSON answer must not crash the CLI. */
export function statusBodyOf(res: HttpJsonResult): Record<string, unknown> {
  const body = res.body as { status?: unknown } | undefined;
  const status = body?.status;
  if (!status || typeof status !== "object") fail(t("实例端口返回了意外内容（该端口可能已被其他程序占用）。用 open-bridge instances 核对。", "The instance port returned something unexpected; another program may have taken it. Check open-bridge instances."));
  return status as Record<string, unknown>;
}

export async function cmdStatus(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { runtime, note, live } = resolveInstance(home, cwdRoot());
  if (note) console.log(`${t("注", "Note")}: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) {
    console.log(t("状态: 未运行", "State: not running"));
    if (live.length > 1) {
      console.log(t(
        `（本机还有 ${live.length} 个其他目录的实例，用 open-bridge instances 查看）`,
        `(${live.length} instances for other directories are running here; see open-bridge instances)`,
      ));
    }
    return;
  }
  const res = await httpJson(runtime.port, "/api/status", { token: await consoleTokenOrUndefined(home, runtime.root) });
  if (res.status !== 200) fail(t(`status 请求失败: HTTP ${res.status}`, `status request failed: HTTP ${res.status}`));
  const status = statusBodyOf(res);
  console.log(`${padLabel(t("状态:", "State:"), 9)}${String(status.state)} (pid ${runtime.pid})`);
  console.log(`${padLabel(t("项目根:", "Root:"), 9)}${runtime.root}`);
  if (status.local_url) console.log(`${padLabel(t("本地 MCP:", "Local MCP:"), 9)}${String(status.local_url)}`);
  const publicMcp = t("公网 MCP:", "Public MCP:");
  if (status.public_url) console.log(`${padLabel(publicMcp, 9)}${String(status.public_url)}`);
  else console.log(`${padLabel(publicMcp, 9)}${t("（未开启隧道，仅本机可用）", "(no tunnel; this machine only)")}`);
  if (status.exposure === "public-open") {
    console.log(t(
      "⚠️  公网可达且未开启鉴权：拿到该 URL 的人都能读写本机文件、执行命令。可用「安全」页打开 Bearer 门禁。",
      "⚠️  Reachable from the internet with no auth: anyone holding this URL can read and write files here and run commands. The Security page turns on the Bearer gate.",
    ));
  }
  console.log(t(
    `会话: ${String(status.active_sessions)}  命令: ${String(status.active_commands)}  工具: ${String(status.tool_count)}`,
    `Sessions: ${String(status.active_sessions)}  Commands: ${String(status.active_commands)}  Tools: ${String(status.tool_count)}`,
  ));
}

export async function cmdUrl(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { runtime, note } = resolveInstance(home, cwdRoot());
  if (note) console.log(`${t("注", "Note")}: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) fail(t("没有正在运行的实例。", "No instance is running."));
  const res = await httpJson(runtime!.port, "/api/status", { token: await consoleTokenOrUndefined(home, runtime.root) });
  if (res.status !== 200) fail(t(`status 请求失败: HTTP ${res.status}`, `status request failed: HTTP ${res.status}`));
  const status = statusBodyOf(res);
  const url = String(status.mcp_url ?? "") || String(status.local_url ?? "");
  if (!url) fail(t("实例在运行但还没有 MCP URL。", "The instance is running but has no MCP URL yet."));
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
export async function cmdPrompt(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { runtime, note } = resolveInstance(home, cwdRoot());
  if (note) console.log(`${t("注", "Note")}: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) fail(t("没有正在运行的实例。先 open-bridge serve。", "No instance is running. Start one with open-bridge serve."));
  const res = await httpJson(runtime.port, "/api/prompt", {
    token: await consoleTokenOrUndefined(home, runtime.root),
  });
  if (res.status !== 200) fail(t(`prompt 请求失败: HTTP ${res.status}`, `prompt request failed: HTTP ${res.status}`));
  const body = res.body as { prompt?: string; error?: string };
  if (!body.prompt) fail(body.error ?? t("实例在运行，但暂时没有可用的提示词。", "The instance is running, but no prompt is available right now."));
  console.log(body.prompt);
}

