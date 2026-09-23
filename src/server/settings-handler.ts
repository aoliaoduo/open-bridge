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
  type SettingsConfigView,
  type SettingsDetectedView,
  type SettingsState,
  type SettingsTunnelView,
  type SettingsTokenRow,
} from "../bridge/config/settings-model.js";
import { CONFIG_DEFAULTS } from "../bridge/config/config-defaults.js";
import { detectShells } from "../shell/shell-provider.js";
import { detectNgrok } from "../bridge/tunnel/ngrok-locate.js";
import { detectTunnelFacts, readNgrokConfigAuthtoken } from "../bridge/tunnel/tunnel-detect.js";
import { planTunnelAutoConfig } from "../bridge/tunnel/tunnel-plan.js";
import { NGROK_AUTHTOKEN_KEY, setCachedAuthtoken } from "../bridge/tunnel/tunnel.js";
import { playAlertSound, stopAlertSound } from "../bridge/tools/sound-alert.js";
import { existsSync } from "node:fs";
import { maskBarkKey, validateConfigValue } from "../bridge/config/config-values.js";
import { NOTIFY_DEFAULT_TITLE, pushNotification, resolveNotifySettings, type NotifyOutcome } from "../bridge/tools/notify.js";
import * as path from "node:path";
import { resetUsageStats } from "../bridge/usage-store.js";
import { host } from "../host/host.js";
import {
  start, rotateRouteToken, webAiPrompt, republishAfterRotate, restartTunnelForProviderChange,
} from "../bridge/lifecycle/lifecycle.js";
import { enqueueLifecycle } from "../bridge/lifecycle/lifecycle-queue.js";

type AuthStatusView = { tokens: SettingsTokenRow[] };

/**
 * The config keys the settings page shows, in page order, each with the
 * fallback value both readers share: buildSettingsState passes it to `cfg.get`
 * as the when-unset default, and fallbackState (the view built when the live
 * read fails) starts from it verbatim. Adding a config key to the page means
 * adding one entry here instead of editing two parallel lists.
 */
const SETTINGS_CONFIG_FALLBACKS = [
  ["unrestrictedFileAccess", CONFIG_DEFAULTS.unrestrictedFileAccess as boolean],
  ["allowedDirectories", CONFIG_DEFAULTS.allowedDirectories as string[]],
  ["tunnelProvider", CONFIG_DEFAULTS.tunnelProvider as string],
  ["ngrokExecutable", CONFIG_DEFAULTS.ngrokExecutable as string],
  ["logMaxBytes", CONFIG_DEFAULTS.logMaxBytes as number],
  ["sound.enabled", false],
  ["sound.fileWaiting", ""],
  ["sound.fileFinished", ""],
  ["shellPath", CONFIG_DEFAULTS.shellPath as string],
  ["shellArgs", CONFIG_DEFAULTS.shellArgs as string[]],
  ["tailscaleDomain", CONFIG_DEFAULTS.tailscaleDomain as string],
  ["tailscaleExecutable", CONFIG_DEFAULTS.tailscaleExecutable as string],
  ["port", CONFIG_DEFAULTS.port as number],
  ["publicHealthTimeoutMs", CONFIG_DEFAULTS.publicHealthTimeoutMs as number],
  ["autoReconnect", CONFIG_DEFAULTS.autoReconnect as boolean],
  ["ngrokUseHttpProxy", CONFIG_DEFAULTS.ngrokUseHttpProxy as boolean],
  ["toolProfile", CONFIG_DEFAULTS.toolProfile as string],
  ["oauth.enabled", CONFIG_DEFAULTS["oauth.enabled"] as boolean],
  ["oauth.allowedRedirectHosts", CONFIG_DEFAULTS["oauth.allowedRedirectHosts"] as string[]],
] as const;

/**
 * Walk the shared key list once with one reader. `Object.fromEntries` yields
 * an index-signature record TS cannot link back to `SettingsConfigView` (an
 * interface carries no implicit index signature), so the single staged cast
 * the compiler asks for lives here instead of at each call site; the pair
 * list above is what actually pins the keys, their order and the fallbacks.
 */
function settingsConfigOf(read: (key: string, fallback: unknown) => unknown): SettingsConfigView {
  return Object.fromEntries(
    SETTINGS_CONFIG_FALLBACKS.map(([key, fallback]) => [key, read(key, fallback)]),
  ) as unknown as SettingsConfigView;
}

/** Assemble the full page state the console renders from. */
export async function buildSettingsState(): Promise<SettingsState> {
  // Narrowed to the rows the page renders; the rest of authStatus's shape is
  // an internal detail of the auth module.
  const status: AuthStatusView = await authStatus();
  const cfg = host().config;
  const running = Boolean(state.server);
  return {
    running,
    version: host().version(),
    statusText: running ? (state.sessions.size ? `已连接 · ${state.sessions.size} 个会话` : "已就绪") : "离线",
    mcpUrl: clientMcpUrl(),
    configuredDomain: cfg.get("ngrokDomain", ""),
    // Only whether one is stored and a masked hint -- never the token. The
    // console has to be able to say "configured" without being able to leak it.
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
    // One computed object, not a restatement of the key list above: the list
    // is the single source, so the key order — and with it the JSON the
    // console receives — is decided in exactly one place.
    config: settingsConfigOf((key, fallback) => cfg.get(key, fallback)),
    notify: notifyView(),
    detected: detectedView(),
  };
}

/**
 * Probe for the executables the two "type a path here" settings need.
 *
 * Done on every state read rather than cached at startup: this is a handful of
 * existsSync calls, and an operator who installs ngrok specifically because
 * the page told them it was missing should see it appear on reload rather than
 * after a restart. Failures collapse to empty lists — detection is a
 * convenience, and the free-text input behind it still works.
 */
function detectedView(): SettingsDetectedView {
  try {
    return { shells: detectShells(), ngrok: detectNgrok() };
  } catch {
    return { shells: [], ngrok: [] };
  }
}

/**
 * Tunnel facts, cached for a minute.
 *
 * Producing them spawns two tailscale CLI calls and, when a token exists, asks
 * ngrok's API — far too much work for every page read, and none of it goes
 * stale fast enough to matter. The cache is what keeps the tunnel card cheap:
 * the page itself renders from config (no probe), the card fills in from
 * GET /api/tunnel, and only 「重新检测」 and the auto-config click force a fresh
 * probe. A failed probe is cached as its own empty answer rather than retried
 * in a loop — the card says "未检测到" and the free-text fallback still works.
 */
const TUNNEL_FACTS_TTL_MS = 60_000;
let tunnelFactsCache: { at: number; facts: Awaited<ReturnType<typeof detectTunnelFacts>> } | null = null;

/** The saved ngrok authtoken, or "". Never returned to the console. */
async function storedAuthtoken(): Promise<string> {
  return ((await host().secrets.get(NGROK_AUTHTOKEN_KEY).catch(() => "")) ?? "").trim();
}

async function tunnelFacts(force = false) {
  if (!force && tunnelFactsCache && Date.now() - tunnelFactsCache.at < TUNNEL_FACTS_TTL_MS) {
    return tunnelFactsCache.facts;
  }
  const cfg = host().config;
  const facts = await detectTunnelFacts({
    ngrokExecutable: String(cfg.get("ngrokExecutable", CONFIG_DEFAULTS.ngrokExecutable as string) ?? ""),
    tailscaleExecutable: String(cfg.get("tailscaleExecutable", CONFIG_DEFAULTS.tailscaleExecutable as string) ?? ""),
    storedAuthtoken: await storedAuthtoken(),
  });
  tunnelFactsCache = { at: Date.now(), facts };
  return facts;
}

/**
 * What `GET /api/tunnel` answers with — and the exact plan the 「自动配置」
 * button executes: one function, so what the page promises before the click and
 * what the server does after it cannot drift apart.
 */
export async function buildTunnelView(force = false): Promise<SettingsTunnelView> {
  const cfg = host().config;
  const facts = await tunnelFacts(force);
  return {
    facts,
    plan: planTunnelAutoConfig({
      provider: String(cfg.get("tunnelProvider", CONFIG_DEFAULTS.tunnelProvider as string) ?? ""),
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
 * The masked notification view — resolve through the SAME reader the send path
 * uses, so what the page shows and what actually pushes cannot disagree (a
 * garbage hand-edited key means "not configured" in both places).
 */
function notifyView() {
  const settings = resolveNotifySettings();
  return {
    enabled: settings.enabled,
    configured: Boolean(settings.key),
    keyMask: maskBarkKey(settings.key),
    serverUrl: settings.serverUrl,
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

/**
 * The shared success shape: one fresh state read plus the action's extras.
 * `dispatch` binds this as its `done`; the case bodies extracted into their own
 * functions below call it directly, so every success reply keeps the exact
 * same field construction.
 */
async function successWith(extra: Partial<SettingsActionResult> = {}): Promise<SettingsActionResult> {
  return { ok: true, state: await buildSettingsState(), ...extra };
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
  const done = successWith;

  switch (action.command) {
    case "clearStats": {
      // The counters are cumulative and were previously un-resettable: the
      // implementation existed (usage-store.resetUsageStats) but nothing could
      // reach it - the VS Code command never got a console equivalent here.
      // Operator-only, exactly like the extension's.
      resetUsageStats();
      return done({ info: "调用统计已清零（累计调用数与按工具明细）。" });
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
      // Mirror the MCP write path: stored directories are resolved, so both
      // entries persist the same canonical form (reads resolve again anyway).
      const value =
        action.key === "allowedDirectories" && Array.isArray(action.value)
          ? (action.value as string[]).map(item => path.resolve(item))
          : action.value;
      const previousProvider = String(cfg.get("tunnelProvider", CONFIG_DEFAULTS.tunnelProvider as string));
      await cfg.update(action.key, value);
      // A provider switch must take effect on the RUNNING tunnel, not just on
      // the next restart: the old behavior left ngrok serving after a switch
      // to tailscale (and vice versa), with status advertising the URL of a
      // provider the operator had already left. The new provider was already
      // persisted above, so the rebuild reads it back.
      if (action.key === "tunnelProvider" && typeof value === "string" && value !== previousProvider) {
        void restartTunnelForProviderChange();
        return done({ info: `隧道提供商已切换为 ${value}，正在按新渠道重建隧道。` });
      }
      return done({ info: "已保存。" });
    }

    case "saveDomain": {
      let domain: string;
      try {
        // Clearing is this action's explicit opt-out, not a valid hostname.
        domain = action.domain === "" ? "" : validateNgrokDomain(action.domain);
      } catch {
        return { ok: false, state: await buildSettingsState(), error: "域名格式不对。示例：my-tunnel.ngrok-free.dev（在你的 ngrok 控制台可以找到）。" };
      }
      await cfg.update("ngrokDomain", domain);
      return done({ info: domain ? "ngrok 域名已保存。" : "ngrok 域名已清除；未配置域名时仅本机可用。此操作不停止当前隧道。" });
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
          : "Bearer 门禁已关闭：只填 URL 即可访问。",
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

    case "armPublicLock":
      return armPublicLockAction(action);

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

    case "saveNotifyKey": {
      // The value arrives exactly as pasted; validateConfigValue owns BOTH the
      // grammar and the full-URL → bare-key parsing, shared with the MCP write
      // path so the two entries cannot drift. "" clears the channel.
      const checked = validateConfigValue("notify.barkKey", action.key);
      if (!checked.ok) {
        return { ok: false, state: await buildSettingsState(), error: checked.error };
      }
      await cfg.update("notify.barkKey", checked.value);
      const stored = checked.value as string;
      if (!stored) return done({ info: "设备密钥已清除：推送停用（开关保持原样）。" });
      const extracted = action.key.includes("/") || action.key.includes(":");
      return done({
        info: extracted
          ? `设备密钥已保存（已从链接中摘出：${maskBarkKey(stored)}）。点「发送测试」验证手机。`
          : `设备密钥已保存（${maskBarkKey(stored)}）。点「发送测试」验证手机。`,
      });
    }

    case "testSound": {
      const key = action.which === "finished" ? "sound.fileFinished" : "sound.fileWaiting";
      const file = String(cfg.get<string>(key, "") ?? "").trim();
      if (!file) return { ok: false, state: await buildSettingsState(), error: "这一项还没有设置音频文件。" };
      // Plays regardless of sound.enabled: the operator pressing this button
      // is asking "does this file work", not "would this fire right now".
      // Same reasoning as the Bark test button bypassing the event switches.
      if (!existsSync(file)) {
        return { ok: false, state: await buildSettingsState(), error: `文件不存在：${file}` };
      }
      const result = playAlertSound(file);
      return result.played
        ? done({ info: "已弹出播放窗口，关闭它即停止。没听到就检查系统音量和默认输出设备。" })
        : { ok: false, state: await buildSettingsState(), error: `播放失败：${result.reason}` };
    }

    case "stopSound": {
      // Always reports success: "stop" on silence is not an error, it is the
      // state the operator was asking for.
      const stopped = stopAlertSound();
      return done({ info: stopped ? "已停止。" : "当前没有在播放。" });
    }

    case "saveNgrokAuthtoken": {
      // Stored in the secret store, never in config.json: this is an account
      // credential, and config.json is plain text the operator may well paste
      // into an issue when asking for help.
      const raw = typeof action.token === "string" ? action.token.trim() : "";
      if (!raw) {
        await host().secrets.store(NGROK_AUTHTOKEN_KEY, "");
        setCachedAuthtoken("");
        return done({ info: "Authtoken 已清除。ngrok 会改用它自己配置文件里的凭据（如果配过）。" });
      }
      // ngrok tokens are base64-ish with an underscore separating the two
      // halves. Checking the shape turns "the tunnel will not start" into
      // "that does not look like an authtoken", which is the difference
      // between a five-minute and a five-hour debugging session.
      if (raw.length < 20 || /\s/.test(raw)) {
        return {
          ok: false,
          state: await buildSettingsState(),
          error: "这不像一个 ngrok authtoken：应该是一长串不含空格的字符，在 ngrok 控制台的 Your Authtoken 页面复制。",
        };
      }
      await host().secrets.store(NGROK_AUTHTOKEN_KEY, raw);
      setCachedAuthtoken(raw);
      return done({
        // Deliberately not naming a console button: the status page explains
        // why there is no start/stop/restart there (stopping would take the
        // page down with it). The instance is owned by its terminal window,
        // so that is the honest instruction.
        info: `Authtoken 已保存（${maskBarkKey(raw)}）。下次启动隧道时生效：关掉承载本实例的终端窗口再重新启动（一键启动脚本双击一次即可）。`,
      });
    }

    case "autoConfigureTunnel":
      return autoConfigureTunnelAction();

    case "refreshTunnelDetect": {
      // The operator installed ngrok (or enabled Funnel) and does not want to
      // wait out the cache, let alone restart the instance.
      await buildTunnelView(true);
      return done({ info: "已重新检测本机的隧道环境。" });
    }

    case "testNotify": {
      // A deliberate button press is a new diagnostic request, so it bypasses
      // the automatic one-alert episode latch and tests only the phone channel.
      const result = await pushNotification(
        resolveNotifySettings(),
        "waiting",
        NOTIFY_DEFAULT_TITLE,
        "Open Bridge 测试通知：配置已生效。实际提醒只会在等待回答或对话结束时发送一次。",
        Date.now(),
        // 人手动作绕过账本（重新按一次是因为没听见），并用时效性等级让
        // 测试推送在专注模式下也可见——收不到测试是排查的第一现场。
        // silentLocally: this button tests the phone. Letting it also play the
        // desktop sound would mean a operator pressing it gets a music player
        // they did not ask for, and cannot tell which channel actually worked.
        { bypassEpisode: true, silentLocally: true },
      );
      return notifyActionVerdict(result, await buildSettingsState());
    }
  }
  // Exhaustiveness, and a better guard than the no-op `ready` case that used
  // to make this function fall through to a return by accident: adding a
  // command to the allowlist without handling it here is now a type error,
  // not a silently-undefined response.
  return assertHandled(action);
}

function assertHandled(action: never): never {
  throw new Error(`Unhandled console action: ${JSON.stringify(action)}`);
}

/**
 * 「签发令牌并启用门禁」: the operator sees the risk (public-open, no bearer
 * gate) on 体检 and wants it closed without a trip to 令牌 to mint, copy,
 * and then flip a switch on the same page.
 *
 * Order is not cosmetic: the gate is fail-closed, so enabling it with zero
 * usable tokens would refuse every client. Mint first, enable second, and
 * if enabling fails, delete the token minted for it — a stray secret with
 * no lock behind it is worse than nothing.
 */
async function armPublicLockAction(
  action: Extract<SettingsAction, { command: "armPublicLock" }>,
): Promise<SettingsActionResult> {
  const cfg = host().config;
  if (authEnabled()) {
    return successWith({ info: "Bearer 门禁本来就已经开着：/mcp 要求 Bearer 令牌。" });
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
  return successWith({
    secret,
    copyText: secret?.secret,
    info: secret
      ? "Bearer 门禁已启用：已签发 1 个令牌并打开门禁，客户端必须在请求头带 Authorization: Bearer <令牌>。"
        + "只填 URL 的客户端（例如 ChatGPT 连接器）会立刻连不上；要恢复就在「安全」页关掉那个开关。"
      : `Bearer 门禁已启用：复用了现有的 ${existing} 个有效令牌，客户端现在必须携带令牌（只填 URL 会连不上）。`,
  });
}

/**
 * The one action that writes several values at once, so it writes exactly
 * what the page showed: buildTunnelView re-reads the LIVE config and the
 * plan only ever fills fields that are still empty, which is what makes
 * the button safe to press for someone who already typed a path.
 */
async function autoConfigureTunnelAction(): Promise<SettingsActionResult> {
  const cfg = host().config;
  const view = await buildTunnelView(true);
  const written: string[] = [];
  for (const write of view.plan.writes) {
    if (write.kind === "secret") {
      // Imported here rather than carried in the plan: the plan is rendered
      // in a browser, and an authtoken must not travel to one.
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
  // A running tunnel has to pick the new values up now, not at the next
  // restart — the same rebuild a provider switch performs.
  if (written.length && state.tunnel) void restartTunnelForProviderChange();

  const detail = [
    written.length ? `已写入：${written.join("；")}。` : "",
    view.plan.keep.length ? `保持不变：${view.plan.keep.join("；")}。` : "",
    ...view.plan.notes,
  ].filter(Boolean).join(" ");
  if (!written.length) {
    // Nothing to write is only a success when there is also nothing to fix.
    return view.plan.blocked
      ? { ok: false, state: await buildSettingsState(), error: view.plan.blocked }
      : successWith({ info: detail || "没有需要写入的值：这一项已经配好了。" });
  }
  return successWith({ info: view.plan.blocked ? `${detail} 还差一步：${view.plan.blocked}` : detail });
}

/** Map a push outcome onto the console's ok/info/error shape. */
function notifyActionVerdict(result: NotifyOutcome, freshState: SettingsState): SettingsActionResult {
  if (result.delivered) {
    return { ok: true, state: freshState, info: "测试通知已发出 — 手机该响了。没收到就检查 Bark App 与网络连接。" };
  }
  const why: Record<string, string> = {
    disabled: "通知开关是关的：先打开本页的「启用通知」。",
    no_key: "还没有设备密钥：粘贴 Bark 里的密钥并保存。",
    send_failed: `推送失败：${result.error || `Bark 返回了 HTTP ${result.status || "0"}`}。密钥可能不对。`,
    duplicate: "这一轮已经提醒过一次；恢复普通工作后才会开启新的提醒轮次。",
  };
  return { ok: false, state: freshState, error: `测试未送达：${why[result.reason] ?? result.reason}` };
}

function fallbackState(): SettingsState {
  return {
    running: Boolean(state.server),
    version: host().version(),
    statusText: "错误",
    mcpUrl: clientMcpUrl(),
    configuredDomain: "",
    // The fallback runs when state could not be built; claiming "no authtoken"
    // is the safe direction -- it understates rather than inventing one.
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
    // Canonical defaults from the shared list, not a restatement: a future
    // default change propagates here instead of silently diverging. Arrays are
    // copied — CONFIG_DEFAULTS must never be aliased into mutable state.
    config: settingsConfigOf((key, value) => (Array.isArray(value) ? [...value] : value)),
    // Detection needs no host — it reads the filesystem, not the config — so
    // the pre-host view can still offer the picker instead of a bare box.
    detected: detectedView(),
    notify: {
      // The canonical defaults, same as every other fallback field: with a
      // possibly-broken config we report "no key", never a guess about one.
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
