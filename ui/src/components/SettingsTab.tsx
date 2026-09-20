import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SettingsActionResult, type SettingsState, type SettingsTunnelView } from "../api";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../routes";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
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
 * Fields validate on commit: an invalid value is REVERTED to the saved one
 * with a toast, never silently kept — the old behaviour left the input showing
 * a value the config did not hold, and the operator only found out on the next
 * reload.
 *
 * Number fields check the server's bounds. Text fields check `validate` when
 * one is given: that hook exists because the two sound-path fields already
 * passed an onInvalid promising "needs an absolute path to an audio file",
 * and nothing ever called it — the check ran for numbers only, so any string
 * was committed. A mistyped path then failed silently at play time, which is
 * indistinguishable from the feature being switched off.
 */
export function DraftField({
  value,
  onCommit,
  onInvalid,
  validate,
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
  /**
   * Accept/reject a non-empty text value. Empty is always allowed and never
   * asked about: clearing a field is how an optional setting is unset, and
   * running a "must be an audio file" check over "" would make it impossible.
   */
  validate?: (raw: string) => boolean;
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
  // A reply to the previous commit may arrive after the next edit. Only
  // pristine / submitted drafts follow it; newer unsubmitted edits belong to
  // the operator, even when they happen to equal the old saved value.
  const editedSinceCommit = useRef(false);
  useEffect(() => {
    if (!editedSinceCommit.current) setDraft(value);
  }, [value]);
  const change = (next: string): void => {
    editedSinceCommit.current = true;
    setDraft(next);
  };
  const commit = (): void => {
    editedSinceCommit.current = false;
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
    } else if (validate && draft.trim() !== "" && !validate(draft.trim())) {
      onInvalid?.();
      setDraft(value);
      return;
    }
    onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        rows={4}
        value={draft}
        placeholder={placeholder}
        onChange={e => change(e.target.value)}
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
      onChange={e => change(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

/** A switch field: label on top, the switch plus its current state under it. */
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

/**
 * The three checks a tunnel verdict is made of, named the way the card talks
 * about them (the 体检 page has its own, longer table).
 */
const REACH_LABELS: Record<string, () => string> = {
  tunnel: () => t("隧道", "Tunnel"),
  public: () => t("公网连通", "Public reach"),
  exposure: () => t("暴露面", "Exposure"),
};

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
  const [domainBusy, setDomainBusy] = useState(false);
  const domainInFlight = useRef(false);
  /**
   * What the machine has for each tunnel provider, and the plan 「自动配置」
   * would run. Fetched after the page renders (producing it spawns the provider
   * CLIs), so the card appears immediately and fills in when the answer lands —
   * null means "not asked yet", and the card renders without it rather than
   * flashing an empty state it cannot back up.
   */
  const [tunnel, setTunnel] = useState<SettingsTunnelView | null>(null);
  const [tunnelBusy, setTunnelBusy] = useState(false);
  /** The advanced fold: every manual knob, one click away, out of the way. */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** Revealed when the domain list is empty or the operator picks 手动填写. */
  const [manualDomain, setManualDomain] = useState(false);
  const [reach, setReach] = useState<{ tone: "ok" | "warn" | "err"; lines: string[] } | null>(null);
  const [reachBusy, setReachBusy] = useState(false);

  const reloadTunnel = useCallback(async () => {
    try {
      setTunnel(await api.tunnel());
    } catch {
      // The card works without reconnaissance: detection is a convenience, and
      // the manual fields behind 高级 are still there when it fails.
      setTunnel(null);
    }
  }, []);

  // Probe only for the section that shows it — the walk to 文件访问 must not
  // wait on (or pay for) a tailscale spawn.
  useEffect(() => { if (section === "tunnel") void reloadTunnel(); }, [section, reloadTunnel]);

  // A draft for the device-key field (separate from the stored key so the
  // mask shown vs. replaced stay distinguishable; null means "no edit yet").
  const [barkKeyDraft, setBarkKeyDraft] = useState<string | null>(null);
  const [authtokenDraft, setAuthtokenDraft] = useState<string | null>(null);
  const [tailscaleDomainDraft, setTailscaleDomainDraft] = useState<string | null>(null);

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

  // ---- the tunnel card's derived state -----------------------------------
  const tunnelFacts = tunnel?.facts;
  const typedDomain = manualDomain || (domainValue !== "" && !tunnelFacts?.ngrok.domains.includes(domainValue));
  const provider = cfg.tunnelProvider;
  // Published = the URL the page is showing is not a loopback one.
  const tunnelReady = Boolean(settings.mcpUrl) && !/127\.0\.0\.1|localhost/.test(settings.mcpUrl);
  const resolvedTailscaleExe = tunnelFacts?.tailscale.installed ? tunnelFacts.tailscale.executable : undefined;
  const tailscales = tunnelFacts?.tailscale.installed
    ? [{ value: tunnelFacts.tailscale.executable, label: tunnelFacts.tailscale.executableLabel, available: true }]
    : [];

  /** Read-only facts, in the operator's words, for the selected provider. */
  const tunnelFactLines = ((): string[] => {
    if (!tunnelFacts) return [];
    if (provider === "ngrok") {
      const ngrok = tunnelFacts.ngrok;
      return [
        ngrok.installed
          ? t(`ngrok：已安装（${ngrok.executableLabel || "已定位"}）`, `ngrok: installed (${ngrok.executableLabel || "located"})`)
          : t("ngrok：这台机器上没找到", "ngrok: not found on this machine"),
        ngrok.authtokenSource === "stored"
          ? t("authtoken：已保存（凭据库）", "authtoken: saved (credential store)")
          : ngrok.authtokenSource === "ngrok-config"
            ? t("authtoken：可以从本机 ngrok 配置导入", "authtoken: importable from ngrok's own config")
            : t("authtoken：还没有（隧道起不来）", "authtoken: none yet (the tunnel cannot start)"),
        ngrok.domains.length
          ? t(`保留域名：${ngrok.domains.length} 个（可在上面选）`, `reserved domains: ${ngrok.domains.length} (choose one above)`)
          : ngrok.domainsError
            ? t(`保留域名：读不到（${ngrok.domainsError}）`, `reserved domains: unavailable (${ngrok.domainsError})`)
            : t("保留域名：账号下还没有", "reserved domains: none on this account"),
      ];
    }
    if (provider === "tailscale") {
      const ts = tunnelFacts.tailscale;
      return [
        ts.installed
          ? t(`tailscale：已安装（${ts.executableLabel || "已定位"}）`, `tailscale: installed (${ts.executableLabel || "located"})`)
          : t("tailscale：这台机器上没找到", "tailscale: not found on this machine"),
        ts.loggedIn
          ? t(`已登录 · ${ts.domain}${ts.online ? "" : "（当前离线）"}`, `signed in · ${ts.domain}${ts.online ? "" : " (offline)"}`)
          : t("还没有登录 tailnet（域名要登录后才存在）", "not signed in to a tailnet yet (the name exists only after that)"),
        ts.mountPort === null
          ? t("443：还没有挂载任何服务", "443: nothing mounted yet")
          : ts.mountPublic
            ? t(`443 → 本机端口 ${ts.mountPort}（Funnel 对公网开放）`, `443 → local port ${ts.mountPort} (Funnel, public)`)
            : t(`443 → 本机端口 ${ts.mountPort}（只对 tailnet 内可见，公网不通）`, `443 → local port ${ts.mountPort} (tailnet only, not public)`),
      ];
    }
    return [];
  })();

  /**
   * What pressing 「一键自动配置」 will write, taken from the same plan the
   * server executes — so the promise above the button and the write below it
   * are one object.
   */
  const autoConfigPreview = ((): string => {
    if (!tunnel) return t("正在检测本机环境…", "Checking this machine…");
    const writes = tunnel.plan.writes;
    if (!writes.length) {
      return tunnel.plan.blocked
        ? t(`还不能配置：${tunnel.plan.blocked}`, `Not configurable yet: ${tunnel.plan.blocked}`)
        : t("没有要写的值：你填过的都不会被覆盖，点一下只做重新检测。",
            "Nothing to write: values you set are never overwritten; pressing it only re-checks.");
    }
    const list = writes.map(write => write.kind === "secret" ? write.label : `${write.key}=${write.value}`).join("、");
    return t(`将写入：${list}。你填过的值不会被覆盖。`, `Will write: ${list}. Values you set are never overwritten.`);
  })();

  const setConfig = (key: string, value: unknown) => { void act({ command: "setConfig", key, value }); };

  /**
   * Commit a number the DraftField has already validated against NUMBER_BOUNDS
   * (it reverts and reports the rejection itself, via `invalidFor`). Re-checking
   * here would be a second copy of the same rule that can only ever agree.
   */
  const commitNumber = (key: keyof typeof NUMBER_BOUNDS, raw: string): void => {
    setConfig(key, Number(raw.trim()));
  };

  /** One explicit domain write, shared by the dropdown and manual save. */
  const saveDomain = async (raw: string): Promise<void> => {
    if (domainInFlight.current) return;
    const next = raw.trim();
    if (next === settings.configuredDomain) {
      setDomain(current => current === raw ? null : current);
      return;
    }
    domainInFlight.current = true;
    setDomainBusy(true);
    try {
      const result = await act({ command: "saveDomain", domain: next }) as SettingsActionResult | null;
      if (result?.ok) {
        // Do not clear a newer draft typed while this save was outstanding.
        setDomain(current => current === raw ? null : current);
        setReach(null);
        void reloadTunnel();
      }
    } finally {
      domainInFlight.current = false;
      setDomainBusy(false);
    }
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
        {/* One provider selector, then the SAME three parts in the same order
            whichever provider is chosen: what this machine already has (read
            only), the two actions that configure and verify it, and an advanced
            fold holding every manual knob. The two providers used to render
            different fields with different words — which read as two unrelated
            features rather than one choice. */}
        <div className="form-grid">
          <Field
            label={t("提供商", "Provider")}
            hint={t(
              "两边都能自动配置：ngrok 用你账号里的保留域名，Tailscale Funnel 用本机的 ts.net 域名（免费版限 443 端口）。选一个，然后点下面的「一键自动配置」。",
              "Both configure themselves: ngrok serves one of your account's reserved domains, Tailscale Funnel serves this machine's ts.net name (free tier: port 443). Pick one, then press Auto-configure below.",
            )}
          >
            <select value={cfg.tunnelProvider} onChange={e => {
              setConfig("tunnelProvider", e.target.value);
              setReach(null);
              void reloadTunnel();
            }}>
              <option value="ngrok">ngrok</option>
              <option value="tailscale">Tailscale Funnel</option>
              <option value="none">{t("none（仅本地）", "none (local only)")}</option>
            </select>
          </Field>

          {cfg.tunnelProvider === "ngrok" && tunnelFacts && (
            <Field
              label={t("公网地址", "Public address")}
              hint={tunnelFacts.ngrok.domains.length
                ? t("来自你 ngrok 账号里的保留域名；留空时下次启动仅本机可用，保存不会立即重启现有隧道。",
                    "Your account's reserved domains. An empty value keeps the next tunnel start local-only; saving does not restart the current tunnel.")
                : t("留空时下次启动仅本机可用，保存不会立即重启现有隧道。想让保留域名出现在下拉里：把 ngrok 后台的 API key 写进 ngrok.yml 的 api_key 一行（authtoken 不能用于 API）。",
                    "An empty value keeps the next tunnel start local-only; saving does not restart the current tunnel. For a domain dropdown here, put an API key on the api_key line of ngrok.yml — an authtoken does not work for the API.")}
            >
              {tunnelFacts.ngrok.domains.length > 0 ? (
                <select
                  aria-label={t("公网地址", "Public address")}
                  value={typedDomain ? "__manual__" : domainValue}
                  disabled={domainBusy}
                  onChange={e => {
                    const next = e.target.value;
                    if (next === "__manual__") { setManualDomain(true); return; }
                    setManualDomain(false);
                    setDomain(next);
                    void saveDomain(next);
                  }}
                >
                  <option value="">{t("未设置域名（下次启动仅本机）", "No domain (local-only on next start)")}</option>
                  {tunnelFacts.ngrok.domains.map(name => <option key={name} value={name}>{name}</option>)}
                  <option value="__manual__">{t("手动填写…", "Type one…")}</option>
                </select>
              ) : null}
              {(tunnelFacts.ngrok.domains.length === 0 || typedDomain) && (
                <span className="field-control">
                  <input
                    type="text"
                    aria-label={t("公网地址（手动填写）", "Public address (typed)")}
                    value={domainValue}
                    placeholder="example.ngrok-free.dev"
                    onChange={e => setDomain(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") { e.preventDefault(); void saveDomain(domainValue); }
                    }}
                  />
                  <button
                    className="small"
                    disabled={domainBusy || domain === null || domainValue.trim() === settings.configuredDomain}
                    onClick={() => void saveDomain(domainValue)}
                  >
                    {t("保存域名", "Save domain")}
                  </button>
                </span>
              )}
            </Field>
          )}

          {cfg.tunnelProvider !== "none" && (
          <div className="field span2">
            <span className="field-label">{t("状态", "Status")}</span>
            <span className="field-control">
              <Chip tone={tunnelReady ? "ok" : "warn"}>
                {tunnelReady ? t("公网地址已发布", "published") : t("尚未发布（只有本机能访问）", "not published (local only)")}
              </Chip>
              {settings.mcpUrl ? <span className="field-hint mono">{settings.mcpUrl}</span> : null}
            </span>
            {/* What the machine has, read only — the half of "自动配置" the
                operator should be able to check BEFORE pressing it. */}
            {tunnelFacts ? tunnelFactLines.map(line => (
              <span className="field-hint" key={line}>{line}</span>
            )) : (
              <span className="field-hint">{t("正在检测本机环境…", "Checking this machine…")}</span>
            )}
          </div>
          )}

          {cfg.tunnelProvider !== "none" && (
          <div className="field span2">
            <span className="field-control">
              <button
                className="small"
                disabled={tunnelBusy || !tunnel}
                onClick={() => {
                  setTunnelBusy(true);
                  setReach(null);
                  // act() already reports the outcome: its info line names every
                  // value written and everything it deliberately left alone.
                  void act({ command: "autoConfigureTunnel" })
                    .finally(() => { setTunnelBusy(false); void reloadTunnel(); });
                }}
              >
                {t("一键自动配置", "Auto-configure")}
              </button>
              <button
                className="small ghost"
                disabled={tunnelBusy}
                onClick={() => {
                  setTunnelBusy(true);
                  void act({ command: "refreshTunnelDetect" })
                    .finally(() => { setTunnelBusy(false); void reloadTunnel(); });
                }}
              >
                {t("重新检测", "Detect again")}
              </button>
              <button
                className="small ghost"
                disabled={reachBusy}
                onClick={() => {
                  setReachBusy(true);
                  setReach(null);
                  void api.health()
                    .then(report => {
                      const wanted = ["tunnel", "public", "exposure"];
                      const rows = report.checks.filter(check => wanted.includes(check.name));
                      const failed = rows.some(row => (row.level ?? (row.ok ? "ok" : "fail")) === "fail");
                      const publicCheck = rows.find(row => row.name === "public");
                      // Local-only reports legitimately omit this probe. No
                      // failed rows is not evidence that the internet got in.
                      const verified = publicCheck?.ok === true && (publicCheck.level ?? "ok") === "ok";
                      setReach({
                        tone: failed ? "err" : verified ? "ok" : "warn",
                        lines: [
                          ...rows.map(row => `${REACH_LABELS[row.name]?.() ?? row.name}：${row.detail}`),
                          failed
                            ? t("下一步：确认隧道进程在跑（「状态」页有隧道日志），或先点「重新检测」看本机环境。",
                                "Next: check the tunnel process (the status page logs it), or press Detect again to see what this machine has.")
                            : verified
                              ? t("公网上的客户端现在可以连到这个地址。", "A client on the internet can reach this address now.")
                              : t("尚无成功的公网探测；请先发布隧道地址，再重新测试。", "No successful public probe yet; publish a tunnel address, then test again."),
                        ],
                      });
                    })
                    .catch(error => setReach({ tone: "err", lines: [String(error)] }))
                    .finally(() => setReachBusy(false));
                }}
              >
                {t("测试公网可达", "Test public reach")}
              </button>
            </span>
            {/* Say what the click will write, before the click: the server runs
                exactly this plan, so the two cannot disagree. */}
            <span className="field-hint">{autoConfigPreview}</span>
            {reach ? (
              <span className="field-control">
                <Chip tone={reach.tone}>{reach.tone === "ok"
                  ? t("公网可达", "reachable")
                  : reach.tone === "warn"
                    ? t("公网未验证", "public reach unverified")
                    : t("有问题", "problem")}</Chip>
              </span>
            ) : null}
            {reach?.lines.map(line => <span className="field-hint" key={line}>{line}</span>)}
          </div>
          )}

          {cfg.tunnelProvider !== "none" && (
          <div className="field span2">
            <span className="field-control">
              <button
                className="small ghost"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen(open => !open)}
              >
                {advancedOpen
                  ? t("收起高级设置", "Hide advanced settings")
                  : t("高级设置（可执行文件、手动填写的值）", "Advanced settings (executables, manual values)")}
              </button>
            </span>
            <span className="field-hint">
              {t("平时不用打开：上面的「一键自动配置」会把这些填好。",
                  "You rarely need this: Auto-configure above fills these in.")}
            </span>
          </div>
          )}

          {advancedOpen && cfg.tunnelProvider !== "none" && (
          <>
          {/* Both providers keep every knob that was here before — folding is a
              way to get them out of a novice's way, not to remove capability. */}
          <Field
            label={cfg.tunnelProvider === "ngrok"
              ? t("ngrok 可执行文件", "ngrok executable")
              : t("Tailscale 可执行文件", "Tailscale executable")}
            hint={cfg.tunnelProvider === "ngrok"
              ? (ngroks.length
                ? t("已找到下面这些 ngrok；隧道起不来时，多半是这里选错了副本。",
                    "These ngrok copies were found. When a tunnel refuses to start, this is usually the wrong one.")
                : t("这台机器上没找到 ngrok：先从 ngrok.com 下载，再回来点「重新检测」。",
                    "No ngrok found here: download it from ngrok.com, then press Detect again."))
              : (resolvedTailscaleExe
                ? t("MSI 安装默认不加入 PATH；找不到时在这里指出它的位置。",
                    "The MSI does not add itself to PATH; point at it here when it cannot be found.")
                : t("没有探测到 tailscale；装好并登录后再点「重新检测」。",
                    "No tailscale was detected; install and log in, then press Detect again."))}
          >
            {cfg.tunnelProvider === "ngrok" ? (
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
            ) : (
              <ExecutablePicker
                value={cfg.tailscaleExecutable}
                choices={tailscales}
                autoValues={[""]}
                autoLabel={resolvedTailscaleExe ?? t("按 PATH 与默认安装目录查找", "PATH, then the default install directory")}
                placeholder={t("tailscale 可执行文件的完整路径", "Full path to the tailscale executable")}
                onCommit={next => setConfig("tailscaleExecutable", next)}
              />
            )}
          </Field>

          {cfg.tunnelProvider === "ngrok" ? (
            <>
            <div className="field">
              <span className="field-label">{t("Authtoken", "Authtoken")}</span>
              <span className="field-control">
                <input
                  type="text"
                  aria-label={t("Authtoken", "Authtoken")}
                  value={authtokenDraft ?? settings.ngrokAuthtokenMask}
                  placeholder={settings.ngrokAuthtokenMask
                    ? t("粘贴新的 authtoken 可替换（输入框仅显示掩码）", "Paste a new authtoken to replace it (the field only shows a mask)")
                    : t("用「一键自动配置」从本机 ngrok 配置导入，或在这里粘贴", "Let Auto-configure import it from ngrok's own config, or paste it here")}
                  readOnly={Boolean(settings.ngrokAuthtokenMask) && authtokenDraft === null}
                  onChange={e => setAuthtokenDraft(e.target.value)}
                />
                <button
                  className="small"
                  disabled={authtokenDraft === null}
                  onClick={() => {
                    void act({ command: "saveNgrokAuthtoken", token: authtokenDraft ?? "" }).then(result => {
                      if ((result as SettingsActionResult | null)?.ok) setAuthtokenDraft(null);
                      void reloadTunnel();
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
                  "ngrok 需要一次性登记账号凭据才能建立隧道。以前只能在终端跑 ngrok config add-authtoken；本机跑过那条命令的话，点「一键自动配置」就会把它读进来。保存后重启实例生效。",
                  "ngrok needs your account credential once before it can open a tunnel. This used to require running ngrok config add-authtoken in a terminal; if you already ran it, Auto-configure imports it. A change takes effect on the next start.",
                )}
              </span>
            </div>
            <SwitchField
              label={t("ngrok 继承系统代理", "ngrok inherits the system proxy")}
              hint={t("公司网络需要走代理时打开；直连环境关掉更快。", "Turn on behind a corporate proxy; leave off for a direct connection, which is faster.")}
              checked={cfg.ngrokUseHttpProxy}
              onChange={next => setConfig("ngrokUseHttpProxy", next)}
            />
            </>
          ) : (
            <>
            <div className="field">
              <span className="field-label">{t("公网域名", "Public domain")}</span>
              <span className="field-control">
                <input
                  type="text"
                  value={tailscaleDomainDraft ?? cfg.tailscaleDomain}
                  placeholder={t("留空＝每次启动从 tailscale CLI 自动发现", "Empty = discovered from the tailscale CLI at each start")}
                  onChange={e => setTailscaleDomainDraft(e.target.value)}
                />
                <button
                  className="small"
                  disabled={tailscaleDomainDraft === null}
                  onClick={() => {
                    void act({ command: "setConfig", key: "tailscaleDomain", value: tailscaleDomainDraft ?? "" }).then(result => {
                      if ((result as SettingsActionResult | null)?.ok) setTailscaleDomainDraft(null);
                      void reloadTunnel();
                    });
                  }}
                >
                  {t("保存域名", "Save domain")}
                </button>
              </span>
              <span className="field-hint">
                {t("留空最省事：开启隧道时按 tailscale CLI 报告的 ts.net 名自动填写。手填的值若与 CLI 报告的不一致，启动时会报错，而不是悄悄用错的名字。",
                    "Empty is simplest: the ts.net name the tailscale CLI reports is filled in when the tunnel starts. A manual value that disagrees with it is a start-up error rather than a silently wrong host.")}
              </span>
            </div>
            </>
          )}

          <SwitchField
            label={t("隧道意外退出时自动重连", "Reconnect automatically if the tunnel dies")}
            hint={t("伴随进程退出时按退避重试，不需要人工点重新启动。", "Retries with backoff when the companion process exits, so nobody has to click restart.")}
            checked={cfg.autoReconnect}
            onChange={next => setConfig("autoReconnect", next)}
          />
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
                  validate={isSoundPath}
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
