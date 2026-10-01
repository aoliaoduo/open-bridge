import * as path from "node:path";
import type { SettingsAction, SettingsActionResult } from "../../bridge/config/settings-model.js";
import { resetUsageStats } from "../../bridge/usage-store.js";
import { host } from "../../host/host.js";
import { start, republishAfterRotate, rotateRouteToken } from "../../bridge/lifecycle/lifecycle.js";
import { enqueueLifecycle } from "../../bridge/lifecycle/lifecycle-queue.js";
import { buildWebAiPrompt } from "../../bridge/onboarding.js";
import { saveTunnelDetectionSetting } from "../settings-tunnel.js";
import { buildSettingsState, settingsSuccess } from "./state.js";

export async function handleGeneralSettingsAction(action: SettingsAction): Promise<SettingsActionResult> {
  const cfg = host().config;
  switch (action.command) {
    case "clearStats":
      resetUsageStats();
      return settingsSuccess({ info: "调用统计已清零（累计调用数与按工具明细）。" });

    case "copyPrompt":
      return settingsSuccess({
        info: "接入提示词已复制，粘贴给已连接该 MCP 的 AI 客户端即可。",
        copyText: buildWebAiPrompt(),
      });

    case "copyText":
      return settingsSuccess({ info: "已复制。", copyText: action.text });

    case "start":
      await start();
      return settingsSuccess();

    case "stop": {
      const before = await buildSettingsState();
      return {
        ok: true,
        state: { ...before, running: false, status: { kind: "stopped" }, mcpUrl: "" },
        info: "Bridge 已停止：本地服务关闭、端口释放，这个控制台也随之失效。重新启动请运行 open-bridge serve。",
        deferStop: true,
      };
    }

    case "rotateEndpoint":
      await enqueueLifecycle(async () => { await rotateRouteToken(); });
      await republishAfterRotate();
      return {
        ...(await settingsSuccess({ info: "MCP URL 已更新，旧链接立即失效。控制台正在重新加载。" })),
        reloadRequired: true,
      };

    case "setConcurrency":
      await cfg.update("concurrency.enabled", action.enabled);
      await cfg.update("concurrency.holdTimeoutMs", action.holdTimeoutMs);
      await cfg.update("concurrency.waitTimeoutMs", action.waitTimeoutMs);
      return settingsSuccess({ info: "并发设置已保存。" });

    case "setConfig": {
      const value = action.key === "allowedDirectories" && Array.isArray(action.value)
        ? (action.value as string[]).map(item => path.resolve(item))
        : action.value;
      if (
        (action.key === "tunnelProvider" || action.key === "ngrokExecutable" || action.key === "tailscaleExecutable")
        && typeof value === "string"
      ) {
        const outcome = await saveTunnelDetectionSetting(action.key, value);
        return settingsSuccess({ info: outcome.info });
      }
      await cfg.update(action.key, value);
      return settingsSuccess({ info: "已保存。" });
    }

    default:
      throw new Error(`General settings handler cannot process ${action.command}.`);
  }
}
