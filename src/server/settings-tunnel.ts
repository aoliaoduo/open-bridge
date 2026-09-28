import { CONFIG_DEFAULTS } from "../bridge/config/config-defaults.js";
import type { SettingsTunnelView } from "../bridge/config/settings-model.js";
import { detectTunnelFacts, readNgrokConfigAuthtoken } from "../bridge/tunnel/tunnel-detect.js";
import { planTunnelAutoConfig } from "../bridge/tunnel/tunnel-plan.js";
import { NGROK_AUTHTOKEN_KEY, setCachedAuthtoken } from "../bridge/tunnel/ngrok-runtime.js";
import { restartTunnelForProviderChange } from "../bridge/lifecycle/lifecycle.js";
import { state } from "../bridge/state.js";
import { host } from "../host/host.js";

const TUNNEL_FACTS_TTL_MS = 60_000;
let tunnelFactsCache: { at: number; facts: Awaited<ReturnType<typeof detectTunnelFacts>> } | null = null;

export interface TunnelConfigureOutcome {
  ok: boolean;
  info?: string;
  error?: string;
}

/** The saved ngrok authtoken, or "". Never returned to the console. */
async function storedAuthtoken(): Promise<string> {
  return ((await host().secrets.get(NGROK_AUTHTOKEN_KEY).catch(() => "")) ?? "").trim();
}

/**
 * Expensive tunnel reconnaissance is cached for a minute.
 *
 * A settings page render must stay cheap: this path can spawn tailscale CLIs and
 * call ngrok's API, so only /api/tunnel, explicit re-detect and auto-config use
 * it. A failed probe is cached too; repeatedly hammering a broken dependency is
 * not a better user experience.
 */
async function tunnelFacts(force = false) {
  if (!force && tunnelFactsCache && Date.now() - tunnelFactsCache.at < TUNNEL_FACTS_TTL_MS) {
    return tunnelFactsCache.facts;
  }
  const cfg = host().config;
  const facts = await detectTunnelFacts({
    ngrokExecutable: String(cfg.get("ngrokExecutable", CONFIG_DEFAULTS.ngrokExecutable) ?? ""),
    tailscaleExecutable: String(cfg.get("tailscaleExecutable", CONFIG_DEFAULTS.tailscaleExecutable) ?? ""),
    storedAuthtoken: await storedAuthtoken(),
  });
  tunnelFactsCache = { at: Date.now(), facts };
  return facts;
}

/** Read-only tunnel facts plus the exact auto-configuration plan shown in UI. */
export async function buildTunnelView(force = false): Promise<SettingsTunnelView> {
  const cfg = host().config;
  const facts = await tunnelFacts(force);
  return {
    facts,
    plan: planTunnelAutoConfig({
      provider: String(cfg.get("tunnelProvider", CONFIG_DEFAULTS.tunnelProvider) ?? ""),
      current: {
        ngrokExecutable: String(cfg.get("ngrokExecutable", "") ?? ""),
        ngrokDomain: String(cfg.get("ngrokDomain", "") ?? ""),
        tailscaleExecutable: String(cfg.get("tailscaleExecutable", "") ?? ""),
      },
      authtokenStored: Boolean(await storedAuthtoken()),
      facts,
    }),
  };
}

/**
 * Execute the plan the tunnel page displayed.
 *
 * This returns only the tunnel-domain outcome; settings-handler owns the common
 * SettingsActionResult wrapper so this module does not depend back on the page
 * state builder.
 */
export async function autoConfigureTunnel(): Promise<TunnelConfigureOutcome> {
  const cfg = host().config;
  const view = await buildTunnelView(true);
  const written: string[] = [];

  for (const write of view.plan.writes) {
    if (write.kind === "secret") {
      // The plan carries only the fact that a secret can be imported, never the
      // credential itself. Read it again at execution time and keep it server-side.
      const imported = readNgrokConfigAuthtoken()?.token ?? "";
      if (!imported) continue;
      await host().secrets.store(NGROK_AUTHTOKEN_KEY, imported);
      setCachedAuthtoken(imported);
      written.push(write.label);
      continue;
    }
    await cfg.update(write.key, write.value);
    written.push(write.label);
  }

  // Pick the new values up immediately without changing the operator-facing
  // convenience of a live tunnel.
  if (written.length && state.tunnel) void restartTunnelForProviderChange();

  const detail = [
    written.length ? "已写入：" + written.join("；") + "。" : "",
    view.plan.keep.length ? "保持不变：" + view.plan.keep.join("；") + "。" : "",
    ...view.plan.notes,
  ].filter(Boolean).join(" ");

  if (!written.length) {
    return view.plan.blocked
      ? { ok: false, error: view.plan.blocked }
      : { ok: true, info: detail || "没有需要写入的值：这一项已经配好了。" };
  }

  return {
    ok: true,
    info: view.plan.blocked ? detail + " 还差一步：" + view.plan.blocked : detail,
  };
}
