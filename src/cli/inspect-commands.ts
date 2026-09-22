/**
 * The commands that inspect the machine rather than drive it: what is running,
 * what the log says, and a live check of a single instance.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { t } from "../bridge/cli-i18n.js";
import { fail, type ParsedArgs } from "./args.js";
import { padLabel } from "./format.js";
import {
  consoleTokenOrUndefined, cwdRoot, httpJson, pidAlive, readAllRuntimes, resolveHome,
  resolveInstance,
} from "./registry.js";
import { statusBodyOf } from "./query-commands.js";
import { VERSION } from "./version.js";


/**
 * Every live instance sharing this data dir.
 *
 * The standalone app supports one Bridge per directory, and they share one data
 * dir (config, tokens, peer registry) — so the only honest answer to "what is
 * running?" is a list, not a single record.
 */
export async function cmdInstances(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const live = readAllRuntimes(home);
  if (live.length === 0) {
    console.log(t("没有正在运行的实例。", "No instance is running."));
    return;
  }
  const here = cwdRoot();
  console.log(t(`${live.length} 个实例正在运行（数据目录 ${home}）：`, `${live.length} instance(s) running (data directory ${home}):`));
  for (const info of live) {
    let extra = "";
    try {
      const res = await httpJson(info.port, "/api/status", { token: await consoleTokenOrUndefined(home, info.root) });
      if (res.status === 200) {
        const s = (res.body as { status?: Record<string, unknown> }).status;
        if (s && typeof s === "object") {
          extra = t(` · ${String(s.tunnel_role ?? "none")} · ${String(s.exposure ?? "?")} · 会话 ${String(s.active_sessions ?? "?")} · 工具 ${String(s.tool_count ?? "?")}`, ` · ${String(s.tunnel_role ?? "none")} · ${String(s.exposure ?? "?")} · sessions ${String(s.active_sessions ?? "?")} · tools ${String(s.tool_count ?? "?")}`);
        }
      }
    } catch {
      extra = t(" · (状态不可读)", " · (status unreadable)");
    }
    const isHere = path.resolve(info.root) === here;
    console.log(`  pid ${String(info.pid).padEnd(7)}  ${t("端口", "port")} ${String(info.port).padEnd(5)}  ${info.root}${extra}${isHere ? t("  ← 当前目录", "  ← this directory") : ""}`);
  }
}

/**
 * The instance log.
 *
 * The VS Code extension could show its log in a terminal, copy it, and clear
 * it; the standalone app had a log file nobody could reach from the terminal.
 */
export async function cmdLogs(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const file = path.join(home, "logs", "bridge.log");
  if (parsed.flags.has("clear")) {
    try {
      fs.writeFileSync(file, "");
      console.log(t(`已清空日志: ${file}`, `Log cleared: ${file}`));
    } catch (error) {
      fail(t("清空失败: ", "Clear failed: ") + (error instanceof Error ? error.message : String(error)));
    }
    return;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    console.log(t(`还没有日志: ${file}`, `No log yet: ${file}`));
    return;
  }
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);
  const tailFlag = parsed.flags.get("tail");
  const wanted = typeof tailFlag === "string" ? Number(tailFlag) : 200;
  const count = parsed.flags.has("follow") ? 60 : (Number.isFinite(wanted) ? Math.max(1, Math.min(5000, wanted)) : 200);
  const shown = lines.slice(-count);
  console.log(t(`# ${file}（共 ${lines.length} 行，显示最后 ${shown.length} 行）`, `# ${file} (${lines.length} lines total, showing the last ${shown.length})`));
  if (shown.length > 0) console.log(shown.join("\n"));
  if (!parsed.flags.has("follow")) return;
  console.log(t("-- 跟踪中，Ctrl+C 退出 --", "-- following; Ctrl+C to exit --"));
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
      // The try/catch around this block only sees synchronous throws; a stream
      // error arrives as an event, and an unhandled one on a ReadStream is an
      // uncaught exception that takes the CLI down. The window is real -- the
      // file can be truncated by `logs --clear` or rotation between the
      // statSync above and the read below -- though hammering clear against a
      // follower did not manage to hit it, so this guard is reasoning rather
      // than a reproduction. It costs nothing and the alternative is a crash,
      // so it stays. Skipping the slice is safe: the next tick re-stats, and
      // the size check already handles a file that shrank.
      stream.on("error", () => { /* file changed mid-read; the next tick re-reads */ });
    } catch { /* file gone; keep waiting for it to come back */ }
  }, 1000);

  // SIGINT is not the only way this ends. `open-bridge logs --follow | head -5`
  // closes the pipe as soon as head has its five lines, and a follower that
  // only listens for Ctrl+C keeps waking up every second forever -- invisibly,
  // until someone finds it in the task manager. Piping into head, less, or a
  // script that stops reading is ordinary shell usage, not an error.
  //
  // Listening for EPIPE on stdout is not enough on its own. The error only
  // fires when a write actually fails, and this follower writes only when the
  // log file grows. A quiet log means no write, no error, and no exit: the
  // very case where the orphan lives longest. So each tick also probes the
  // pipe with a zero-length write, which fails the same way a real write
  // would but does not depend on there being anything to say.
  await new Promise<void>(resolve => {
    let done = false;
    let pipeWatch: net.Socket | undefined;
    const finish = (): void => {
      if (done) return; // every path below can fire more than once
      done = true;
      clearInterval(timer);
      clearInterval(pipeProbe);
      resolve();
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
    // The same four signals serve handles. SIGHUP is an ssh session ending --
    // a plausible way to leave a follower running on a remote box -- and
    // SIGBREAK is what closing the window sends on Windows.
    process.on("SIGHUP", finish);
    process.on("SIGBREAK", finish);
    // An unhandled stdout error would kill the process with a stack trace; for
    // a normal `| head` that is noise, so exit quietly instead.
    process.stdout.on("error", finish);
    process.stdout.on("close", finish);
    const pipeProbe = setInterval(() => {
      // destroyed covers the Windows case, where the handle closes without an
      // error event ever being delivered.
      if (process.stdout.destroyed || process.stdout.writableEnded) { finish(); return; }
      try { process.stdout.write(""); } catch { finish(); }
    }, 1000);
    // POSIX needs more than the probes above: the kernel answers a zero-length
    // write with success even when every reader of the pipe is gone, so the
    // probe can never fail there, and stdout's handle never reports destroyed
    // on its own. Watch the write end instead: an O_WRONLY pipe fd whose
    // readers all closed reports EPOLLERR/EPOLLHUP, which surfaces as an error
    // on a read-side socket wrapped over the same fd -- while a healthy pipe
    // (or a file or TTY, which we skip) stays silent. Windows keeps the
    // destroyed/probe path, which is what made the head test pass there.
    try {
      const fifo = process.stdout.fd >= 0
        && process.platform !== "win32"
        && fs.fstatSync(process.stdout.fd).isFIFO();
      if (fifo) {
        // The socket holds the fd read-style only to observe it: never call
        // destroy() on the healthy path, it would close fd 1 out from under
        // the process. unref() keeps it from holding the event loop.
        pipeWatch = new net.Socket({ fd: process.stdout.fd, readable: true, writable: false });
        pipeWatch.unref();
        pipeWatch.on("error", finish);
        pipeWatch.on("close", finish);
        pipeWatch.on("end", finish);
        pipeWatch.on("data", finish);
      }
    } catch { /* no watch; the probes still cover the loud cases */ }
  });
}

/**
 * One-shot health report for a running instance: listener, tunnel, exposure,
 * tool count, and — when a tunnel is published — a real round trip through the
 * public URL, which is the only check that proves a client could connect.
 */
export async function cmdHealth(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const { runtime, note } = resolveInstance(home, cwdRoot());
  if (note) console.log(`${t("注", "Note")}: ${note}`);
  if (!runtime || !pidAlive(runtime.pid)) fail(t("没有正在运行的实例。先 open-bridge serve。", "No instance is running. Start one with open-bridge serve."));
  const token = await consoleTokenOrUndefined(home, runtime.root);
  const res = await httpJson(runtime.port, "/api/status", { token });
  if (res.status !== 200) fail(t(`status 请求失败: HTTP ${res.status}`, `status request failed: HTTP ${res.status}`));
  // statusBodyOf refuses non-object / missing status (the instance's port
  // may have been taken by an unrelated process). cmdStatus / cmdUrl both
  // use it; cmdHealth used to bypass it and emit literal "undefined" for
  // every field — fail with the same clear message instead.
  const status = statusBodyOf(res);
  const lines: string[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    // Longest name is "public reachability" (19 columns); a fixed width keeps the
    // detail column still even when conditional rows are absent.
    lines.push(`  [${ok ? "OK" : "!!"}] ${padLabel(name, 19)}: ${detail}`);
  };
  check("instance", true, `pid ${runtime.pid}, ${t("端口", "port")} ${runtime.port}`);
  check("workspace", true, String(status.workspace_root ?? runtime.root));
  check("state", status.state === "running", String(status.state));
  check("tools", Number(status.tool_count ?? 0) > 0, t(`${String(status.tool_count ?? 0)} 个工具（${String(status.tool_profile ?? "?")}）`, `${String(status.tool_count ?? 0)} tools (${String(status.tool_profile ?? "?")})`));
  const publicUrl = typeof status.public_url === "string" ? status.public_url : "";
  check("tunnel", true, publicUrl ? `${String(status.tunnel_role ?? "?")} — ${publicUrl}` : t("未开启（仅本机可用）", "off (this machine only)"));
  if (publicUrl && token) {
    const origin = new URL(publicUrl).origin;
    const started = Date.now();
    try {
      const probe = await fetch(`${origin}/healthz/${token}`, {
        headers: { "ngrok-skip-browser-warning": "true" },
        signal: AbortSignal.timeout(8000),
      });
      check("public reachability", probe.ok, t(`HTTP ${probe.status} in ${Date.now() - started} ms（公网真的能连上）`, `HTTP ${probe.status} in ${Date.now() - started} ms (the internet really can reach it)`));
    } catch (error) {
      check("public reachability", false, t("探测失败: ", "Probe failed: ") + (error instanceof Error ? error.message : String(error)));
    }
  }
  const exposure = String(status.exposure ?? "local");
  check("exposure", exposure !== "public-open", exposure === "public-open"
    ? t(
      "公网可达且未开启鉴权：拿到 URL 的人都能读写文件、执行命令（安全页可开 Bearer 门禁）",
      "Reachable from the internet with no auth: anyone holding the URL can read and write files and run commands (the Security page turns on the Bearer gate)",
    )
    : exposure);
  // Only a compiled instance can answer this; under `npm run dev` the field is
  // absent and the line is skipped rather than guessed.
  if (status.build_stale === true) {
    check("build", false, t(
      "磁盘上的 dist 比运行中的实例新：关掉承载实例的终端窗口，再双击一键启动脚本重新启动即可换上新构建",
      "The dist on disk is newer than the running instance: close the terminal window hosting it, then double-click the start script again to pick up the new build",
    ));
  } else if (status.build_stale === false) {
    check("build", true, t("与运行中的实例一致", "matches the running instance"));
  }
  console.log(`open-bridge health (v${VERSION})`);
  console.log(lines.join("\n"));
}

