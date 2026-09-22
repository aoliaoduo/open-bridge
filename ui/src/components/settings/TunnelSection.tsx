import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Act, type SettingsState, type SettingsTunnelView } from "../../api";
import { t } from "../../i18n";
import { Card } from "../Card";
import { Chip } from "../Chip";
import { ExecutablePicker } from "../ExecutablePicker";
import { Field } from "../Field";
import { SwitchField } from "./SwitchField";
import { setConfigFor } from "./set-config";

/**
 * The three checks a tunnel verdict is made of, named the way the card talks
 * about them (the 体检 page has its own, longer table).
 */
const REACH_LABELS: Record<string, () => string> = {
  tunnel: () => t("隧道", "Tunnel"),
  public: () => t("公网连通", "Public reach"),
  exposure: () => t("暴露面", "Exposure"),
};

/** The 隧道 sub-page: provider choice, auto-configuration and the manual knobs. */
export function TunnelSection({ settings, act }: {
  settings: SettingsState;
  act: Act;
}) {
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
  // A draft for the device-key-style fields (separate from the stored value so
  // the mask shown vs. replaced stay distinguishable; null means "no edit yet").
  const [authtokenDraft, setAuthtokenDraft] = useState<string | null>(null);
  const [tailscaleDomainDraft, setTailscaleDomainDraft] = useState<string | null>(null);

  const reloadTunnel = useCallback(async () => {
    try {
      setTunnel(await api.tunnel());
    } catch {
      // The card works without reconnaissance: detection is a convenience, and
      // the manual fields behind 高级 are still there when it fails.
      setTunnel(null);
    }
  }, []);

  // This section only mounts while its route is open, so probing on mount is
  // the same "only for the section that shows it" rule the shell used to
  // apply — the walk to 文件访问 must not wait on (or pay for) a tailscale spawn.
  useEffect(() => { void reloadTunnel(); }, [reloadTunnel]);

  const cfg = settings.config;
  const domainValue = domain ?? settings.configuredDomain;
  // What the server found on this machine. Defaulted because an older server
  // (or a hand-built fixture) may not send it, and a missing list must degrade
  // to "type a path", never to a crashed settings page.
  const ngroks = settings.detected?.ngrok ?? [];
  // Name what 自动 will actually do, so choosing it is not an act of faith.
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

  const setConfig = setConfigFor(act);

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
      const result = await act({ command: "saveDomain", domain: next });
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

  return (
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
                    if (result?.ok) setAuthtokenDraft(null);
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
                    if (result?.ok) setTailscaleDomainDraft(null);
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
  );
}
