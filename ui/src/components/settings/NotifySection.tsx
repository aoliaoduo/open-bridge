import { useState } from "react";
import type { Act, SettingsState } from "../../api";
import { t } from "../../i18n";
import { Card } from "../Card";
import { DraftField } from "./DraftField";
import { SwitchField } from "./SwitchField";
import { setConfigFor } from "./set-config";

/**
 * Mirrors the sound-path rule in the server's CONFIG_SPEC
 * (src/bridge/config-values.ts: absolute path + audio extension) for the same
 * reason NUMBER_BOUNDS mirrors the numeric ones -- so the field can revert a
 * value the server is about to refuse, instead of leaving the box showing
 * something the config does not hold.
 */
const SOUND_EXTENSIONS = [".wav", ".mp3", ".m4a", ".aac", ".wma", ".flac"];

function isSoundPath(raw: string): boolean {
  // Quotes stripped to match the hint under the field ("paste the path as-is
  // -- quotes are stripped"), and the server, which trims them too.
  const value = raw.trim().replace(/^"|"$/g, "");
  const absolute = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  return absolute && SOUND_EXTENSIONS.some(extension => value.toLowerCase().endsWith(extension));
}

/**
 * The two local-sound slots.
 *
 * Deliberately two, not four: attention and waiting share one file because
 * from the room they are the same event — the AI has stopped and needs you —
 * and progress has no slot at all. A chime per ticked todo is the fastest way
 * to make someone disable the feature they just enabled.
 */
const SOUND_ROWS = [
  {
    key: "waiting",
    which: "waiting" as const,
    configKey: "sound.fileWaiting" as const,
    label: () => t("等你回答", "Waiting for your answer"),
    hint: () => t(
      "AI 提了问题在等你选择；没人回应的话对话就停在那里。",
      "The AI asked something and is blocked. Nothing moves until you answer.",
    ),
  },
  {
    key: "finished",
    which: "finished" as const,
    configKey: "sound.fileFinished" as const,
    label: () => t("对话结束", "Exchange finished"),
    hint: () => t(
      "这一轮收尾时响一次。",
      "One sound when the round wraps up.",
    ),
  },
];

/** The 通知 sub-page: when to interrupt, Bark push, and the local sound. */
export function NotifySection({ settings, act, notify }: {
  settings: SettingsState;
  act: Act;
  notify?: (text: string, isError?: boolean) => void;
}) {
  const cfg = settings.config;
  const setConfig = setConfigFor(act);
  // A draft for the Bark key field (separate from the stored key so the mask
  // shown vs. replaced stay distinguishable; null means "no edit yet").
  const [barkKeyDraft, setBarkKeyDraft] = useState<string | null>(null);

  return (
    <>
    {/* Three cards, because there are now three questions and they used to
        be one. "手机通知（Bark）" as a single heading stopped being true the
        moment a second channel existed: the event switches and the silence
        watchdog are not Bark's, they decide what is worth interrupting a
        person for, and each channel then answers it in its own way. */}
    {/* The two events are fixed (waiting / finished), so this card has no
        settings to fold — it is a description, and stays a plain Card. */}
    <Card
      id="set-notify-events"
      title={t("什么时候提醒你", "When we notify you")}
      desc={t("只在真正需要你回来处理时提醒，避免把进度变成打扰。", "Only interrupt when you genuinely need to return; progress is never an alert.")}
    >
      <div className="field">
        <span className="field-hint" style={{ margin: 0 }}>
          {t("AI 在等你的回答或选择时提醒一次；一轮对话结束时提醒一次。两者属于同一轮时最多只发一次持续通知（Bark call=1），Bridge 不会重推。", "One alert when the AI is waiting for your answer or choice, and one when a round ends. In the same round, at most one persistent Bark call=1 alert is sent; the Bridge never repeats it.")}
        </span>
      </div>
    </Card>

    <Card
      id="set-notify"
      collapsibleId="notify-bark"
      summary={!settings.notify.enabled
        ? t("已关闭", "off")
        : settings.notify.configured
          ? t("已配置", "configured")
          : t("缺设备密钥", "no device key")}
      title={t("手机（Bark）", "Phone (Bark)")}
      desc={t("推送到 iPhone。", "Pushed to your iPhone.")}
    >
      <div className="form-grid">
        <SwitchField
          label={t("启用手机通知", "Enable phone notifications")}
          hint={t("关掉后全部静音，密钥保留。", "Mutes everything; the key is kept.")}
          checked={settings.notify.enabled}
          onChange={next => setConfig("notify.enabled", next)}
        />
        <div className="field">
          <span className="field-label">{t("Bark 设备密钥", "Bark device key")}</span>
          <span className="field-control">
            <input
              type="text"
              className={settings.notify.configured && barkKeyDraft === null ? "is-readonly" : ""}
              value={barkKeyDraft ?? (settings.notify.configured ? settings.notify.keyMask : "")}
              placeholder={settings.notify.configured
                ? t("粘贴新密钥可替换（输入框仅显示掩码）", "Paste a new key to replace it (the field only shows a mask)")
                : t("https://api.day.app/ 后面的那串专属路径", "The unique path that follows https://api.day.app/")}
              readOnly={settings.notify.configured && barkKeyDraft === null}
              aria-readonly={settings.notify.configured && barkKeyDraft === null}
              onChange={e => setBarkKeyDraft(e.target.value)}
            />
            <button
              className="small"
              disabled={barkKeyDraft === null}
              onClick={() => {
                void act({ command: "saveNotifyKey", key: barkKeyDraft ?? "" }).then(result => {
                  if (result?.ok) setBarkKeyDraft(null);
                });
              }}
            >
              {t("保存密钥", "Save key")}
            </button>
            {settings.notify.configured && barkKeyDraft === null && (
              <button
                className="small ghost"
                onClick={() => setBarkKeyDraft("")}
                title={t("粘贴新密钥整串替换；清空后点保存即撤销", "Paste a new key to replace it wholesale; clear the field and save to remove it")}
              >
                {t("更换 / 清除", "Replace / clear")}
              </button>
            )}
            <button
              className="small"
              disabled={!settings.notify.enabled || !settings.notify.configured}
              onClick={() => { void act({ command: "testNotify" }); }}
            >
              {t("发送测试", "Send a test")}
            </button>
          </span>
          <span className="field-hint">
            {t("Bark App 首页显示的那串独特路径就是它，整条链接粘贴也行，会自动摘出密钥。服务器：", "It is the unique path shown on the Bark app's home screen; pasting the whole link works too. Server: ")}
            {settings.notify.serverUrl}
          </span>
        </div>

        <div className="field span2">
          <span className="field-label">{t("固定送达方式", "Fixed delivery")}</span>
          <span className="field-hint">
            {t("等待回答和对话结束都以时效性 Bark 通知送达，并使用一次 call=1 持续响铃。送达方式不能逐事件调整，也不会由 Bridge 重复推送。", "Waiting and finished alerts use a time-sensitive Bark notification with one call=1 persistent ring. Delivery is not configurable per event, and the Bridge never sends a repeat.")}
          </span>
        </div>
      </div>
    </Card>

    <Card
      id="set-sound"
      collapsibleId="notify-sound"
      summary={cfg["sound.enabled"] !== true
        ? t("已关闭", "off")
        : [cfg["sound.fileWaiting"], cfg["sound.fileFinished"]].filter(Boolean).length === 0
          ? t("已启用，但没设音频", "on, no audio set")
          : t(`已启用 · ${[cfg["sound.fileWaiting"], cfg["sound.fileFinished"]].filter(Boolean).length} 个音频`,
              `on · ${[cfg["sound.fileWaiting"], cfg["sound.fileFinished"]].filter(Boolean).length} file(s)`)}
      title={t("本机声音", "Local sound")}
      desc={t("标签页在后台时，在这台机器上放一段音频。不需要 Bark。", "Plays audio on this machine when the tab is in the background. No Bark needed.")}
    >
      <div className="form-grid">
        <SwitchField
          label={t("启用本机声音", "Enable local sound")}
          hint={t("关掉后路径保留。", "Paths are kept.")}
          checked={cfg["sound.enabled"] === true}
          onChange={next => setConfig("sound.enabled", next)}
        />
        <div className="field span2">
          <span className="field-hint" style={{ margin: "0 0 4px" }}>
            {t(
              "只在 AI 停下来等你、或对话结束时响，任务进度不响。路径直接粘贴，引号会自动去掉。",
              "Sounds when the AI is waiting on you or an exchange ends; never on task progress. Paste the path as-is — quotes are stripped.",
            )}
          </span>
        </div>
        {SOUND_ROWS.map(row => (
          <div className="field span2" key={row.key}>
            <span className="field-label">{row.label()}</span>
            <span className="field-control">
              <DraftField
                value={cfg[row.configKey] as string}
                placeholder={t("音频文件的完整路径，留空则不响", "Full path to an audio file; empty means silent")}
                validate={isSoundPath}
                onCommit={raw => setConfig(row.configKey, raw.trim())}
                onInvalid={() => notify?.(t(
                  "需要一个绝对路径，且是音频文件（.wav .mp3 .m4a .aac .wma .flac）。",
                  "Needs an absolute path to an audio file (.wav .mp3 .m4a .aac .wma .flac).",
                ), true)}
              />
              <button
                className="small"
                disabled={!cfg[row.configKey]}
                onClick={() => { void act({ command: "testSound", which: row.which }); }}
              >
                {t("试听", "Play it")}
              </button>
              {/* Never disabled. The whole point is to be reachable when a
                  sound is playing and the operator wants it to stop — and
                  the page cannot know whether one is, since playback lives
                  in a child process. Pressing it on silence is harmless and
                  says so. */}
              <button
                className="small ghost"
                onClick={() => { void act({ command: "stopSound" }); }}
                title={t("立刻停止正在播放的提示音", "Stop whatever is playing right now")}
              >
                {t("停止", "Stop")}
              </button>
            </span>
            <span className="field-hint">{row.hint()}</span>
          </div>
        ))}
      </div>
    </Card>
    </>
  );
}
