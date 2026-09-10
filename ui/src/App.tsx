import { useCallback, useEffect, useRef, useState } from "react";
import { api, copyText, type SecretPayload, type SettingsActionResult, type SettingsState } from "./api";
import { StatusTab } from "./components/StatusTab";
import { SettingsTab } from "./components/SettingsTab";
import { TokensTab } from "./components/TokensTab";
import { LogsTab } from "./components/LogsTab";
import { StatsTab } from "./components/StatsTab";
import { ServicesTab } from "./components/ServicesTab";

type TabId = "status" | "settings" | "tokens" | "services" | "logs" | "stats";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "status", label: "状态" },
  { id: "settings", label: "设置" },
  { id: "tokens", label: "令牌" },
  { id: "services", label: "服务" },
  { id: "logs", label: "日志" },
  { id: "stats", label: "统计" },
];

export interface ToastMsg { text: string; isError: boolean; key: number }

export function App() {
  const [tab, setTab] = useState<TabId>("status");
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [secret, setSecret] = useState<SecretPayload | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = useCallback((text: string, isError = false) => {
    clearTimeout(toastTimer.current);
    setToast({ text, isError, key: Date.now() });
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await api.settings());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    }
  }, [showToast]);

  useEffect(() => { void refreshSettings(); }, [refreshSettings]);

  /** Run one settings action; applies state/toast/secret/copy side effects. */
  const act = useCallback(async (action: Record<string, unknown>): Promise<SettingsActionResult | null> => {
    try {
      const result = await api.settingsAction(action);
      setSettings(result.state);
      if (result.secret) setSecret(result.secret);
      if (result.copyText) await copyText(result.copyText);
      if (result.error) showToast(result.error, true);
      else if (result.info) showToast(result.info);
      if (result.reloadRequired) {
        // The console token is injected into this document server-side, so a
        // route-token rotation leaves the in-page copy stale: every action from
        // here on would 403. Reload to pick up the freshly injected one, after
        // the toast has told the operator why.
        window.setTimeout(() => window.location.reload(), 1200);
      }
      return result;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
      return null;
    }
  }, [showToast]);

  return (
    <div className="shell">
      <div className="topbar">
        <h1>Open Bridge 控制台</h1>
        <span className={`badge ${settings?.running ? "on" : "off"}`}>
          {settings ? settings.statusText : "连接中…"}
        </span>
      </div>

      <div className="tabs">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "status" && <StatusTab settings={settings} act={act} onRefresh={refreshSettings} />}
      {tab === "settings" && <SettingsTab settings={settings} act={act} />}
      {tab === "tokens" && <SettingsStateGuard settings={settings}><TokensTab settings={settings!} act={act} /></SettingsStateGuard>}
      {tab === "services" && <ServicesTab />}
      {tab === "logs" && <LogsTab />}
      {tab === "stats" && <StatsTab />}

      <div className={`toast ${toast ? "show" : ""} ${toast?.isError ? "error" : ""}`} key={toast?.key}>
        {toast?.text}
      </div>

      {secret && (
        <div className="mask" onClick={() => setSecret(null)}>
          <div className="card" onClick={event => event.stopPropagation()}>
            <h2>{secret.kind === "minted" ? "令牌已创建" : "令牌已轮换"}</h2>
            <div className="section-note">
              {secret.label} · {secret.ttl} — 明文只显示这一次，请立即保存。
            </div>
            <div className="secret-value">{secret.secret}</div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button onClick={() => { void copyText(secret.secret); showToast("密钥已复制。"); }}>复制</button>
              <button className="primary" onClick={() => setSecret(null)}>我已保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsStateGuard({ settings, children }: { settings: SettingsState | null; children: React.ReactNode }) {
  if (!settings) return <div className="card">加载中…</div>;
  return <>{children}</>;
}
