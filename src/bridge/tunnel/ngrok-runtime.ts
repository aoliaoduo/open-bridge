import { host } from "../../host/host.js";
import { detectNgrok } from "./ngrok-locate.js";

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
