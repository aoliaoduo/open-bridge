/**
 * The runtime registry: who is running, where, and how to talk to them.
 *
 * One instance per directory, all sharing a data dir, each publishing a small
 * JSON record. Every command that answers "what is running?" reads these, so
 * the readers, the loopback JSON client and the small path/pid helpers live
 * together here rather than being duplicated per command module.
 *
 * cli.ts resolves the default home at the composition root and passes it in;
 * registry lookup does not need a dependency on the concrete host.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { request as httpRequest } from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import { t } from "../bridge/cli-i18n.js";
import { workspaceSuffixFor } from "../bridge/paths.js";
import type { ParsedArgs } from "./args.js";

// --- runtime registry -------------------------------------------------------

export function runtimePath(home: string, root: string): string {
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
export function serveLockPath(home: string, root: string): string {
  return path.join(home, `serve-${workspaceSuffixFor(root)}.lock`);
}

/** The pre-multi-instance record: one file for whichever instance wrote last. */
export function legacyRuntimePath(home: string): string {
  return path.join(home, "runtime.json");
}

export interface RuntimeInfo { pid: number; port: number; root: string; startedAt: string }

export function readOneRuntime(file: string): RuntimeInfo | undefined {
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
export function readRuntime(home: string, root: string): RuntimeInfo | undefined {
  const own = readOneRuntime(runtimePath(home, root));
  if (own) return own;
  const legacy = readOneRuntime(legacyRuntimePath(home));
  if (legacy && legacy.root && path.resolve(legacy.root) === path.resolve(root)) return legacy;
  return undefined;
}

/** Every live instance sharing this data dir, newest first. */
export function readAllRuntimes(home: string): RuntimeInfo[] {
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
export function resolveInstance(home: string, root: string): { runtime?: RuntimeInfo; note?: string; live: RuntimeInfo[] } {
  const own = readRuntime(home, root);
  if (own && pidAlive(own.pid)) return { runtime: own, live: readAllRuntimes(home) };
  const live = readAllRuntimes(home);
  const only = live.length === 1 ? live[0] : undefined;
  if (only) {
    return { runtime: only, note: t(`当前目录不是它的项目根（${only.root}），按唯一运行中的实例执行。`, `This directory is not its project root (${only.root}); acting on the only running instance.`), live };
  }
  return { live };
}

/**
 * The live instance holding `port`, when this machine's registry knows one.
 *
 * Two copies of a project share one config file, so the copy that starts second
 * asks for the very port the first copy is already serving on. Reported as
 * "possibly another instance", that refusal is a dead end: the operator is
 * standing in the new directory and cannot see the old one. Naming the holder
 * (pid + root) and the command that frees the port turns it into a next step.
 */
export function holderOfPort(home: string, port: number): RuntimeInfo | undefined {
  if (!(port > 0)) return undefined;
  return readAllRuntimes(home).find(info => info.port === port);
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Console token for talking to a running instance from a second process. */
export async function consoleTokenFor(home: string, root: string): Promise<string> {
  const secrets = JSON.parse(await fsp.readFile(path.join(home, "secrets.json"), "utf8")) as Record<string, string>;
  const token = secrets[`openBridge.routeToken.${workspaceSuffixFor(root)}`];
  if (!token) throw new Error(t("找不到该实例的路由令牌（secrets.json 无记录）。", "No route token found for this instance (nothing recorded in secrets.json)."));
  return token;
}

/** Best-effort console token: reads are loopback-gated, so a miss is not fatal. */
export async function consoleTokenOrUndefined(home: string, root: string): Promise<string | undefined> {
  try { return await consoleTokenFor(home, root); } catch { return undefined; }
}

export interface HttpJsonResult { status: number; body: unknown }

/**
 * One-shot JSON request over node:http, with the connection closed immediately.
 *
 * The CLI deliberately avoids global fetch() here: undici parks keep-alive
 * sockets in a process-global dispatcher, and calling process.exit() while
 * those handles are closing trips a libuv assertion on Windows
 * ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" in src\win\async.c).
 * A dedicated agent-less socket leaves nothing behind to race the exit.
 */
export function httpJson(
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



/**
 * The default data dir, injected once by cli.ts at startup.
 *
 * The entry point owns environment/default-home resolution; command modules
 * only need the resolved path, not the file-backed host implementation.
 */
let defaultHome = "";

export function setDefaultHome(home: string): void {
  defaultHome = home;
}

/** Resolve --home for a command, falling back to the injected default. */
export function resolveHome(parsed: ParsedArgs): string {
  const flag = parsed.flags.get("home") as string | undefined;
  if (flag) return path.resolve(flag);
  // Empty means setDefaultHome was never called — a wiring mistake in a new
  // entry point, not a user error, so say so instead of silently using cwd.
  if (!defaultHome) throw new Error("cli/registry: setDefaultHome() was never called");
  return defaultHome;
}



/** Can we bind this port on loopback right now? */
export async function portAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** The workspace root a bare command means: the directory it was typed in. */
export function cwdRoot(): string {
  return path.resolve(process.cwd());
}

