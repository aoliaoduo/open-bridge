/**
 * The commands that read and write local state without needing a running
 * instance: configuration, auth tokens, and environment diagnostics.
 *
 * These three install the host themselves (they touch config and secrets on
 * disk), which is why they are grouped apart from the commands that talk to a
 * live instance over loopback. `installHost` is injected by the entry point
 * so this module does not become a third importer of node-host.ts — see the
 * note in registry.ts.
 */

import * as fs from "node:fs";

import { CONFIG_DEFAULTS } from "../bridge/config-defaults.js";
import { t } from "../bridge/cli-i18n.js";
import {
  deleteToken, listTokenViews, mintToken, revokeToken, rotateToken,
} from "../http/auth.js";
import { fail, type ParsedArgs } from "./args.js";
import { displayWidth, padLabel } from "./format.js";
import { readAllRuntimes, resolveHome } from "./registry.js";
import { VERSION } from "./version.js";

/**
 * How these commands get a host. Injected rather than imported to keep
 * node-host.ts at its two allowed importers; cli.ts wires it at startup.
 */
export interface HostInstaller {
  (options: { homeDir?: string | undefined; version: string }): { host: CliHost };
}

/** Only the surface these three commands actually use. */
export interface CliHost {
  config: { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): Promise<void> };
  configPath(): string;
  storageDir(): string;
  bundledRipgrep(): string | undefined;
}

let installHost: HostInstaller | undefined;
let utcOffset: (() => string) | undefined;

export function setHostInstaller(installer: HostInstaller, offset: () => string): void {
  installHost = installer;
  utcOffset = offset;
}

function hostFor(parsed: ParsedArgs): CliHost {
  if (!installHost) throw new Error("cli/local-commands: setHostInstaller() was never called");
  return installHost({ homeDir: parsed.flags.get("home") as string | undefined, version: VERSION }).host;
}

function localOffset(): string {
  if (!utcOffset) throw new Error("cli/local-commands: setHostInstaller() was never called");
  return utcOffset();
}


export function coerceForKey(key: string, raw: string): unknown {
  const declared = (CONFIG_DEFAULTS as Record<string, unknown>)[key];
  if (declared === undefined) fail(t(`未知配置项: ${key}（config list 查看全部）`, `Unknown config key: ${key} (config list shows them all)`));
  if (typeof declared === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    fail(t(`${key} 需要 true/false，收到: ${raw}`, `${key} needs true/false, got: ${raw}`));
  }
  if (typeof declared === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) fail(t(`${key} 需要数字，收到: ${raw}`, `${key} needs a number, got: ${raw}`));
    return n;
  }
  if (Array.isArray(declared)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) return parsed;
    } catch { /* fall through */ }
    fail(t(`${key} 需要 JSON 字符串数组，如 '["a","b"]'`, `${key} needs a JSON array of strings, e.g. '["a","b"]'`));
  }
  return raw;
}

export async function cmdConfig(parsed: ParsedArgs): Promise<void> {
  const nodeHost = hostFor(parsed);
  const [sub = "list", key, value] = parsed.rest;
  switch (sub) {
    case "list": {
      const entries = Object.entries(CONFIG_DEFAULTS);
      const keyWidth = entries.reduce((max, [k]) => Math.max(max, displayWidth(k)), 0);
      const rows = entries.map(([k, fallback]) => {
        const effective = nodeHost.config.get(k, fallback);
        return `  ${padLabel(k, keyWidth)} = ${JSON.stringify(effective)}`;
      });
      console.log(rows.join("\n"));
      return;
    }
    case "get": {
      if (!key) fail(t("用法: open-bridge config get KEY", "Usage: open-bridge config get KEY"));
      const declared = (CONFIG_DEFAULTS as Record<string, unknown>)[key];
      if (declared === undefined) fail(t(`未知配置项: ${key}`, `Unknown config key: ${key}`));
      console.log(JSON.stringify(nodeHost.config.get(key, declared)));
      return;
    }
    case "set": {
      if (!key || value === undefined) fail(t("用法: open-bridge config set KEY VALUE", "Usage: open-bridge config set KEY VALUE"));
      await nodeHost.config.update(key, coerceForKey(key, value));
      console.log(t(`${key} 已保存。`, `${key} saved.`));
      return;
    }
    case "path":
      console.log(nodeHost.configPath());
      return;
    default:
      fail(t(`未知 config 子命令: ${sub}`, `Unknown config subcommand: ${sub}`));
  }
}


export async function cmdToken(parsed: ParsedArgs): Promise<void> {
  hostFor(parsed);
  const [sub, ...rest] = parsed.rest;
  switch (sub) {
    case "create": {
      const label = parsed.flags.get("label") as string | undefined;
      const ttl = parsed.flags.get("ttl") as string | undefined;
      const ttlSeconds = ttl === undefined ? null : Number(ttl);
      if (ttlSeconds !== null && (!Number.isInteger(ttlSeconds) || ttlSeconds < 0)) {
        fail(t("--ttl 必须是非负整数秒（0 = 永久）。", "--ttl must be a non-negative whole number of seconds (0 = permanent)."));
      }
      const minted = await mintToken({ label, ttlSeconds });
      console.log(t(`令牌已创建 (id: ${minted.id})`, `Token created (id: ${minted.id})`));
      console.log(t(`明文（只显示这一次）: ${minted.secret}`, `Plaintext (shown only now): ${minted.secret}`));
      const validity = minted.permanent ? t("永久", "permanent") : minted.expires_at;
      console.log(t(`有效期: ${validity}`, `Valid until: ${validity}`));
      return;
    }
    case "list": {
      const tokens = await listTokenViews();
      if (!tokens.length) { console.log(t("没有令牌。", "No tokens.")); return; }
      const idWidth = tokens.reduce((max, token) => Math.max(max, displayWidth(token.id)), 0);
      const labelWidth = tokens.reduce((max, token) => Math.max(max, displayWidth(token.label)), 0);
      for (const token of tokens) {
        const state_ = token.revoked
          ? t("已吊销", "revoked")
          : token.expired ? t("已过期", "expired") : t("有效", "valid");
        const uses = t(`使用 ${token.use_count} 次`, `${token.use_count} use(s)`);
        console.log(`  ${padLabel(token.id, idWidth)}  ${padLabel(token.label, labelWidth)}  [${state_}]  ${uses}`);
      }
      return;
    }
    case "revoke": {
      if (!rest[0]) fail(t("用法: open-bridge token revoke ID", "Usage: open-bridge token revoke ID"));
      const result = await revokeToken(rest[0]);
      console.log(t(`已吊销 ${result.revoked.length} 个令牌。`, `Revoked ${result.revoked.length} token(s).`));
      return;
    }
    case "delete": {
      if (!rest[0]) fail(t("用法: open-bridge token delete ID", "Usage: open-bridge token delete ID"));
      const result = await deleteToken(rest[0]);
      console.log(t(`已删除 ${result.deleted.length} 个令牌。`, `Deleted ${result.deleted.length} token(s).`));
      return;
    }
    case "rotate": {
      if (!rest[0]) fail(t("用法: open-bridge token rotate ID", "Usage: open-bridge token rotate ID"));
      const rotated = await rotateToken(rest[0]);
      console.log(t(`令牌已轮换 (id: ${rotated.id})`, `Token rotated (id: ${rotated.id})`));
      console.log(t(`新明文（只显示这一次）: ${rotated.secret}`, `New plaintext (shown only now): ${rotated.secret}`));
      return;
    }
    default:
      fail(t(`未知 token 子命令: ${sub ?? "(空)"}。支持 create/list/revoke/delete/rotate。`, `Unknown token subcommand: ${sub ?? "(none)"}. Supported: create/list/revoke/delete/rotate.`));
  }
}


export async function cmdDoctor(parsed: ParsedArgs): Promise<void> {
  const home = resolveHome(parsed);
  const nodeHost = hostFor(parsed);
  const lines: string[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    // Longest name is "tunnel provider" (15 columns).
    lines.push(`  [${ok ? "OK" : "!!"}] ${padLabel(name, 15)}: ${detail}`);
  };

  const [major = 0] = process.versions.node.split(".").map(Number);
  check("node", major >= 22, `${process.versions.node} ${t("(需要 >= 22)", "(needs >= 22)")}`);
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
    check("data dir", true, home);
  } catch (error) {
    check("data dir", false, `${home}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rg = nodeHost.bundledRipgrep();
  check("ripgrep", rg !== undefined, rg ?? t("未内置，将回退到 PATH 中的 rg", "not bundled; will fall back to the rg on PATH"));
  // A TZ the runtime cannot resolve is not an error anywhere — Node silently
  // runs in UTC — so every log line quietly reads hours away from the wall
  // clock. Real case: `export TZ=CST-8` (a POSIX-style value Windows/ICU does
  // not know) in ~/.bashrc turned a UTC+8 desk into UTC logs. `Etc/Unknown`
  // is exactly the "I gave up" answer, and it is worth naming here.
  // main() already ran normalizeTimezone(), so a repairable POSIX value shows
  // up here as the Etc/GMT* zone it was mapped to — report that plainly rather
  // than pretending the environment was fine all along.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const rawTz = process.env.TZ;
  const zoneUnresolved = zone === "" || zone === "Etc/Unknown";
  const repaired = !zoneUnresolved && zone.startsWith("Etc/GMT");
  check("timezone", !zoneUnresolved,
    zoneUnresolved
      ? t(
        `无法识别 TZ=${JSON.stringify(rawTz ?? "")}，已回落 UTC —— 日志时间会与本机挂钟不一致。改用 IANA 名称（如 TZ=Asia/Shanghai）或直接不设 TZ（跟随系统）`,
        `Unrecognised TZ=${JSON.stringify(rawTz ?? "")}; fell back to UTC, so log times will not match this machine's clock. Use an IANA name (e.g. TZ=Asia/Shanghai) or unset TZ to follow the system.`,
      )
      : repaired
        ? t(
          `${zone}（${localOffset()}）—— 偏移已对，但这是从无法识别的 TZ 自动折算来的固定偏移、不含夏令时；根治办法是在 shell 配置里去掉那行 TZ（跟随系统时区）`,
          `${zone} (${localOffset()}) — the offset is right, but it was derived from an unrecognised TZ and is fixed, with no DST. The real fix is deleting that TZ line from your shell config so the system zone applies.`,
        )
        : `${zone}（${localOffset()}）${rawTz ? ` TZ=${rawTz}` : ""}`);
  // `<string>` on each read, like every other ngrokDomain/tunnelProvider read
  // site: without the explicit type argument T infers from the literal
  // fallback, so `domain` types as "" and `domain || "未配置…"` reads as a
  // branch that can never be taken.
  const ngrokExe = nodeHost.config.get<string>("ngrokExecutable", "ngrok");
  check("tunnel provider", true, `${nodeHost.config.get<string>("tunnelProvider", "ngrok")} (${ngrokExe})`);
  const domain = nodeHost.config.get<string>("ngrokDomain", "");
  check("ngrok domain", true, domain || t("未配置（serve 时隧道需要，可先 --no-tunnel 本地用）", "not configured (needed for the tunnel on serve; --no-tunnel works locally without it)"));
  check("config file", true, nodeHost.configPath());
  const live = readAllRuntimes(home);
  check("instance", true, live.length === 0
    ? t("未运行", "not running")
    : t(
      `${live.length} 个实例：${live.map(info => `pid ${info.pid} @ ${info.root}`).join("；")}`,
      `${live.length} instance(s): ${live.map(info => `pid ${info.pid} @ ${info.root}`).join("; ")}`,
    ));

  console.log(`open-bridge doctor (v${VERSION})`);
  console.log(lines.join("\n"));
}

