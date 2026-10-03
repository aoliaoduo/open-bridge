import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { host } from "../../host/host.js";
import { detectNgrok } from "./ngrok-locate.js";

const execFileAsync = promisify(execFile);

export type WindowsNgrokProcessRow = {
  ProcessId?: number;
  ParentProcessId?: number;
  Name?: string;
  CommandLine?: string;
};

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Select only ngrok agents that look exactly like children Open Bridge spawned
 * for this reserved domain AND whose Windows parent no longer exists.
 *
 * The local port deliberately does NOT have to equal the current Bridge port:
 * port 0 chooses a new ephemeral port on each process, so the orphan commonly
 * still points at the PREVIOUS process's port. The dead-parent condition plus
 * the exact `http <valid-port> --url https://<domain> --log stdout` shape are
 * the safety boundary; a live Bridge-owned ngrok is never reaped.
 */
export function orphanManagedNgrokPidsFromRows(
  rows: WindowsNgrokProcessRow[],
  domain: string,
): number[] {
  const livePids = new Set(
    rows.map(row => Number(row.ProcessId)).filter(pid => Number.isSafeInteger(pid) && pid > 0),
  );
  const escapedDomain = regexEscape(domain.trim().toLowerCase());
  const invocation = new RegExp(
    "(?:^|\\s)http\\s+(\\d+)\\s+--url\\s+https://" + escapedDomain
      + "\\s+--log\\s+stdout(?:\\s|$)",
    "i",
  );

  return rows
    .filter(row => {
      const pid = Number(row.ProcessId);
      const parent = Number(row.ParentProcessId);
      const name = String(row.Name ?? "").trim().toLowerCase();
      const commandLine = String(row.CommandLine ?? "");
      const match = invocation.exec(commandLine);
      const forwardedPort = Number(match?.[1]);
      return Number.isSafeInteger(pid)
        && pid > 0
        && name === "ngrok.exe"
        && !livePids.has(parent)
        && Number.isSafeInteger(forwardedPort)
        && forwardedPort >= 1
        && forwardedPort <= 65_535;
    })
    .map(row => Number(row.ProcessId));
}

async function windowsNgrokProcessRows(): Promise<WindowsNgrokProcessRow[]> {
  if (process.platform !== "win32") return [];
  const script =
    "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine; "
    + "$rows | ConvertTo-Json -Compress";
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 5000 },
  );
  const parsed = JSON.parse(result.stdout || "[]") as WindowsNgrokProcessRow | WindowsNgrokProcessRow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Reap only stale ngrok agents left behind by an abruptly closed Bridge.
 *
 * A normal stop already kills the tracked child. This is the recovery path for
 * the ungraceful case where Windows closed the Bridge process first and left
 * ngrok alive with a dead ParentProcessId. Snapshot failure is fail-closed:
 * if ancestry cannot be proven, nothing is killed.
 */
export async function reapOrphanManagedNgrok(domain: string): Promise<number[]> {
  if (process.platform !== "win32") return [];
  let rows: WindowsNgrokProcessRow[];
  try {
    rows = await windowsNgrokProcessRows();
  } catch {
    return [];
  }
  const candidates = orphanManagedNgrokPidsFromRows(rows, domain);
  const reaped: number[] = [];
  for (const pid of candidates) {
    try {
      await execFileAsync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 3000,
      });
      reaped.push(pid);
    } catch {
      // Already gone or not ours to terminate anymore; the fresh public probe
      // in tunnel startup decides what to do next.
    }
  }
  return reaped;
}

/** Account-level, so deliberately NOT suffixed per workspace like the route token. */
export const NGROK_AUTHTOKEN_KEY = "openBridge.ngrokAuthtoken";

/**
 * The authtoken is cached because process spawn is synchronous while secret
 * storage is asynchronous. Reconnects reuse it; settings writes update it
 * immediately so "save then restart tunnel" needs no Bridge restart.
 */
let cachedAuthtoken = "";

export function setCachedAuthtoken(value: string): void {
  cachedAuthtoken = typeof value === "string" ? value : "";
}

export async function loadNgrokAuthtoken(): Promise<void> {
  try {
    cachedAuthtoken = (await host().secrets.get(NGROK_AUTHTOKEN_KEY)) ?? "";
  } catch {
    // Secret-store failure must not stop local Bridge startup. ngrok can still
    // use its own config file or an environment credential.
    cachedAuthtoken = "";
  }
}

/**
 * Environment for an ngrok child.
 *
 * Proxy inheritance remains the default for compatibility. When explicitly
 * disabled, strip all conventional proxy variables. A saved authtoken fills
 * only an absent NGROK_AUTHTOKEN so a CI/shell override still wins.
 */
export function ngrokProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const useProxy = host().config.get<boolean>("ngrokUseHttpProxy", true);
  if (!useProxy) {
    for (const key of Object.keys(env)) {
      if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key];
    }
  }
  const saved = cachedAuthtoken.trim();
  if (saved && !String(env.NGROK_AUTHTOKEN ?? "").trim()) env.NGROK_AUTHTOKEN = saved;
  return env;
}

/** Human-facing diagnosis for a configured ngrok executable that cannot spawn. */
export function ngrokMissingMessage(configured: string): string {
  const found = detectNgrok();
  if (found.length) {
    const list = found.map(choice => choice.label + ": " + choice.value).join(" · ");
    return "ngrok executable not found (" + configured + "), but these copies are installed — "
      + "pick one on the console settings page (设置 → 隧道): " + list;
  }
  return "ngrok executable not found (" + configured + "). ngrok does not appear to be installed on this "
    + "machine: download it from https://ngrok.com/download, then point 设置 → 隧道 → ngrok 可执行文件 "
    + "at the unpacked file. To run loopback-only instead, set the tunnel provider to none.";
}
