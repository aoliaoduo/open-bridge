import { existsSync } from "node:fs";
import type { SettingsAction, SettingsActionResult, SettingsState } from "../../bridge/config/settings-model.js";
import { maskBarkKey, validateConfigValue } from "../../bridge/config/config-values.js";
import { playAlertSound, stopAlertSound } from "../../bridge/tools/sound-alert.js";
import {
  NOTIFY_DEFAULT_TITLE,
  pushNotification,
  resolveNotifySettings,
  type NotifyOutcome,
} from "../../bridge/tools/notify.js";
import { host } from "../../host/host.js";
import { buildSettingsState, settingsSuccess } from "./state.js";

export async function handleNotifySettingsAction(action: SettingsAction): Promise<SettingsActionResult> {
  const cfg = host().config;
  switch (action.command) {
    case "saveNotifyKey": {
      const checked = validateConfigValue("notify.barkKey", action.key);
      if (!checked.ok) {
        return { ok: false, state: await buildSettingsState(), error: checked.error };
      }
      await cfg.update("notify.barkKey", checked.value);
      const stored = checked.value as string;
      if (!stored) return settingsSuccess({ info: "设备密钥已清除：推送停用（开关保持原样）。" });
      const extracted = action.key.includes("/") || action.key.includes(":");
      return settingsSuccess({
        info: extracted
          ? `设备密钥已保存（已从链接中摘出：${maskBarkKey(stored)}）。点「发送测试」验证手机。`
          : `设备密钥已保存（${maskBarkKey(stored)}）。点「发送测试」验证手机。`,
      });
    }

    case "testSound": {
      const key = action.which === "finished" ? "sound.fileFinished" : "sound.fileWaiting";
      const file = String(cfg.get<string>(key, "") ?? "").trim();
      if (!file) return { ok: false, state: await buildSettingsState(), error: "这一项还没有设置音频文件。" };
      if (!existsSync(file)) {
        return { ok: false, state: await buildSettingsState(), error: `文件不存在：${file}` };
      }
      const result = playAlertSound(file);
      return result.played
        ? settingsSuccess({ info: "已弹出播放窗口，关闭它即停止。没听到就检查系统音量和默认输出设备。" })
        : { ok: false, state: await buildSettingsState(), error: `播放失败：${result.reason}` };
    }

    case "stopSound": {
      const stopped = stopAlertSound();
      return settingsSuccess({ info: stopped ? "已停止。" : "当前没有在播放。" });
    }

    case "testNotify": {
      const result = await pushNotification(
        resolveNotifySettings(),
        "waiting",
        NOTIFY_DEFAULT_TITLE,
        "Open Bridge 测试通知：配置已生效。实际提醒只会在等待回答或对话结束时发送一次。",
        Date.now(),
        { bypassEpisode: true, silentLocally: true },
      );
      return notifyActionVerdict(result, await buildSettingsState());
    }

    default:
      throw new Error(`Notification settings handler cannot process ${action.command}.`);
  }
}

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
