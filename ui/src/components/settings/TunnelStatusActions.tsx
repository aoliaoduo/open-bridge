import { useEffect, useState } from "react";
import { api, type Act, type SettingsState, type SettingsTunnelView } from "../../api";
import { t } from "../../i18n";
import { Chip } from "../Chip";

const REACH_LABELS: Record<string, () => string> = {
  tunnel: () => t("隧道", "Tunnel"),
  public: () => t("公网连通", "Public reach"),
  exposure: () => t("暴露面", "Exposure"),
};

interface ReachResult {
  tone: "ok" | "warn" | "err";
  lines: string[];
}

interface Props {
  settings: SettingsState;
  act: Act;
  tunnel: SettingsTunnelView | null;
  onReload: () => Promise<void>;
}

function factLines(settings: SettingsState, tunnel: SettingsTunnelView | null): string[] {
  const facts = tunnel?.facts;
  if (!facts) return [];
  const provider = settings.config.tunnelProvider;

  if (provider === "ngrok") {
    const ngrok = facts.ngrok;
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
    const ts = facts.tailscale;
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
}

function autoConfigPreview(tunnel: SettingsTunnelView | null): string {
  if (!tunnel) return t("正在检测本机环境…", "Checking this machine…");
  const writes = tunnel.plan.writes;
  if (!writes.length) {
    return tunnel.plan.blocked
      ? t(`还不能配置：${tunnel.plan.blocked}`, `Not configurable yet: ${tunnel.plan.blocked}`)
      : t(
        "没有要写的值：你填过的都不会被覆盖，点一下只做重新检测。",
        "Nothing to write: values you set are never overwritten; pressing it only re-checks.",
      );
  }
  const list = writes
    .map(write => write.kind === "secret" ? write.label : `${write.key}=${write.value}`)
    .join("、");
  return t(`将写入：${list}。你填过的值不会被覆盖。`, `Will write: ${list}. Values you set are never overwritten.`);
}

export function TunnelStatusActions({ settings, act, tunnel, onReload }: Props) {
  const [tunnelBusy, setTunnelBusy] = useState(false);
  const [reach, setReach] = useState<ReachResult | null>(null);
  const [reachBusy, setReachBusy] = useState(false);

  useEffect(() => {
    setReach(null);
  }, [tunnel, settings.config.tunnelProvider]);

  if (settings.config.tunnelProvider === "none") return null;

  const tunnelReady = Boolean(settings.mcpUrl) && !/127\.0\.0\.1|localhost/.test(settings.mcpUrl);
  const lines = factLines(settings, tunnel);

  return (
    <>
      <div className="field span2">
        <span className="field-label">{t("状态", "Status")}</span>
        <span className="field-control">
          <Chip tone={tunnelReady ? "ok" : "warn"}>
            {tunnelReady ? t("公网地址已发布", "published") : t("尚未发布（只有本机能访问）", "not published (local only)")}
          </Chip>
          {settings.mcpUrl ? <span className="field-hint mono">{settings.mcpUrl}</span> : null}
        </span>
        {tunnel?.facts ? lines.map(line => (
          <span className="field-hint" key={line}>{line}</span>
        )) : (
          <span className="field-hint">{t("正在检测本机环境…", "Checking this machine…")}</span>
        )}
      </div>

      <div className="field span2">
        <span className="field-control">
          <button
            className="small"
            disabled={tunnelBusy || !tunnel}
            onClick={() => {
              setTunnelBusy(true);
              setReach(null);
              void act({ command: "autoConfigureTunnel" })
                .finally(() => {
                  setTunnelBusy(false);
                  void onReload();
                });
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
                .finally(() => {
                  setTunnelBusy(false);
                  void onReload();
                });
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
                  const verified = publicCheck?.ok === true && (publicCheck.level ?? "ok") === "ok";
                  setReach({
                    tone: failed ? "err" : verified ? "ok" : "warn",
                    lines: [
                      ...rows.map(row => `${REACH_LABELS[row.name]?.() ?? row.name}：${row.detail}`),
                      failed
                        ? t(
                          "下一步：确认隧道进程在跑（「状态」页有隧道日志），或先点「重新检测」看本机环境。",
                          "Next: check the tunnel process (the status page logs it), or press Detect again to see what this machine has.",
                        )
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

        <span className="field-hint">{autoConfigPreview(tunnel)}</span>
        {reach ? (
          <span className="field-control">
            <Chip tone={reach.tone}>
              {reach.tone === "ok"
                ? t("公网可达", "reachable")
                : reach.tone === "warn"
                  ? t("公网未验证", "public reach unverified")
                  : t("有问题", "problem")}
            </Chip>
          </span>
        ) : null}
        {reach?.lines.map(line => <span className="field-hint" key={line}>{line}</span>)}
      </div>
    </>
  );
}
