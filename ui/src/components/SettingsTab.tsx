import { useEffect, useState } from "react";
import { type SettingsActionResult, type SettingsState } from "../api";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../routes";
import { t } from "../i18n";
import { Card } from "./Card";
import { ExecutablePicker } from "./ExecutablePicker";
import { Field } from "./Field";
import { SectionNav } from "./SectionNav";
import { Skeleton } from "./Skeleton";

interface Props {
  settings: SettingsState | null;
  act: (action: Record<string, unknown>) => Promise<unknown>;
  /** Invalid-input feedback: shows a toast instead of failing silently. */
  notify?: (text: string, isError?: boolean) => void;
  /** Which settings sub-page is open — the URL is the source of truth. */
  section: SettingsSectionId;
  /** Sub-page switch: App turns this into a history entry, not a scroll. */
  onSectionChange: (id: SettingsSectionId) => void;
}

/** Bounds mirror the server's CONFIG_SPEC (src/bridge/settings-model.ts) so a
 *  value the UI accepts never comes back as an inscrutable 400. */
const NUMBER_BOUNDS = {
  port: { min: 0, max: 65_535, label: () => t("本地端口", "Local port") },
  publicHealthTimeoutMs: { min: 3_000, max: 120_000, label: () => t("公网健康检查", "Public health check") },
  holdTimeoutMs: { min: 0, max: 3_600_000, label: () => t("占用上限", "Hold ceiling") },
  waitTimeoutMs: { min: 0, max: 3_600_000, label: () => t("等待上限", "Wait ceiling") },
} as const;

/**
 * One draft field: edits stay local until blur (or Enter). The previous
 * version called setConfig on EVERY keystroke — each one a config.json write,
 * and intermediate values (a half-typed port, a health timeout below its
 * minimum) fired error toasts on every key.
 *
 * Number fields validate on commit against the server's bounds: an invalid
 * value is REVERTED to the saved one with a toast, never silently kept — the
 * old behaviour left the input showing a value the config did not hold, and
 * the operator only found out on the next reload.
 */
export function DraftField({
  value,
  onCommit,
  onInvalid,
  type = "text",
  min,
  max,
  step,
  placeholder,
  multiline = false,
}: {
  value: string;
  onCommit: (raw: string) => void;
  onInvalid?: () => void;
  type?: "text" | "number";
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Render a <textarea>: HTML inputs strip newlines from their value, which
   *  silently merged the allowedDirectories list into one bogus path. */
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // Follow authoritative changes while the operator is not editing.
  useEffect(() => { setDraft(value); }, [value]);
  const commit = (): void => {
    if (draft === value) return;
    if (type === "number") {
      const n = Number(draft.trim());
      const bad = draft.trim() === ""
        || !Number.isInteger(n)
        || (min !== undefined && n < min)
        || (max !== undefined && n > max);
      if (bad) {
        onInvalid?.();
        setDraft(value);
        return;
      }
    }
    onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        rows={4}
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <input
      type={type}
      min={min}
      max={max}
      step={step}
      value={draft}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/** A switch field: label on top, the switch plus its current state under it. */
/**
 * The four notify events, in the order an operator meets them: the two that
 * block them first, then the two that merely report.
 *
 * `always` and `canRing` are properties of the event, not preferences:
 * attention and waiting bypass the on/off switches because an unanswered
 * question stalls the exchange, and only those two are worth a phone that
 * rings until opened.
 */
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
    label: () => t("等你回答 / 需要你回来", "Waiting on you"),
    hint: () => t(
      "AI 提了问题在等你选择，或明确需要你回到电脑前。没人回应的话对话就停在那里。",
      "The AI asked something and is blocked, or explicitly needs you back. Nothing moves until you answer.",
    ),
  },
  {
    key: "finished",
    which: "finished" as const,
    configKey: "sound.fileFinished" as const,
    label: () => t("对话结束", "Exchange finished"),
    hint: () => t(
      "这一轮收尾时响一次。受上面「对话结束时」开关控制。",
      "One sound when the round wraps up. Follows the end-of-exchange switch above.",
    ),
  },
];

const NOTIFY_EVENT_ROWS = [
  {
    key: "Attention" as const,
    label: () => t("需要你回来", "Attention"),
    when: () => t("AI 明确需要你回到电脑前", "The AI explicitly needs you back"),
    always: true,
    canRing: true,
  },
  {
    key: "Waiting" as const,
    label: () => t("等你回答", "Waiting"),
    when: () => t("AI 提了问题，在等你选择", "The AI asked something and is blocked"),
    always: true,
    canRing: true,
  },
  {
    key: "Finished" as const,
    label: () => t("对话结束", "Finished"),
    when: () => t("这一轮收尾；AI 忘了发则服务端代发", "The round wraps up; the server covers a forgetful AI"),
    always: false,
    canRing: false,
  },
  {
    key: "Progress" as const,
    label: () => t("进展", "Progress"),
    when: () => t("勾掉一项任务，或 AI 汇报一行进展", "An item is ticked off, or progress is reported"),
    always: false,
    canRing: false,
  },
];

function SwitchField(
  { label, hint, checked, onChange }: {
    label: string;
    hint?: string;
    checked: boolean;
    onChange: (next: boolean) => void;
  },
) {
  return (
    <div className="field">
      {/* The label text is NOT inside the <label>, on purpose. Wrapping it
          makes the whole line a click target, and on a page that is mostly
          labelled rows that means a stray click anywhere near a setting
          silently flips it -- the kind of mistake you only notice later, by
          its consequences. The switch keeps its accessible name through
          aria-label, so a screen reader still announces which setting it is;
          only the pointer target shrinks to the control itself. */}
      <span className="check-row">
        <input
          type="checkbox"
          className="switch"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          aria-label={label}
        />
        <span className="field-label">{label}</span>
      </span>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function SettingsTab({ settings, act, notify, section, onSectionChange }: Props) {
  const [domain, setDomain] = useState<string | null>(null);
  // A draft for the device-key field (separate from the stored key so the
  // mask shown vs. replaced stay distinguishable; null means "no edit yet").
  const [barkKeyDraft, setBarkKeyDraft] = useState<string | null>(null);
  const [authtokenDraft, setAuthtokenDraft] = useState<string | null>(null);
  const [tailscaleDomainDraft, setTailscaleDomainDraft] = useState<string | null>(null);
  const [tsExeDraft, setTsExeDraft] = useState<string | null>(null);

  if (!settings) return <div className="card"><Skeleton lines={4} /></div>;
  const cfg = settings.config;
  const domainValue = domain ?? settings.configuredDomain;
  // What the server found on this machine. Defaulted because an older server
  // (or a hand-built fixture) may not send it, and a missing list must degrade
  // to "type a path", never to a crashed settings page.
  const shells = settings.detected?.shells ?? [];
  const ngroks = settings.detected?.ngrok ?? [];
  // Name what 自动 will actually do, so choosing it is not an act of faith.
  const autoShellLabel = shells[0]
    ? `${shells[0].label} — ${shells[0].value}`
    : t("按平台猜测", "a per-platform guess");
  const autoNgrokLabel = ngroks[0]
    ? `${ngroks[0].label} — ${ngroks[0].value}`
    : t("PATH 里的 ngrok", "the ngrok on PATH");

  const setConfig = (key: string, value: unknown) => { void act({ command: "setConfig", key, value }); };

  /**
   * Commit a number the DraftField has already validated against NUMBER_BOUNDS
   * (it reverts and reports the rejection itself, via `invalidFor`). Re-checking
   * here would be a second copy of the same rule that can only ever agree.
   */
  const commitNumber = (key: keyof typeof NUMBER_BOUNDS, raw: string): void => {
    setConfig(key, Number(raw.trim()));
  };

  /** Rejection feedback for a DraftField; the revert is DraftField's own job. */
  const invalidFor = (key: keyof typeof NUMBER_BOUNDS) => (): void => {
    const { label, min, max } = NUMBER_BOUNDS[key];
    notify?.(t(
      `${label()} 需要整数 ${min}–${max}，已还原为保存的值。`,
      `${label()} must be an integer between ${min} and ${max}; reverted to the saved value.`,
    ), true);
  };

  return (
    <>
      {/* One card per sub-page: the strip switches the route, the URL and the
          rendered card move together, and a reload lands where you were. */}
      <SectionNav
        items={SETTINGS_SECTIONS.map(({ id, label }) => ({ id, label: label() }))}
        active={section}
        onSelect={onSectionChange}
      />

      {section === "tunnel" && (
      <Card
        id="set-tunnel"
        title={t("隧道", "Tunnel")}
        desc={t(
          "隧道让公网上的客户端连到这台机器；不开隧道时只有本机能访问。",
          "A tunnel lets clients on the internet reach this machine; without one, only this machine can.",
        )}
      >
        <div className="form-grid">
          <Field
            label={t("提供商", "Provider")}
            hint={t("ngrok 对公网开放（预留域名）；Tailscale Funnel 用本机的 ts.net 域名对公网开放（免费版限 443 端口，需在 login.tailscale.com 启用 Funnel 一次）；none 仅本机回环。", "ngrok serves a reserved domain to the public; Tailscale Funnel serves this machine's ts.net name to the public (free tier: port 443, enable Funnel once at login.tailscale.com); none is loopback only.")}
          >
            <select value={cfg.tunnelProvider} onChange={e => setConfig("tunnelProvider", e.target.value)}>
              <option value="ngrok">ngrok</option>
              <option value="tailscale">Tailscale Funnel</option>
              <option value="none">{t("none（仅本地）", "none (local only)")}</option>
            </select>
          </Field>

          {/* ngrok-only fields: a Tailscale Funnel has no authtoken, no
              reserved domain and no second executable setting - showing them
              under the Tailscale provider invited edits that would be silently
              ignored by the tunnel it actually runs. */}
          {cfg.tunnelProvider === "ngrok" && (
          <>          <div className="field">
            <span className="field-label">{t("Authtoken", "Authtoken")}</span>
            <span className="field-control">
              <input
                type="text"
                value={authtokenDraft ?? settings.ngrokAuthtokenMask}
                placeholder={settings.ngrokAuthtokenMask
                  ? t("粘贴新的 authtoken 可替换（输入框仅显示掩码）", "Paste a new authtoken to replace it (the field only shows a mask)")
                  : t("在 ngrok 控制台的 Your Authtoken 页面复制", "Copy it from Your Authtoken in the ngrok dashboard")}
                readOnly={Boolean(settings.ngrokAuthtokenMask) && authtokenDraft === null}
                onChange={e => setAuthtokenDraft(e.target.value)}
              />
              <button
                className="small"
                disabled={authtokenDraft === null}
                onClick={() => {
                  void act({ command: "saveNgrokAuthtoken", token: authtokenDraft ?? "" }).then(result => {
                    if ((result as SettingsActionResult | null)?.ok) setAuthtokenDraft(null);
                  });
                }}
              >
                {t("保存 Authtoken", "Save authtoken")}
              </button>
              {Boolean(settings.ngrokAuthtokenMask) && authtokenDraft === null && (
                <button
                  className="small ghost"
                  onClick={() => setAuthtokenDraft("")}
                  title={t("粘贴新 token 整串替换；清空后点保存即删除", "Paste a new token to replace it wholesale; clear the field and save to remove it")}
                >
                  {t("替换", "Replace")}
                </button>
              )}
            </span>
            <span className="field-hint">
              {t(
                "ngrok 需要一次性登记账号凭据才能建立隧道。以前只能在终端跑 ngrok config add-authtoken，现在填在这里即可——保存后重启实例生效（关掉终端窗口再启动一次）。已经用过那条命令的不必再填。",
                "ngrok needs your account credential once before it can open a tunnel. This used to require running ngrok config add-authtoken in a terminal; saving it here does the same. It takes effect on the next start — close the terminal window that owns this instance and start it again. If you already ran that command, you can leave this empty.",
              )}
            </span>
          </div>

          <div className="field">
            <span className="field-label">{t("预留域名", "Reserved domain")}</span>
            <span className="field-control">
              <input
                type="text"
                value={domainValue}
                placeholder="example.ngrok-free.dev"
                onChange={e => setDomain(e.target.value)}
              />
              <button
                className="small"
                disabled={domain === null}
                onClick={() => {
                  // Reset the draft only on success: a rejected domain (bad
                  // format) used to wipe the operator's typing along with the
                  // toast, making them retype it from scratch.
                  void act({ command: "saveDomain", domain: domainValue }).then(result => {
                    if ((result as SettingsActionResult | null)?.ok) setDomain(null);
                  });
                }}
              >
                {t("保存域名", "Save domain")}
              </button>
            </span>
            <span className="field-hint">
              {t("留空则使用 ngrok 分配的随机地址；改动在下次启动实例时生效。", "Leave empty to use the random address ngrok assigns; a change takes effect on the next start.")}
            </span>
          </div>

          <Field
            label={t("ngrok 可执行文件", "ngrok executable")}
            hint={ngroks.length
              ? t(
                "已找到下面这些 ngrok；隧道起不来时，多半是这里选错了副本。",
                "These ngrok copies were found. When a tunnel refuses to start, this is usually the wrong one.",
              )
              : t(
                "这台机器上没找到 ngrok：先从 ngrok.com 下载，再把解压出来的可执行文件路径填在这里（隧道提供商选 none 则不需要）。",
                "No ngrok found here: download it from ngrok.com, then point this at the unpacked executable. Not needed if the provider is none.",
              )}
          >
            <ExecutablePicker
              value={cfg.ngrokExecutable}
              choices={ngroks}
              // "" and "ngrok" both mean "whatever PATH gives us"; "" is stored
              // so a future default change is not frozen into the config file.
              autoValues={["", "ngrok"]}
              autoLabel={autoNgrokLabel}
              placeholder={t("ngrok 可执行文件的完整路径", "Full path to the ngrok executable")}
              onCommit={next => setConfig("ngrokExecutable", next)}
            />
          </Field>
          </>
          )}
          <SwitchField
            label={t("隧道意外退出时自动重连", "Reconnect automatically if the tunnel dies")}
            hint={t("伴随进程退出时按退避重试，不需要人工点重新启动。", "Retries with backoff when the companion process exits, so nobody has to click restart.")}
            checked={cfg.autoReconnect}
            onChange={next => setConfig("autoReconnect", next)}
          />
          {cfg.tunnelProvider === "ngrok" && (
          <>
          <SwitchField
            label={t("ngrok 继承系统代理", "ngrok inherits the system proxy")}
            hint={t("公司网络需要走代理时打开；直连环境关掉更快。", "Turn on behind a corporate proxy; leave off for a direct connection, which is faster.")}
            checked={cfg.ngrokUseHttpProxy}
            onChange={next => setConfig("ngrokUseHttpProxy", next)}
          />
          </>
          )}
          {cfg.tunnelProvider === "tailscale" && (
          <>
          <div className="field">
            <span className="field-label">{t("公网域名", "Public domain")}</span>
            <span className="field-control">
              <input
                type="text"
                value={tailscaleDomainDraft ?? cfg.tailscaleDomain}
                placeholder={t("启动时自动从 tailscale CLI 发现", "Discovered from the tailscale CLI at start")}
                onChange={e => setTailscaleDomainDraft(e.target.value)}
              />
              <button
                className="small"
                disabled={tailscaleDomainDraft === null}
                onClick={() => {
                  void act({ command: "setConfig", key: "tailscaleDomain", value: tailscaleDomainDraft ?? "" }).then(result => {
                    if ((result as SettingsActionResult | null)?.ok) setTailscaleDomainDraft(null);
                  });
                }}
              >
                {t("保存域名", "Save domain")}
              </button>
            </span>
            <span className="field-hint">
              {t("留空则每次启动从 tailscale CLI 自动发现本机的 ts.net 名；手动填写的值若与 CLI 报告的不一致会在启动时报错。", "Leave empty to discover this machine's ts.net name from the tailscale CLI at each start; a manual value that disagrees with the CLI is an error at start, not a silent mismatch.")}
            </span>
          </div>
          <div className="field">
            <span className="field-label">{t("Tailscale 可执行文件", "Tailscale executable")}</span>
            <span className="field-control">
              <input
                type="text"
                value={tsExeDraft ?? cfg.tailscaleExecutable}
                placeholder={t("默认按 PATH 与 C:\\Program Files\\Tailscale 查找", "Found via PATH, then C:\\Program Files\\Tailscale")}
                onChange={e => setTsExeDraft(e.target.value)}
              />
              <button
                className="small"
                disabled={tsExeDraft === null}
                onClick={() => {
                  void act({ command: "setConfig", key: "tailscaleExecutable", value: tsExeDraft ?? "" }).then(result => {
                    if ((result as SettingsActionResult | null)?.ok) setTsExeDraft(null);
                  });
                }}
              >
                {t("保存路径", "Save path")}
              </button>
            </span>
            <span className="field-hint">
              {t("MSI 安装默认不加入 PATH，找不到时把完整路径填在这里。", "The MSI does not add itself to PATH by default; if the binary is not found, put the full path here.")}
            </span>
          </div>
          </>
          )}
        </div>
      </Card>
      )}

      {section === "network" && (
      <Card
        id="set-network"
        title={t("网络", "Network")}
        desc={t("本机监听端口与公网健康检查的超时。", "The local listen port and the public health-check timeout.")}
      >
        <div className="form-grid">
          <Field
            label={t("本地端口", "Local port")}
            hint={t("0 = 自动选择空闲端口（重启 Bridge 生效）；失焦时保存。", "0 picks a free port automatically (takes effect after a restart); saved on blur.")}
          >
            <DraftField
              type="number"
              min={NUMBER_BOUNDS.port.min}
              max={NUMBER_BOUNDS.port.max}
              value={String(cfg.port)}
              onCommit={raw => commitNumber("port", raw)}
              onInvalid={invalidFor("port")}
            />
          </Field>
          <Field
            label={t("公网健康检查", "Public health check")}
            hint={t("毫秒（3000–120000）；失焦时保存。", "Milliseconds (3000–120000); saved on blur.")}
          >
            <DraftField
              type="number"
              min={NUMBER_BOUNDS.publicHealthTimeoutMs.min}
              max={NUMBER_BOUNDS.publicHealthTimeoutMs.max}
              step={1000}
              value={String(cfg.publicHealthTimeoutMs)}
              onCommit={raw => commitNumber("publicHealthTimeoutMs", raw)}
              onInvalid={invalidFor("publicHealthTimeoutMs")}
            />
          </Field>
        </div>
      </Card>
      )}

      {section === "files" && (
      <Card
        id="set-files"
        title={t("文件访问", "File access")}
        desc={t(
          "默认允许访问项目根之外的路径（个人本机推荐）；关掉之后只有下面列出的目录可读写。",
          "By default paths outside the project root are allowed (recommended for a personal machine); turn it off and only the directories listed below are readable and writable.",
        )}
      >
        <SwitchField
          label={t("允许访问项目根之外的路径", "Allow paths outside the project root")}
          checked={cfg.unrestrictedFileAccess}
          onChange={next => setConfig("unrestrictedFileAccess", next)}
        />
        {!cfg.unrestrictedFileAccess && (
          <div className="field">
            <span className="field-label">{t("允许的目录", "Allowed directories")}</span>
            <span className="field-control">
              {/* A textarea, not an input: HTML value sanitization strips \n from
                  text inputs, so the list silently merged into one bogus path
                  the moment the operator edited and blurred the field. */}
              <DraftField
                multiline
                value={cfg.allowedDirectories.join("\n")}
                placeholder={t("每行一个绝对目录，如\nC:\\projects\\shared", "One absolute directory per line, e.g.\nC:\\projects\\shared")}
                onCommit={raw => setConfig("allowedDirectories", raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))}
              />
            </span>
            <span className="field-hint">{t("每行一个绝对目录；失焦时保存", "One absolute directory per line; saved on blur")}</span>
          </div>
        )}
      </Card>
      )}

      {section === "shell" && (
      <Card
        id="set-shell"
        title={t("Shell", "Shell")}
        desc={t("命令通过哪个 shell 执行。", "Which shell commands run through.")}
      >
        <div className="form-grid">
          <Field
            label={t("Shell 路径", "Shell path")}
            hint={shells.length
              ? t(
                `已在这台机器上找到 ${shells.length} 个 shell，选一个即可；自动 = 列表里的第一个。`,
                `Found ${shells.length} shells on this machine — pick one, or leave it on automatic (the first in the list).`,
              )
              : t(
                "没有探测到已知的 shell，请手动填写完整路径。",
                "No known shell was detected; type the full path instead.",
              )}
          >
            <ExecutablePicker
              value={cfg.shellPath}
              choices={shells}
              autoValues={[""]}
              autoLabel={autoShellLabel}
              placeholder={t("shell 可执行文件的完整路径", "Full path to a shell executable")}
              onCommit={next => setConfig("shellPath", next)}
            />
          </Field>
          <Field label={t("Shell 参数", "Shell arguments")} hint={t("每行一个参数；含空格的参数无需加引号。留空使用默认参数。", "One argument per line; arguments with spaces need no quoting. Leave empty for the defaults.")}>
            {/* One per line, like allowedDirectories: the old join(" ")/split(/\s+/)
                round-trip could not express an argument containing a space
                ("C:\Program Files\...") or an empty one, and saving once
                permanently split such an argument into two. */}
            <DraftField
              multiline
              value={cfg.shellArgs.join("\n")}
              placeholder={t("留空使用默认参数", "Leave empty for the defaults")}
              onCommit={raw => setConfig("shellArgs", raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0))}
            />
          </Field>
        </div>
      </Card>
      )}

      {section === "notify" && (
      <>
      {/* Three cards, because there are now three questions and they used to
          be one. "手机通知（Bark）" as a single heading stopped being true the
          moment a second channel existed: the event switches and the silence
          watchdog are not Bark's, they decide what is worth interrupting a
          person for, and each channel then answers it in its own way. */}
      <Card
        id="set-notify-events"
        collapsibleId="notify-events"
        summary={[
          settings.notify.onTaskDone ? t("任务完成", "tasks") : null,
          settings.notify.onFinish ? t("对话结束", "endings") : null,
          settings.notify.idleMinutes > 0 ? t(`静默 ${settings.notify.idleMinutes} 分钟`, `${settings.notify.idleMinutes}m silence`) : null,
        ].filter(Boolean).join(" · ") || t("只有必发的两类", "only the unconditional two")}
        title={t("什么时候该打扰你", "When to interrupt you")}
        desc={t("哪些事值得被打断。下面两张卡决定用什么方式告诉你。", "What is worth an interruption. The cards below decide how you hear about it.")}
      >
        <div className="form-grid">
          <SwitchField
            label={t("每项任务完成时", "On each finished task")}
            hint={t("清单每勾掉一条通知一次。", "One alert per item ticked off.")}
            checked={settings.notify.onTaskDone}
            onChange={next => setConfig("notify.onTaskDone", next)}
          />
          <SwitchField
            label={t("对话结束时", "When the exchange ends")}
            hint={t("收尾时通知一次；AI 忘了发则服务端代发。", "One alert when the round ends; the server covers a forgetful AI.")}
            checked={settings.notify.onFinish}
            onChange={next => setConfig("notify.onFinish", next)}
          />
          <Field
            label={t("无反应提醒", "Silence alert")}
            hint={t("静默这么多分钟后叫你一次。0 = 关闭。", "Calls you back after this many minutes of silence. 0 disables it.")}
          >
            <DraftField
              type="number"
              min={0}
              max={1440}
              value={String(settings.notify.idleMinutes)}
              onCommit={raw => setConfig("notify.idleMinutes", Number(raw.trim()))}
              onInvalid={() => notify?.(t(
                "无反应提醒需要 0–1440 的整数分钟，已还原。",
                "The silence alert needs a whole number of minutes from 0 to 1440; reverted.",
              ), true)}
            />
          </Field>
          <div className="field span2">
            <span className="field-hint" style={{ margin: 0 }}>
              {t("「需要你回来」和「等你回答」始终送达，不受开关影响。", "Attention and Waiting always arrive; the switches above do not apply to them.")}
            </span>
          </div>
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
                value={barkKeyDraft ?? (settings.notify.configured ? settings.notify.keyMask : "")}
                placeholder={settings.notify.configured
                  ? t("粘贴新密钥可替换（输入框仅显示掩码）", "Paste a new key to replace it (the field only shows a mask)")
                  : t("https://api.day.app/ 后面的那串专属路径", "The unique path that follows https://api.day.app/")}
                readOnly={settings.notify.configured && barkKeyDraft === null}
                onChange={e => setBarkKeyDraft(e.target.value)}
              />
              <button
                className="small"
                disabled={barkKeyDraft === null}
                onClick={() => {
                  void act({ command: "saveNotifyKey", key: barkKeyDraft ?? "" }).then(result => {
                    if ((result as SettingsActionResult | null)?.ok) setBarkKeyDraft(null);
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
            <span className="field-label">{t("每类通知怎么响", "How each kind arrives")}</span>
            <div className="table-wrap">
              <table className="token-table notify-table">
                <thead>
                  <tr>
                    <th>{t("通知", "Push")}</th>
                    <th>{t("什么时候发", "When")}</th>
                    <th>{t("送达方式", "Delivery")}</th>
                  </tr>
                </thead>
                <tbody>
                  {NOTIFY_EVENT_ROWS.map(row => (
                    <tr key={row.key}>
                      <td>
                        <div className="notify-name">
                          <span>{row.label()}</span>
                          {row.always ? (
                            <span className="always-chip" title={t("不受上面的开关影响", "Not affected by the switches above")}>
                              {t("总是发", "always")}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td><span className="field-hint">{row.when()}</span></td>
                      <td>
                        <div className="delivery-cell">
                        <select
                          value={settings.config[`notify.level${row.key}`] as string}
                          onChange={e => setConfig(`notify.level${row.key}`, e.target.value)}
                        >
                          <option value="passive">{t("安静（只进列表）", "Passive (list only)")}</option>
                          <option value="active">{t("普通横幅", "Active banner")}</option>
                          <option value="timeSensitive">{t("穿透专注模式", "Time-sensitive")}</option>
                          <option value="critical">{t("无视静音", "Critical (ignores mute)")}</option>
                        </select>
                        <span className="check-row">
                          <input
                            type="checkbox"
                            className="switch"
                            checked={settings.config[`notify.call${row.key}`] === true}
                            onChange={e => setConfig(`notify.call${row.key}`, e.target.checked)}
                            aria-label={`${row.label()}：${t("持续响铃直到点开", "Ring until opened")}`}
                          />
                          <span className="field-hint">{t("持续响铃直到点开", "Ring until opened")}</span>
                        </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="field-hint">
              {t(
                "「穿透专注模式」不管静音键；「无视静音」需要 iOS 里给 Bark 开「重要警告」权限，否则会被降级。",
                "Time-sensitive does not pierce the mute switch. Critical does, but needs Bark's critical-alert permission in iOS or it is downgraded.",
              )}
            </span>
          </div>
        </div>
      </Card>

      <Card
        id="set-sound"
        collapsibleId="notify-sound"
        summary={settings.config["sound.enabled"] !== true
          ? t("已关闭", "off")
          : [settings.config["sound.fileWaiting"], settings.config["sound.fileFinished"]].filter(Boolean).length === 0
            ? t("已启用，但没设音频", "on, no audio set")
            : t(`已启用 · ${[settings.config["sound.fileWaiting"], settings.config["sound.fileFinished"]].filter(Boolean).length} 个音频`,
                `on · ${[settings.config["sound.fileWaiting"], settings.config["sound.fileFinished"]].filter(Boolean).length} file(s)`)}
        title={t("本机声音", "Local sound")}
        desc={t("标签页在后台时，在这台机器上放一段音频。不需要 Bark。", "Plays audio on this machine when the tab is in the background. No Bark needed.")}
      >
        <div className="form-grid">
          <SwitchField
            label={t("启用本机声音", "Enable local sound")}
            hint={t("关掉后路径保留。", "Paths are kept.")}
            checked={settings.config["sound.enabled"] === true}
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
                  value={settings.config[row.configKey] as string}
                  placeholder={t("音频文件的完整路径，留空则不响", "Full path to an audio file; empty means silent")}
                  onCommit={raw => setConfig(row.configKey, raw.trim())}
                  onInvalid={() => notify?.(t(
                    "需要一个绝对路径，且是音频文件（.wav .mp3 .m4a .aac .wma .flac）。",
                    "Needs an absolute path to an audio file (.wav .mp3 .m4a .aac .wma .flac).",
                  ), true)}
                />
                <button
                  className="small"
                  disabled={!settings.config[row.configKey]}
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
      )}

      {section === "locks" && (
      <Card
        id="set-locks"
        title={t("并发锁", "Concurrency locks")}
        desc={t(
          "并发写同一个目录时让第二个调用者等待，而不是互相覆盖。",
          "When two calls write the same directory, the second waits instead of the two overwriting each other.",
        )}
      >
        <SwitchField
          label={t("串行化可能产生竞争的工具调用", "Serialize tool calls that could race")}
          checked={settings.concurrency.enabled}
          onChange={next => void act({
            command: "setConcurrency",
            enabled: next,
            holdTimeoutMs: settings.concurrency.holdTimeoutMs,
            waitTimeoutMs: settings.concurrency.waitTimeoutMs,
          })}
        />
        {settings.concurrency.enabled && (
          <div className="form-grid">
            <Field label={t("占用上限", "Hold ceiling")} hint={t("毫秒，0 = 不限；失焦时保存。", "Milliseconds, 0 = unlimited; saved on blur.")}>
              <DraftField
                type="number"
                min={NUMBER_BOUNDS.holdTimeoutMs.min}
                max={NUMBER_BOUNDS.holdTimeoutMs.max}
                value={String(settings.concurrency.holdTimeoutMs)}
                onCommit={raw => void act({
                  command: "setConcurrency",
                  enabled: true,
                  holdTimeoutMs: Number(raw.trim()),
                  waitTimeoutMs: settings.concurrency.waitTimeoutMs,
                })}
                onInvalid={invalidFor("holdTimeoutMs")}
              />
            </Field>
            <Field label={t("等待上限", "Wait ceiling")} hint={t("毫秒，0 = 无限等待；失焦时保存。", "Milliseconds, 0 = wait forever; saved on blur.")}>
              <DraftField
                type="number"
                min={NUMBER_BOUNDS.waitTimeoutMs.min}
                max={NUMBER_BOUNDS.waitTimeoutMs.max}
                value={String(settings.concurrency.waitTimeoutMs)}
                onCommit={raw => void act({
                  command: "setConcurrency",
                  enabled: true,
                  holdTimeoutMs: settings.concurrency.holdTimeoutMs,
                  waitTimeoutMs: Number(raw.trim()),
                })}
                onInvalid={invalidFor("waitTimeoutMs")}
              />
            </Field>
          </div>
        )}
      </Card>
      )}

    </>
  );
}
