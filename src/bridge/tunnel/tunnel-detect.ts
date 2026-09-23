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
import { findOnPath, type DetectEnv, type ExecutableChoice } from "../../shell/which.js";
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
export function parseNgrokConfigValue(text: string, key: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`).exec(line);
    if (!match) continue;
    const value = (match[1] ?? "").replace(/^["']|["']$/g, "").trim();
    if (value) return value;
  }
  return "";
}

/** The `authtoken:` line: what opens a tunnel. */
export function parseNgrokAuthtoken(text: string): string {
  return parseNgrokConfigValue(text, "authtoken");
}

/**
 * The `api_key:` line: what api.ngrok.com accepts.
 *
 * ngrok keeps its credentials split in two and the split matters. The authtoken
 * opens tunnels — it is the one the bridge imports and the one the agent runs
 * on — and the REST API refuses it outright with ERR_NGROK_206 ("the
 * authentication you specified is actually an authtoken ... check your records
 * for an API key"). The reserved-domain list is an API question, so it needs
 * this key; a machine that never made one has an authtoken, a working tunnel
 * and no list to show, which is a normal state rather than a fault.
 */
export function parseNgrokApiKey(text: string): string {
  return parseNgrokConfigValue(text, "api_key");
}

/** Where ngrok's config is, and how to read it — injected in tests. */
export interface NgrokConfigReadOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  readFile?: (file: string) => string;
}

/**
 * Both of ngrok's credentials, out of the one file that holds them.
 *
 * Read together on purpose: "ngrok is configured" and "the domain list can be
 * read" are different questions with different answers, and the card has to be
 * able to report the first as a yes and the second as a why-not.
 */
export function readNgrokConfigCredentials(
  options: NgrokConfigReadOptions = {},
): { file: string; authtoken: string; apiKey: string } | null {
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  for (const file of ngrokConfigCandidates(options.env ?? process.env, options.platform ?? process.platform)) {
    try {
      const text = readFile(file);
      const authtoken = parseNgrokAuthtoken(text);
      const apiKey = parseNgrokApiKey(text);
      if (authtoken || apiKey) return { file, authtoken, apiKey };
    } catch { /* missing or unreadable: try the next location */ }
  }
  return null;
}

/** The authtoken ngrok itself would use, or null when there is none to read. */
export function readNgrokConfigAuthtoken(options: NgrokConfigReadOptions = {}): { file: string; token: string } | null {
  const found = readNgrokConfigCredentials(options);
  return found?.authtoken ? { file: found.file, token: found.authtoken } : null;
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
 * Why the domain list is empty when ngrok's API is the reason.
 *
 * One line, because it is rendered inside the card's read-only summary as
 * "保留域名：读不到（…）". The authtoken is not broken and this copy must not
 * suggest it is — it is simply not the credential the API takes.
 */
export const NGROK_API_KEY_REQUIRED = "ngrok 的 REST API 需要 API key，authtoken 不能用于 API";

/**
 * Ask ngrok which reserved domains this account owns.
 *
 * With the operator's own API key, and only when there is one: this is the
 * difference between a dropdown and "go copy your domain out of the ngrok
 * dashboard", which is the step a novice cannot do. A failure is reported, never
 * fatal — the field then falls back to typing, and an offline machine still gets
 * a working card.
 */
export async function fetchReservedDomains(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ReservedDomainsResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const response = await doFetch("https://api.ngrok.com/reserved_domains", {
      headers: { authorization: `Bearer ${apiKey}`, "ngrok-version": "2" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // ngrok says so itself when the credential is the wrong KIND; answering
      // "your token expired" instead sends the operator to re-copy a credential
      // that was working.
      const body = await response.json().catch(() => null) as { error_code?: unknown } | null;
      if (body?.error_code === "ERR_NGROK_206") return { domains: [], error: NGROK_API_KEY_REQUIRED };
      // 401/403 is the API key itself being wrong or revoked; anything else is
      // reported as it came.
      const badKey = response.status === 401 || response.status === 403;
      return { domains: [], error: `ngrok 接口返回 HTTP ${response.status}${badKey ? "（API key 可能已失效）" : ""}` };
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
  const config = readNgrokConfigCredentials({
    env: options.env,
    platform: options.platform,
    ...(options.readFile ? { readFile: options.readFile } : {}),
  });
  const stored = options.storedAuthtoken?.trim() ?? "";
  const authtokenSource: NgrokFacts["authtokenSource"] = stored
    ? "stored"
    : config?.authtoken
      ? "ngrok-config"
      : "none";

  let domains: string[] = [];
  let domainsError: string | null = null;
  // Two credentials, two questions: the authtoken is what the tunnel runs on,
  // the API key is what the domain list needs.
  const token = stored || config?.authtoken || "";
  const apiKey = config?.apiKey ?? "";
  if (!options.skipDomainsApi) {
    if (apiKey) {
      const result = await fetchReservedDomains(apiKey, {
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      domains = result.domains;
      domainsError = result.error;
    } else if (token) {
      // The common state: an authtoken and no API key. One line saying which
      // credential the list wants, so the empty dropdown has a reason.
      domainsError = NGROK_API_KEY_REQUIRED;
    }
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
