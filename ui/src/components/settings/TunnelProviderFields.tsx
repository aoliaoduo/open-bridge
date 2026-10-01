import { useRef, useState } from "react";
import type { Act, SettingsState, SettingsTunnelView } from "../../api";
import { t } from "../../i18n";
import { Field } from "../Field";

export type TunnelConfigKey = "tunnelProvider" | "ngrokExecutable" | "tailscaleExecutable";

interface Props {
  settings: SettingsState;
  act: Act;
  tunnel: SettingsTunnelView | null;
  onConfig: (key: TunnelConfigKey, value: string) => Promise<void>;
  onReload: () => Promise<void>;
}

/**
 * Provider selection plus the provider-owned public address field.
 * Domain draft/serialization lives here so the parent does not coordinate a
 * field-specific state machine.
 */
export function TunnelProviderFields({ settings, act, tunnel, onConfig, onReload }: Props) {
  const [domain, setDomain] = useState<string | null>(null);
  const [domainBusy, setDomainBusy] = useState(false);
  const [manualDomain, setManualDomain] = useState(false);
  const domainInFlight = useRef(false);

  const domainValue = domain ?? settings.configuredDomain;
  const tunnelFacts = tunnel?.facts;
  const typedDomain = manualDomain
    || (domainValue !== "" && !tunnelFacts?.ngrok.domains.includes(domainValue));

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
        setDomain(current => current === raw ? null : current);
        void onReload();
      }
    } finally {
      domainInFlight.current = false;
      setDomainBusy(false);
    }
  };

  return (
    <>
      <Field
        label={t("提供商", "Provider")}
        hint={t(
          "两边都能自动配置：ngrok 用你账号里的保留域名，Tailscale Funnel 用本机的 ts.net 域名（免费版限 443 端口）。选一个，然后点下面的「一键自动配置」。",
          "Both configure themselves: ngrok serves one of your account's reserved domains, Tailscale Funnel serves this machine's ts.net name (free tier: port 443). Pick one, then press Auto-configure below.",
        )}
      >
        <select value={settings.config.tunnelProvider} onChange={e => {
          void onConfig("tunnelProvider", e.target.value);
        }}>
          <option value="ngrok">ngrok</option>
          <option value="tailscale">Tailscale Funnel</option>
          <option value="none">{t("none（仅本地）", "none (local only)")}</option>
        </select>
      </Field>

      {settings.config.tunnelProvider === "ngrok" && tunnelFacts && (
        <Field
          label={t("公网地址", "Public address")}
          hint={tunnelFacts.ngrok.domains.length
            ? t(
              "来自你 ngrok 账号里的保留域名；留空时下次启动仅本机可用，保存不会立即重启现有隧道。",
              "Your account's reserved domains. An empty value keeps the next tunnel start local-only; saving does not restart the current tunnel.",
            )
            : t(
              "留空时下次启动仅本机可用，保存不会立即重启现有隧道。想让保留域名出现在下拉里：把 ngrok 后台的 API key 写进 ngrok.yml 的 api_key 一行（authtoken 不能用于 API）。",
              "An empty value keeps the next tunnel start local-only; saving does not restart the current tunnel. For a domain dropdown here, put an API key on the api_key line of ngrok.yml — an authtoken does not work for the API.",
            )}
        >
          {tunnelFacts.ngrok.domains.length > 0 ? (
            <select
              aria-label={t("公网地址", "Public address")}
              value={typedDomain ? "__manual__" : domainValue}
              disabled={domainBusy}
              onChange={e => {
                const next = e.target.value;
                if (next === "__manual__") {
                  setManualDomain(true);
                  return;
                }
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
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveDomain(domainValue);
                  }
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
    </>
  );
}
