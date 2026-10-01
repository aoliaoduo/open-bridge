import type {
  SecretPayload,
  SettingsAction,
  SettingsActionResult,
} from "../../bridge/config/settings-model.js";
import { authToggleVerdict } from "../../bridge/config/settings-model.js";
import {
  authEnabled,
  deleteToken,
  mintToken,
  purgeInactiveTokens,
  revokeAllTokens,
  revokeToken,
  rotateToken,
  tokenTtlSeconds,
  usableTokenCount,
} from "../../http/auth.js";
import { host } from "../../host/host.js";
import { buildSettingsState, secretPayload, settingsSuccess } from "./state.js";

export async function handleAuthSettingsAction(action: SettingsAction): Promise<SettingsActionResult> {
  const cfg = host().config;
  switch (action.command) {
    case "setAuthEnabled": {
      const verdict = authToggleVerdict(action.enabled, await usableTokenCount());
      if (!verdict.allow) {
        return { ok: false, state: await buildSettingsState(), error: verdict.reason ?? "无法开启鉴权。" };
      }
      await cfg.update("auth.enabled", action.enabled);
      return settingsSuccess({
        info: action.enabled
          ? "鉴权已启用：客户端现在必须携带令牌。"
          : "Bearer 门禁已关闭：只填 URL 即可访问。",
      });
    }
    case "setDefaultTtl":
      await cfg.update("auth.tokenTtlSeconds", action.seconds);
      return settingsSuccess();

    case "createToken": {
      const minted = await mintToken({ label: action.label, ttlSeconds: action.ttlSeconds });
      return settingsSuccess({ secret: secretPayload(minted, "minted"), copyText: minted.secret });
    }

    case "armPublicLock":
      return armPublicLockAction(action);

    case "hardenWorkspace":
      return hardenWorkspaceAction();

    case "rotateToken": {
      const rotated = await rotateToken(action.id);
      return settingsSuccess({ secret: secretPayload(rotated, "rotated"), copyText: rotated.secret });
    }

    case "revokeToken": {
      const result = await revokeToken(action.id);
      return settingsSuccess({ info: `已吊销 ${result.revoked.length} 个令牌。` });
    }

    case "deleteToken": {
      await deleteToken(action.id);
      const fresh = await buildSettingsState();
      if (authEnabled() && (await usableTokenCount()) === 0) {
        return {
          ok: true,
          state: fresh,
          error: "鉴权仍开启，但已没有任何有效令牌 — 端点正在拒绝所有请求。请新建令牌，或关闭鉴权开关。",
        };
      }
      return { ok: true, state: fresh, info: "令牌已删除。" };
    }

    case "purgeTokens": {
      const result = await purgeInactiveTokens();
      return settingsSuccess({ info: `已清理 ${result.deleted.length} 个失效令牌。` });
    }

    case "revokeAll": {
      const result = await revokeAllTokens();
      return settingsSuccess({
        info: authEnabled()
          ? `已吊销 ${result.revoked.length} 个令牌。端点现在拒绝所有请求，请新建令牌。`
          : `已吊销 ${result.revoked.length} 个令牌。`,
      });
    }

    default:
      throw new Error(`Auth settings handler cannot process ${action.command}.`);
  }
}

async function armPublicLockAction(
  action: SettingsAction & { command: "armPublicLock" },
): Promise<SettingsActionResult> {
  const cfg = host().config;
  const gateWasEnabled = authEnabled();
  const existing = await usableTokenCount();
  if (gateWasEnabled && existing > 0) {
    return settingsSuccess({ info: "Bearer 门禁本来就已经开着：/mcp 要求 Bearer 令牌。" });
  }

  let secret: SecretPayload | undefined;
  let mintedId: string | undefined;
  if (existing === 0) {
    const minted = await mintToken({
      label: action.label || "public-lock",
      ttlSeconds: action.ttlSeconds ?? tokenTtlSeconds(),
    });
    mintedId = minted.id;
    secret = secretPayload(minted, "minted");
  }

  if (!gateWasEnabled) {
    try {
      await cfg.update("auth.enabled", true);
    } catch (error) {
      if (mintedId) await deleteToken(mintedId).catch(() => undefined);
      throw error;
    }
  }

  return settingsSuccess({
    secret,
    copyText: secret?.secret,
    info: gateWasEnabled && secret
      ? "Bearer 门禁原本已开启但没有有效令牌；已补发 1 个令牌，客户端可再次使用 Bearer 方式接入。"
      : secret
        ? "Bearer 门禁已启用：已签发 1 个令牌并打开门禁，客户端必须在请求头带 Authorization: Bearer <令牌>。"
          + "只填 URL 的客户端（例如 ChatGPT 连接器）会立刻连不上；要恢复就在「安全」页关掉那个开关。"
        : `Bearer 门禁已启用：复用了现有的 ${existing} 个有效令牌，客户端现在必须携带令牌（只填 URL 会连不上）。`,
  });
}

async function hardenWorkspaceAction(): Promise<SettingsActionResult> {
  const gate = await armPublicLockAction({ command: "armPublicLock", label: "public-lock" });
  try {
    await host().config.update("unrestrictedFileAccess", false);
  } catch (error) {
    return {
      ok: false,
      state: await buildSettingsState().catch(() => gate.state),
      secret: gate.secret,
      copyText: gate.copyText,
      error: "Bearer 门禁已处理，但文件访问范围没有保存成功："
        + (error instanceof Error ? error.message : String(error)),
    };
  }
  return settingsSuccess({
    secret: gate.secret,
    copyText: gate.copyText,
    info: "安全预设已应用：Bearer 门禁已开启，文件访问已限制为当前工作区和「显式允许目录」。",
  });
}
