/**
 * Read-only reconnaissance for the tunnel card: what is installed, what is
 * logged in, which domains exist, and who is serving 443 right now.
 *
 * Everything here is a question, never a change: nothing in this module writes
 * a config file, runs `funnel --bg`, or touches ngrok's own settings. The one
 * write path stays the operator's click (see the autoConfigureTunnel action).
 *
 * All probes are time-bounded and none of them throw. A settings page that
 * fails because `tailscale status` hung is worse than a settings page that says
 * "没检测到" — the operator can still type a path by hand.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { detectNgrok } from "./ngrok-locate.js";
import { readFunnelConfig, type FunnelRead } from "./funnel-ownership.js";
import { resolveTailscaleExecutable } from "./tailscale-locate.js";
import { findOnPath, type DetectEnv, type ExecutableChoice } from "../shell/which.js";
import type { NgrokFacts, TailscaleFacts, TunnelFacts } from "./tunnel-plan.js";

/** Where ngrok keeps its own account credential, best first. */
export function ngrokConfigCandidates(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? "";
  const localAppData = env.LOCALAPPDATA ?? (home ? `${home}\\AppData\\Local` : "");
  const appData = env.APPDATA ?? (home ? `${home}\\AppData\\Roaming` : "");
  if (platform === "win32") {
    return [
      localAppData ? `${localAppData}\\ngrok\\ngrok.yml` : "",
      appData ? `${appData}\\ngrok\\ngrok.yml` : "",
      `${home}\\.ngrok2\\ngrok.yml`,
    ].filter(Boolean);
  }
  return [
    home ? `${home}/.config/ngrok/ngrok.yml` : "",
    home ? `${home}/.ngrok2/ngrok.yml` : "",
  ].filter(Boolean);
}

/**
 * The `authtoken:` line of an ngrok.yml, without a YAML parser.
 *
 * The file also holds tunnels, version and possibly several agents; the token
 * is the one scalar this needs, and it is a plain `authtoken: <value>` line at
 * any indentation. Reading it as text keeps the bridge free of a dependency for
 * one key — and a file we cannot parse simply reports "no token", which is the
 * same state as having none.
 */
export function parseNgrokAuthtoken(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*authtoken:\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/^["']|["']$/g, "").trim();
    if (value) return value;
  }
  return "";
}

/** The authtoken ngrok itself would use, or null when there is none to read. */
export function readNgrokConfigAuthtoken(
  options: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform; readFile?: (file: string) => string } = {},
): { file: string; token: string } | null {
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  for (const file of ngrokConfigCandidates(options.env ?? process.env, options.platform ?? process.platform)) {
    try {
      const token = parseNgrokAuthtoken(readFile(file));
      if (token) return { file, token };
    } catch { /* missing or unreadable: try the next location */ }
  }
  return null;
}

/** The domain names out of `GET /reserved_domains`, tolerating an odd payload. */
export function parseReservedDomains(payload: unknown): string[] {
  const rows = (payload as { reserved_domains?: unknown } | null)?.reserved_domains;
  if (!Array.isArray(rows)) return [];
  const domains: string[] = [];
  for (const row of rows) {
    const domain = (row as { domain?: unknown } | null)?.domain;
    if (typeof domain === "string" && domain.trim() && !domains.includes(domain.trim())) {
      domains.push(domain.trim());
    }
  }
  return domains;
}

export interface ReservedDomainsResult {
  domains: string[];
  /** Why the list is empty, when that is worth telling the operator. */
  error: string | null;
}

/**
 * Ask ngrok which reserved domains this account owns.
 *
 * Online, but the operator's own token: this is the difference between a
 * dropdown and "go copy your domain out of the ngrok dashboard", which is the
 * step a novice cannot do. A failure is reported, never fatal — the field then
 * falls back to typing, and an offline machine still gets a working card.
 */
export async function fetchReservedDomains(
  authtoken: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReservedDomainsResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const response = await doFetch("https://api.ngrok.com/reserved_domains", {
      headers: { authorization: `Bearer ${authtoken}`, "ngrok-version": "2" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // ngrok answers 400 to a token it cannot parse and 401 to one it does not
      // recognise; both mean the same thing to the operator, and both are worth
      // saying out loud — otherwise the field just looks empty.
      const stale = response.status === 400 || response.status === 401;
      return { domains: [], error: `ngrok 接口返回 HTTP ${response.status}${stale ? "（authtoken 可能已失效）" : ""}` };
    }
    const domains = parseReservedDomains(await response.json().catch(() => null));
    return { domains, error: domains.length ? null : "ngrok 返回的保留域名为空" };
  } catch (error) {
    return { domains: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** `tailscale status --json`: the three fields the card needs. */
export function parseTailscaleStatus(text: string): { loggedIn: boolean; domain: string; online: boolean } {
  try {
    const parsed = JSON.parse(text) as { Self?: { DNSName?: string; Online?: boolean }; BackendState?: string };
    const domain = parsed.Self?.DNSName?.replace(/\.$/, "").toLowerCase() ?? "";
    return {
      loggedIn: Boolean(domain) || parsed.BackendState === "Running",
      domain,
      online: parsed.Self?.Online === true,
    };
  } catch {
    return { loggedIn: false, domain: "", online: false };
  }
}

/** One bounded child-process call: stdout on success, a reason on failure. */
export type RunText = (exe: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string; error: string }>;

const runText: RunText = (exe, args, timeoutMs) => new Promise(resolve => {
  execFile(exe, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
    if (error) resolve({ ok: false, stdout: stdout ?? "", error: error.message });
    else resolve({ ok: true, stdout: stdout ?? "", error: "" });
  });
});

/** Which copy of ngrok would actually run, and whether it is there at all. */
function ngrokChoice(configured: string, detect: DetectEnv): ExecutableChoice | undefined {
  const explicit = configured.trim();
  if (explicit && explicit !== "ngrok") return { value: explicit, label: "配置里指定的路径", available: true };
  return detectNgrok(detect)[0];
}

export interface TunnelDetectOptions {
  /** Values already in config — an explicit path is described as such. */
  ngrokExecutable?: string;
  tailscaleExecutable?: string;
  /**
   * The authtoken saved in the console's secret store, when there is one. It
   * never leaves this process: it is used for the reserved-domain call and
   * reported only as `authtokenSource: "stored"`.
   */
  storedAuthtoken?: string;
  /** Injected in tests: no spawning, no network, no filesystem. */
  run?: RunText;
  detect?: DetectEnv;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  exists?: (file: string) => boolean;
  readFile?: (file: string) => string;
  fetchImpl?: typeof fetch;
  /** Skip the ngrok API call even when a token exists (tests, offline mode). */
  skipDomainsApi?: boolean;
  /** Injected in tests: the real one spawns the tailscale CLI. */
  readFunnel?: (exe: string, domain: string | undefined, timeoutMs: number) => Promise<FunnelRead>;
}

/** Everything the card knows about ngrok, read-only. */
export async function detectNgrokFacts(options: TunnelDetectOptions = {}): Promise<NgrokFacts> {
  const detect = options.detect ?? {};
  const choice = ngrokChoice(options.ngrokExecutable ?? "", detect);
  const fileToken = readNgrokConfigAuthtoken({
    env: options.env,
    platform: options.platform,
    ...(options.readFile ? { readFile: options.readFile } : {}),
  });
  const stored = options.storedAuthtoken?.trim() ?? "";
  const authtokenSource: NgrokFacts["authtokenSource"] = stored
    ? "stored"
    : fileToken
      ? "ngrok-config"
      : "none";

  let domains: string[] = [];
  let domainsError: string | null = null;
  // Either token asks the same question; the stored one wins because it is the
  // one the tunnel will actually use.
  const token = stored || fileToken?.token || "";
  if (!options.skipDomainsApi && token) {
    const result = await fetchReservedDomains(token, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    domains = result.domains;
    domainsError = result.error;
  }

  return {
    installed: Boolean(choice),
    executable: choice?.value ?? "",
    executableLabel: choice?.label ?? "",
    authtokenSource,
    domains,
    domainsError,
  };
}

/** Everything the card knows about Tailscale Funnel, read-only. */
export async function detectTailscaleFacts(options: TunnelDetectOptions = {}): Promise<TailscaleFacts> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runText;
  const readFunnel = options.readFunnel ?? readFunnelConfig;
  const exists = options.exists ?? existsSync;
  const configured = options.tailscaleExecutable ?? "";
  const exe = resolveTailscaleExecutable(configured, env, platform);
  const explicit = configured.trim();
  const found = explicit ? exists(exe) : exe !== "tailscale" && exists(exe);

  const facts: TailscaleFacts = {
    installed: found,
    executable: found ? exe : "",
    executableLabel: found
      ? explicit
        ? "配置里指定的路径"
        : findOnPath("tailscale", { platform, env }) === exe ? "PATH" : "默认安装目录"
      : "",
    loggedIn: false,
    domain: "",
    online: false,
    mountPort: null,
    mountPublic: false,
  };
  if (!found) return facts;

  // Both calls are the CLI's own, and both are bounded; a daemon that is not
  // running answers with an error, which leaves the facts at their defaults.
  const [status, funnel] = await Promise.all([
    run(exe, ["status", "--json"], 4_000),
    readFunnel(exe, undefined, 4_000),
  ]);
  if (status.ok) Object.assign(facts, parseTailscaleStatus(status.stdout));
  if (funnel.kind === "config" && funnel.backend) {
    facts.mountPort = funnel.backend.port;
    facts.mountPublic = funnel.backend.funnel;
  }
  return facts;
}

/** Both providers at once — the card needs the pair to describe the choice. */
export async function detectTunnelFacts(options: TunnelDetectOptions = {}): Promise<TunnelFacts> {
  const [ngrok, tailscale] = await Promise.all([
    detectNgrokFacts(options).catch(() => null),
    detectTailscaleFacts(options).catch(() => null),
  ]);
  return {
    ngrok: ngrok ?? { installed: false, executable: "", executableLabel: "", authtokenSource: "none", domains: [], domainsError: null },
    tailscale: tailscale ?? {
      installed: false, executable: "", executableLabel: "", loggedIn: false,
      domain: "", online: false, mountPort: null, mountPublic: false,
    },
  };
}
