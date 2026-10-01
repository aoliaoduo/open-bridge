import { useState } from "react";
import type { Act, SettingsState, SettingsTunnelView } from "../../api";
import { t } from "../../i18n";
import { ExecutablePicker } from "../ExecutablePicker";
import { Field } from "../Field";
import { SwitchField } from "./SwitchField";
import type { TunnelConfigKey } from "./TunnelProviderFields";

interface Props {
  settings: SettingsState;
  act: Act;
  tunnel: SettingsTunnelView | null;
  onConfig: (key: TunnelConfigKey, value: string) => Promise<void>;
  onSetConfig: (key: string, value: unknown) => void;
  onReload: () => Promise<void>;
}

/** Manual provider controls kept behind the advanced fold. */
export function TunnelAdvancedSettings({
  settings,
  act,
  tunnel,
  onConfig,
  onSetConfig,
  onReload,
}: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [authtokenDraft, setAuthtokenDraft] = useState<string | null>(null);
  const [tailscaleDomainDraft, setTailscaleDomainDraft] = useState<string | null>(null);

  const cfg = settings.config;
  if (cfg.tunnelProvider === "none") return null;

  const facts = tunnel?.facts;
  const ngroks = settings.detected?.ngrok ?? [];
  const autoNgrokLabel = ngroks[0]
    ? `${ngroks[0].label} — ${ngroks[0].value}`
    : t("PATH 里的 ngrok", "the ngrok on PATH");
  const resolvedTailscaleExe = facts?.tailscale.installed ? facts.tailscale.executable : undefined;
  const tailscales = facts?.tailscale.installed
    ? [{ value: facts.tailscale.executable, label: facts.tailscale.executableLabel, available: true }]
    : [];

  return (
    <>
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
          {t(
            "平时不用打开：上面的「一键自动配置」会把这些填好。",
            "You rarely need this: Auto-configure above fills these in.",
          )}
        </span>
      </div>

      {advancedOpen && (
        <>
          <Field
            label={cfg.tunnelProvider === "ngrok"
              ? t("ngrok 可执行文件", "ngrok executable")
              : t("Tailscale 可执行文件", "Tailscale executable")}
            hint={cfg.tunnelProvider === "ngrok"
              ? (ngroks.length
                ? t(
                  "已找到下面这些 ngrok；隧道起不来时，多半是这里选错了副本。",
                  "These ngrok copies were found. When a tunnel refuses to start, this is usually the wrong one.",
                )
                : t(
                  "这台机器上没找到 ngrok：先从 ngrok.com 下载，再回来点「重新检测」。",
                  "No ngrok found here: download it from ngrok.com, then press Detect again.",
                ))
              : (resolvedTailscaleExe
                ? t(
                  "MSI 安装默认不加入 PATH；找不到时在这里指出它的位置。",
                  "The MSI does not add itself to PATH; point at it here when it cannot be found.",
                )
                : t(
                  "没有探测到 tailscale；装好并登录后再点「重新检测」。",
                  "No tailscale was detected; install and log in, then press Detect again.",
                ))}
          >
            {cfg.tunnelProvider === "ngrok" ? (
              <ExecutablePicker
                value={cfg.ngrokExecutable}
                choices={ngroks}
                autoValues={["", "ngrok"]}
                autoLabel={autoNgrokLabel}
                placeholder={t("ngrok 可执行文件的完整路径", "Full path to the ngrok executable")}
                onCommit={next => { void onConfig("ngrokExecutable", next); }}
              />
            ) : (
              <ExecutablePicker
                value={cfg.tailscaleExecutable}
                choices={tailscales}
                autoValues={[""]}
                autoLabel={resolvedTailscaleExe ?? t("按 PATH 与默认安装目录查找", "PATH, then the default install directory")}
                placeholder={t("tailscale 可执行文件的完整路径", "Full path to the tailscale executable")}
                onCommit={next => { void onConfig("tailscaleExecutable", next); }}
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
                      ? t(
                        "粘贴新的 authtoken 可替换（输入框仅显示掩码）",
                        "Paste a new authtoken to replace it (the field only shows a mask)",
                      )
                      : t(
                        "用「一键自动配置」从本机 ngrok 配置导入，或在这里粘贴",
                        "Let Auto-configure import it from ngrok's own config, or paste it here",
                      )}
                    readOnly={Boolean(settings.ngrokAuthtokenMask) && authtokenDraft === null}
                    onChange={e => setAuthtokenDraft(e.target.value)}
                  />
                  <button
                    className="small"
                    disabled={authtokenDraft === null}
                    onClick={() => {
                      void act({ command: "saveNgrokAuthtoken", token: authtokenDraft ?? "" }).then(result => {
                        if (result?.ok) setAuthtokenDraft(null);
                        void onReload();
                      });
                    }}
                  >
                    {t("保存 Authtoken", "Save authtoken")}
                  </button>
                  {Boolean(settings.ngrokAuthtokenMask) && authtokenDraft === null && (
                    <button
                      className="small ghost"
                      onClick={() => setAuthtokenDraft("")}
                      title={t(
                        "粘贴新 token 整串替换；清空后点保存即删除",
                        "Paste a new token to replace it wholesale; clear the field and save to remove it",
                      )}
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
                hint={t(
                  "公司网络需要走代理时打开；直连环境关掉更快。",
                  "Turn on behind a corporate proxy; leave off for a direct connection, which is faster.",
                )}
                checked={cfg.ngrokUseHttpProxy}
                onChange={next => onSetConfig("ngrokUseHttpProxy", next)}
              />
            </>
          ) : (
            <div className="field">
              <span className="field-label">{t("公网域名", "Public domain")}</span>
              <span className="field-control">
                <input
                  type="text"
                  value={tailscaleDomainDraft ?? cfg.tailscaleDomain}
                  placeholder={t(
                    "留空＝每次启动从 tailscale CLI 自动发现",
                    "Empty = discovered from the tailscale CLI at each start",
                  )}
                  onChange={e => setTailscaleDomainDraft(e.target.value)}
                />
                <button
                  className="small"
                  disabled={tailscaleDomainDraft === null}
                  onClick={() => {
                    void act({
                      command: "setConfig",
                      key: "tailscaleDomain",
                      value: tailscaleDomainDraft ?? "",
                    }).then(result => {
                      if (result?.ok) setTailscaleDomainDraft(null);
                      void onReload();
                    });
                  }}
                >
                  {t("保存域名", "Save domain")}
                </button>
              </span>
              <span className="field-hint">
                {t(
                  "留空最省事：开启隧道时按 tailscale CLI 报告的 ts.net 名自动填写。手填的值若与 CLI 报告的不一致，启动时会报错，而不是悄悄用错的名字。",
                  "Empty is simplest: the ts.net name the tailscale CLI reports is filled in when the tunnel starts. A manual value that disagrees with it is a start-up error rather than a silently wrong host.",
                )}
              </span>
            </div>
          )}

          <SwitchField
            label={t("隧道意外退出时自动重连", "Reconnect automatically if the tunnel dies")}
            hint={t(
              "伴随进程退出时按退避重试，不需要人工点重新启动。",
              "Retries with backoff when the companion process exits, so nobody has to click restart.",
            )}
            checked={cfg.autoReconnect}
            onChange={next => onSetConfig("autoReconnect", next)}
          />
        </>
      )}
    </>
  );
}
