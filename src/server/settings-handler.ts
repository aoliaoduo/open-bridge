/**
 * Settings actions (orchestration layer, HTTP edition).
 *
 * Direct port of the VS Code settings page's createSettingsMessageHandler:
 * same validation gates, same action set, same one-time-secret semantics.
 * The transport changed — instead of postMessage round-trips the handler
 * returns one structured result per action, which the /api router serializes.
 * Clipboard copies are client-side now: the handler returns the text and the
 * React console writes it to the clipboard itself.
 */

import { state } from "../bridge/state.js";
import { validateNgrokDomain } from "../http/request-policy.js";
import {
  authEnabled,
  authStatus,
  deleteToken,
  mintToken,
  purgeInactiveTokens,
  revokeAllTokens,
  revokeToken,
  rotateToken,
  tokenTtlSeconds,
  usableTokenCount,
  type MintedToken,
} from "../http/auth.js";
import {
  authToggleVerdict,
  normalizeSettingsMessage,
  ttlLabel,
  type SettingsAction,
  type SettingsState,
  type SettingsTokenRow,
} from "../bridge/settings-model.js";
import { CONFIG_DEFAULTS } from "../bridge/config-defaults.js";
import { host } from "../host/host.js";
import { start, stop, rotateRouteToken, startInternal, stopInternal, enqueueLifecycle } from "../bridge/lifecycle.js";

export interface SecretPayload {
  kind: "minted" | "rotated";
  id: string;
  label: string;
  /** Shown exactly once in this response; never stored server-side. */
  secret: string;
  ttl: string;
}

export interface SettingsActionResult {
  ok: boolean;
  /** Fresh page state after the action (the console always re-renders). */
  state: SettingsState;
  info?: string;
  error?: string;
  secret?: SecretPayload;
  /** Text the console should copy to the clipboard itself. */
  copyText?: string;
}

type AuthStatusView = { tokens: SettingsTokenRow[] };

async function authStatusView(): Promise<AuthStatusView> {
  return authStatus();
}

/** Assemble the full page state the console renders from. */
export async function buildSettingsState(): Promise<SettingsState> {
  const status = await authStatusView();
  const cfg = host().config;
  const running = Boolean(state.server);
  return {
    running,
    statusText: running ? (state.sessions.size ? `已连接 · ${state.sessions.size} 个会话` : "已就绪") : "离线",
    publicUrl: state.publicUrl,
    configuredDomain: cfg.get("ngrokDomain", ""),
    authEnabled: authEnabled(),
    defaultTtlSeconds: tokenTtlSeconds(),
    usableCount: await usableTokenCount(),
    deadCount: status.tokens.filter(token => token.revoked || token.expired).length,
    tokens: status.tokens,
    concurrency: {
      enabled: cfg.get("concurrency.enabled", true),
      holdTimeoutMs: cfg.get("concurrency.holdTimeoutMs", 300_000),
      waitTimeoutMs: cfg.get("concurrency.waitTimeoutMs", 120_000),
    },
    config: {
      autoStart: cfg.get("autoStart", CONFIG_DEFAULTS.autoStart as boolean),
      unrestrictedFileAccess: cfg.get("unrestrictedFileAccess", CONFIG_DEFAULTS.unrestrictedFileAccess as boolean),
      allowedDirectories: cfg.get("allowedDirectories", CONFIG_DEFAULTS.allowedDirectories as string[]),
      tunnelProvider: cfg.get("tunnelProvider", CONFIG_DEFAULTS.tunnelProvider as string),
      ngrokExecutable: cfg.get("ngrokExecutable", CONFIG_DEFAULTS.ngrokExecutable as string),
      shellPath: cfg.get("shellPath", CONFIG_DEFAULTS.shellPath as string),
      shellArgs: cfg.get("shellArgs", CONFIG_DEFAULTS.shellArgs as string[]),
      port: cfg.get("port", CONFIG_DEFAULTS.port as number),
      publicHealthTimeoutMs: cfg.get("publicHealthTimeoutMs", CONFIG_DEFAULTS.publicHealthTimeoutMs as number),
      autoReconnect: cfg.get("autoReconnect", CONFIG_DEFAULTS.autoReconnect as boolean),
      ngrokUseHttpProxy: cfg.get("ngrokUseHttpProxy", CONFIG_DEFAULTS.ngrokUseHttpProxy as boolean),
      toolProfile: cfg.get("toolProfile", CONFIG_DEFAULTS.toolProfile as string),
    },
  };
}

function secretPayload(minted: MintedToken, kind: "minted" | "rotated"): SecretPayload {
  return {
    kind,
    id: minted.id,
    label: minted.label,
    secret: minted.secret,
    ttl: ttlLabel(minted.permanent ? 0 : secondsUntil(minted.expires_at)),
  };
}

/** Execute one settings action; returns the structured result for the API response. */
export async function handleSettingsAction(raw: unknown): Promise<SettingsActionResult> {
  const normalized = normalizeSettingsMessage(raw);
  if (!normalized) {
    return { ok: false, state: await buildSettingsState(), error: "无法识别的操作。" };
  }
  const action = normalized;

  try {
    return await dispatch(action);
  } catch (error) {
    return {
      ok: false,
      state: await buildSettingsState().catch(() => fallbackState()),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function dispatch(action: SettingsAction): Promise<SettingsActionResult> {
  const cfg = host().config;
  const done = async (extra: Partial<SettingsActionResult> = {}): Promise<SettingsActionResult> => ({
    ok: true,
    state: await buildSettingsState(),
    ...extra,
  });

  switch (action.command) {
    case "ready":
      return done();

    case "copyUrl": {
      const url = state.publicUrl;
      if (!url) throw new Error("Bridge 未运行，还没有可复制的 URL。");
      return done({ info: "MCP URL 已复制到剪贴板。", copyText: url });
    }

    case "copyText":
      return done({ info: "已复制。", copyText: action.text });

    case "copySecret":
      // The standalone host never retains a pending secret server-side; the
      // console holds the one-time value from the mint/rotate response.
      throw new Error("密钥只在签发响应中返回一次。请使用页面上展示的密钥。");

    case "dismissSecret":
      return done();

    case "start": {
      await start();
      return done();
    }

    case "stop": {
      await stop();
      return done();
    }

    case "rotateEndpoint": {
      await enqueueLifecycle(async () => {
        await rotateRouteToken();
        await stopInternal(false);
        await startInternal();
      });
      return done({ info: "MCP URL 已更新，旧链接立即失效。" });
    }

    case "setConfig": {
      await cfg.update(action.key, action.value);
      return done({ info: "已保存。" });
    }

    case "saveDomain": {
      let domain: string;
      try {
        domain = validateNgrokDomain(action.domain);
      } catch {
        return { ok: false, state: await buildSettingsState(), error: "域名格式不对。示例：my-tunnel.ngrok-free.dev（在你的 ngrok 控制台可以找到）。" };
      }
      await cfg.update("ngrokDomain", domain);
      return done({ info: "ngrok 域名已保存。" });
    }

    case "setAuthEnabled": {
      const verdict = authToggleVerdict(action.enabled, await usableTokenCount());
      if (!verdict.allow) {
        return { ok: false, state: await buildSettingsState(), error: verdict.reason ?? "无法开启鉴权。" };
      }
      await cfg.update("auth.enabled", action.enabled);
      return done({
        info: action.enabled
          ? "鉴权已启用：客户端现在必须携带令牌。"
          : "鉴权已关闭：端点回到仅凭 URL 访问。",
      });
    }

    case "setDefaultTtl": {
      await cfg.update("auth.tokenTtlSeconds", action.seconds);
      return done();
    }

    case "createToken": {
      const minted = await mintToken({ label: action.label, ttlSeconds: action.ttlSeconds });
      return done({ secret: secretPayload(minted, "minted"), copyText: minted.secret });
    }

    case "rotateToken": {
      const rotated = await rotateToken(action.id);
      return done({ secret: secretPayload(rotated, "rotated"), copyText: rotated.secret });
    }

    case "revokeToken": {
      const result = await revokeToken(action.id);
      return done({ info: `已吊销 ${result.revoked.length} 个令牌。` });
    }

    case "deleteToken": {
      await deleteToken(action.id);
      const state_ = await buildSettingsState();
      if (authEnabled() && (await usableTokenCount()) === 0) {
        return {
          ok: true,
          state: state_,
          error: "鉴权仍开启，但已没有任何有效令牌 — 端点正在拒绝所有请求。请新建令牌，或关闭鉴权开关。",
        };
      }
      return { ok: true, state: state_, info: "令牌已删除。" };
    }

    case "purgeTokens": {
      const result = await purgeInactiveTokens();
      return done({ info: `已清理 ${result.deleted.length} 个失效令牌。` });
    }

    case "revokeAll": {
      const result = await revokeAllTokens();
      return done({
        info: authEnabled()
          ? `已吊销 ${result.revoked.length} 个令牌。端点现在拒绝所有请求，请新建令牌。`
          : `已吊销 ${result.revoked.length} 个令牌。`,
      });
    }

    case "setConcurrency": {
      await cfg.update("concurrency.enabled", action.enabled);
      await cfg.update("concurrency.holdTimeoutMs", action.holdTimeoutMs);
      await cfg.update("concurrency.waitTimeoutMs", action.waitTimeoutMs);
      return done({ info: "并发设置已保存。" });
    }
  }
}

function fallbackState(): SettingsState {
  return {
    running: Boolean(state.server),
    statusText: "错误",
    publicUrl: state.publicUrl,
    configuredDomain: "",
    authEnabled: false,
    defaultTtlSeconds: 0,
    usableCount: 0,
    deadCount: 0,
    tokens: [],
    concurrency: { enabled: true, holdTimeoutMs: 300_000, waitTimeoutMs: 120_000 },
    config: {
      autoStart: false,
      unrestrictedFileAccess: true,
      allowedDirectories: [],
      tunnelProvider: "ngrok",
      ngrokExecutable: "ngrok",
      shellPath: "",
      shellArgs: [],
      port: 0,
      publicHealthTimeoutMs: 20_000,
      autoReconnect: true,
      ngrokUseHttpProxy: true,
      toolProfile: "full",
    },
  };
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
}
