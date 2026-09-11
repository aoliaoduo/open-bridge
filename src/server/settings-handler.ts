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

import { clientMcpUrl, state } from "../bridge/state.js";
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
  type SecretPayload,
  type SettingsAction,
  type SettingsActionResult,
  type SettingsState,
  type SettingsTokenRow,
} from "../bridge/settings-model.js";
import { CONFIG_DEFAULTS } from "../bridge/config-defaults.js";
import { resetUsageStats } from "../bridge/usage-store.js";
import { host } from "../host/host.js";
import {
  start, rotateRouteToken, enqueueLifecycle, webAiPrompt, runHealthCheck, republishAfterRotate,
} from "../bridge/lifecycle.js";

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
    mcpUrl: clientMcpUrl(),
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
      unrestrictedFileAccess: cfg.get("unrestrictedFileAccess", CONFIG_DEFAULTS.unrestrictedFileAccess as boolean),
      allowedDirectories: cfg.get("allowedDirectories", CONFIG_DEFAULTS.allowedDirectories as string[]),
      tunnelProvider: cfg.get("tunnelProvider", CONFIG_DEFAULTS.tunnelProvider as string),
      ngrokExecutable: cfg.get("ngrokExecutable", CONFIG_DEFAULTS.ngrokExecutable as string),
      logMaxBytes: cfg.get("logMaxBytes", CONFIG_DEFAULTS.logMaxBytes as number),
      shellPath: cfg.get("shellPath", CONFIG_DEFAULTS.shellPath as string),
      shellArgs: cfg.get("shellArgs", CONFIG_DEFAULTS.shellArgs as string[]),
      port: cfg.get("port", CONFIG_DEFAULTS.port as number),
      publicHealthTimeoutMs: cfg.get("publicHealthTimeoutMs", CONFIG_DEFAULTS.publicHealthTimeoutMs as number),
      autoReconnect: cfg.get("autoReconnect", CONFIG_DEFAULTS.autoReconnect as boolean),
      ngrokUseHttpProxy: cfg.get("ngrokUseHttpProxy", CONFIG_DEFAULTS.ngrokUseHttpProxy as boolean),
      toolProfile: cfg.get("toolProfile", CONFIG_DEFAULTS.toolProfile as string),
      "oauth.enabled": cfg.get("oauth.enabled", CONFIG_DEFAULTS["oauth.enabled"] as boolean),
      "oauth.allowedRedirectHosts": cfg.get("oauth.allowedRedirectHosts", CONFIG_DEFAULTS["oauth.allowedRedirectHosts"] as string[]),
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

    case "clearStats": {
      // The counters are cumulative and were previously un-resettable: the
      // implementation existed (usage-store.resetUsageStats) but nothing could
      // reach it - the VS Code command never got a console equivalent here.
      // Operator-only, exactly like the extension's.
      resetUsageStats();
      return done({ info: "调用统计已清零（累计调用数与按工具明细）。" });
    }
    case "healthCheck": {
      // End-to-end proof that the instance is what it claims: the loopback
      // endpoint answers, the advertised tunnel answers, and - with the bearer
      // gate on - an anonymous request is really refused.
      const report = await runHealthCheck();
      return done({ info: report.summary, healthLines: report.details, healthOk: report.ok });
    }
    case "copyUrl": {
      const url = clientMcpUrl();
      if (!url) throw new Error("Bridge 未运行，还没有可复制的 URL。");
      return done({
        info: state.tunnelUrl
          ? "MCP URL 已复制到剪贴板。"
          : "MCP URL 已复制到剪贴板（当前仅本机可访问，未开启隧道）。",
        copyText: url,
      });
    }

    case "copyPrompt": {
      // Onboarding: hand the client a ready-made opening message carrying the
      // URL (and, when the bearer gate is on, how to authenticate), instead of
      // leaving the user to write one from scratch. The toast repeats the
      // prompt's own caveat when the URL is loopback-only: the text and the
      // toast must never disagree about whether the address is reachable.
      return done({
        info: state.tunnelUrl
          ? "接入提示词已复制，粘贴给 AI 客户端即可。"
          : "接入提示词已复制 —— 但当前未开启隧道，里面的地址只有本机能访问；"
            + "外部客户端请先在「设置」页填写 ngrokDomain 并开启隧道，再重新复制。",
        copyText: webAiPrompt(),
      });
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
      // Describe the outcome instead of awaiting it: stopping closes the
      // listener that carries this response, so the router performs it once the
      // response is on the wire (see SettingsActionResult.deferStop). The state
      // is therefore composed here rather than read back after the fact.
      const before = await buildSettingsState();
      return {
        ok: true,
        state: { ...before, running: false, statusText: "已停止", mcpUrl: "" },
        info: "Bridge 已停止：本地服务关闭、端口释放，这个控制台也随之失效。重新启动请运行 open-bridge serve。",
        deferStop: true,
      };
    }

    case "rotateEndpoint": {
      // Flip the token — an in-process assignment, no socket teardown: every
      // route compares state.routeToken per request — and then re-point the
      // surfaces that carried the old one. The listener is deliberately NOT
      // rebound; that only interrupted traffic and relaunched the tunnel for no
      // gain. The page's injected console token is stale now, hence
      // reloadRequired: without the reload every later action would 403.
      await enqueueLifecycle(async () => { await rotateRouteToken(); });
      await republishAfterRotate();
      return {
        ...(await done({ info: "MCP URL 已更新，旧链接立即失效。控制台正在重新加载。" })),
        reloadRequired: true,
      };
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

    case "armPublicLock": {
      // 「一键开启第二道锁」: the operator sees the risk (public-open, no bearer
      // gate) on 体检 and wants it closed without a trip to 令牌 to mint, copy,
      // and then flip a switch on the same page.
      //
      // Order is not cosmetic: the gate is fail-closed, so enabling it with zero
      // usable tokens would refuse every client. Mint first, enable second, and
      // if enabling fails, delete the token minted for it — a stray secret with
      // no lock behind it is worse than nothing.
      if (authEnabled()) {
        return done({ info: "第二道锁本来就已经开着：/mcp 要求 Bearer 令牌。" });
      }
      const existing = await usableTokenCount();
      let secret: SecretPayload | undefined;
      let mintedId: string | undefined;
      if (existing === 0) {
        // A second token would just be one more thing to lose; reuse is the
        // point of a one-step action.
        const minted = await mintToken({
          label: action.label || "public-lock",
          ttlSeconds: action.ttlSeconds ?? tokenTtlSeconds(),
        });
        mintedId = minted.id;
        secret = secretPayload(minted, "minted");
      }
      try {
        await cfg.update("auth.enabled", true);
      } catch (error) {
        if (mintedId) await deleteToken(mintedId).catch(() => undefined);
        throw error;
      }
      return done({
        secret,
        copyText: secret?.secret,
        info: secret
          ? "第二道锁已开启：已签发 1 个令牌并启用 Bearer 鉴权，客户端必须在请求头带 Authorization: Bearer <令牌>。"
            + "只填 URL 的客户端（例如 ChatGPT 连接器）会立刻连不上；要恢复就在「令牌」页关掉那个开关。"
          : `第二道锁已开启：复用了现有的 ${existing} 个有效令牌，客户端现在必须携带令牌（只填 URL 会连不上）。`,
      });
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
    mcpUrl: clientMcpUrl(),
    configuredDomain: "",
    authEnabled: false,
    defaultTtlSeconds: 0,
    usableCount: 0,
    deadCount: 0,
    tokens: [],
    concurrency: { enabled: true, holdTimeoutMs: 300_000, waitTimeoutMs: 120_000 },
    config: {
      unrestrictedFileAccess: true,
      allowedDirectories: [],
      tunnelProvider: "ngrok",
      ngrokExecutable: "ngrok",
      logMaxBytes: CONFIG_DEFAULTS.logMaxBytes as number,
      shellPath: "",
      shellArgs: [],
      port: 0,
      publicHealthTimeoutMs: 20_000,
      autoReconnect: true,
      ngrokUseHttpProxy: true,
      toolProfile: "full",
      "oauth.enabled": CONFIG_DEFAULTS["oauth.enabled"] as boolean,
      "oauth.allowedRedirectHosts": CONFIG_DEFAULTS["oauth.allowedRedirectHosts"] as string[],
    },
  };
}

function secondsUntil(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
}
