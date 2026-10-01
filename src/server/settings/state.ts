import { clientMcpUrl } from "../../bridge/endpoint.js";
import { state } from "../../bridge/runtime-state.js";
import {
  authEnabled,
  authStatus,
  tokenTtlSeconds,
  usableTokenCount,
  type MintedToken,
} from "../../http/auth.js";
import type {
  SecretPayload,
  SettingsActionResult,
  SettingsDetectedView,
  SettingsState,
  SettingsTokenRow,
} from "../../bridge/config/settings-model.js";
import { CONFIG_DEFAULTS } from "../../bridge/config/config-defaults.js";
import { settingsConfigFrom } from "../../bridge/config/config-spec.js";
import { detectShells } from "../../shell/shell-provider.js";
import { detectNgrok } from "../../bridge/tunnel/ngrok-locate.js";
import { NGROK_AUTHTOKEN_KEY } from "../../bridge/tunnel/ngrok-runtime.js";
import { maskBarkKey } from "../../bridge/config/config-values.js";
import { resolveNotifySettings } from "../../bridge/tools/notify.js";
import { host } from "../../host/host.js";

type AuthStatusView = { tokens: SettingsTokenRow[] };

export async function buildSettingsState(): Promise<SettingsState> {
  const status: AuthStatusView = await authStatus();
  const cfg = host().config;
  const running = Boolean(state.server);
  return {
    running,
    version: host().version(),
    status: running
      ? state.sessions.size
        ? { kind: "connected", sessions: state.sessions.size }
        : state.modernInFlight > 0
          ? { kind: "active" }
          : { kind: "ready" }
      : { kind: "offline" },
    mcpUrl: clientMcpUrl(),
    configuredDomain: cfg.get("ngrokDomain", ""),
    ngrokAuthtokenMask: maskBarkKey((await host().secrets.get(NGROK_AUTHTOKEN_KEY).catch(() => "")) ?? ""),
    authEnabled: authEnabled(),
    defaultTtlSeconds: tokenTtlSeconds(),
    usableCount: await usableTokenCount(),
    deadCount: status.tokens.filter(token => token.revoked || token.expired).length,
    tokens: status.tokens,
    concurrency: {
      enabled: cfg.get("concurrency.enabled", true),
      holdTimeoutMs: cfg.get("concurrency.holdTimeoutMs", CONFIG_DEFAULTS["concurrency.holdTimeoutMs"] as number),
      waitTimeoutMs: cfg.get("concurrency.waitTimeoutMs", CONFIG_DEFAULTS["concurrency.waitTimeoutMs"] as number),
    },
    config: settingsConfigFrom((key, fallback) => cfg.get(key, fallback)),
    notify: notifyView(),
    detected: detectedView(),
  };
}

function detectedView(): SettingsDetectedView {
  try {
    return { shells: detectShells(), ngrok: detectNgrok() };
  } catch {
    return { shells: [], ngrok: [] };
  }
}

function notifyView() {
  const settings = resolveNotifySettings();
  return {
    enabled: settings.enabled,
    configured: Boolean(settings.key),
    keyMask: maskBarkKey(settings.key),
    serverUrl: settings.serverUrl,
  };
}

export function secretPayload(minted: MintedToken, kind: "minted" | "rotated"): SecretPayload {
  return {
    kind,
    id: minted.id,
    label: minted.label,
    secret: minted.secret,
    ttl_seconds: minted.permanent ? 0 : secondsUntil(minted.expires_at),
  };
}

export async function settingsSuccess(
  extra: Partial<SettingsActionResult> = {},
): Promise<SettingsActionResult> {
  return { ok: true, state: await buildSettingsState(), ...extra };
}

export function fallbackSettingsState(): SettingsState {
  return {
    running: Boolean(state.server),
    version: host().version(),
    status: { kind: "error" },
    mcpUrl: clientMcpUrl(),
    configuredDomain: "",
    ngrokAuthtokenMask: "",
    authEnabled: false,
    defaultTtlSeconds: 0,
    usableCount: 0,
    deadCount: 0,
    tokens: [],
    concurrency: {
      enabled: CONFIG_DEFAULTS["concurrency.enabled"] as boolean,
      holdTimeoutMs: CONFIG_DEFAULTS["concurrency.holdTimeoutMs"] as number,
      waitTimeoutMs: CONFIG_DEFAULTS["concurrency.waitTimeoutMs"] as number,
    },
    config: settingsConfigFrom((_key, value) => (Array.isArray(value) ? [...value] : value)),
    detected: detectedView(),
    notify: {
      enabled: CONFIG_DEFAULTS["notify.enabled"] as boolean,
      configured: false,
      keyMask: "",
      serverUrl: CONFIG_DEFAULTS["notify.serverUrl"] as string,
    },
  };
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
}
