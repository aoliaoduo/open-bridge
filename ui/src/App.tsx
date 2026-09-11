import { useCallback, useEffect, useRef, useState } from "react";
import { api, copyText, reloadConsole, type SecretPayload, type SettingsActionResult, type SettingsState } from "./api";
import { ROUTES, currentRoute, navigate, routePath, type RouteId } from "./routes";
import { StatusTab } from "./components/StatusTab";
import { SettingsTab } from "./components/SettingsTab";
import { TokensTab } from "./components/TokensTab";
import { LogsTab } from "./components/LogsTab";
import { StatsTab } from "./components/StatsTab";
import { ServicesTab } from "./components/ServicesTab";
import { SessionsPage } from "./components/SessionsPage";
import { ToolsPage } from "./components/ToolsPage";
import { HealthPage } from "./components/HealthPage";

interface ToastMsg { text: string; isError: boolean }

export function App() {
  // The URL is the source of truth for which page is open (see routes.ts): each
  // page survives a reload, can be bookmarked, and can be opened in a second
  // window — none of which was possible while the tabs were component state.
  const [route, setRoute] = useState<RouteId>(() => currentRoute());
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [secret, setSecret] = useState<SecretPayload | null>(null);
  // Bumped by 刷新本页 so the open page remounts and re-reads its data.
  const [reloadKey, setReloadKey] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = useCallback((text: string, isError = false) => {
    clearTimeout(toastTimer.current);
    setToast({ text, isError });
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

  // Back/forward buttons must move between pages too, otherwise pushState would
  // leave the address bar and the rendered page disagreeing.
  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // With several consoles open (one per instance/port) the browser tab is the
  // only thing that says which page this one is.
  useEffect(() => {
    const label = ROUTES.find(item => item.id === route)?.label ?? "控制台";
    document.title = `${label} · Open Bridge 控制台`;
  }, [route]);

  const open = useCallback((id: RouteId) => {
    navigate(id);
    setRoute(id);
  }, []);

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
        window.setTimeout(reloadConsole, 1200);
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
        <svg className="logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2 17h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M4 17v-3a8 8 0 0 1 16 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M8 17v-2.5M12 17v-4.5M16 17v-2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <h1>Open Bridge 控制台</h1>
        {settings?.version ? (
          <span className="mono" style={{ fontSize: 12, opacity: 0.6 }} title="构建版本（package.json）">
            v{settings.version}
          </span>
        ) : null}
        <span className={`badge ${settings?.running ? "on" : "off"}`}>
          {settings ? settings.statusText : "连接中…"}
        </span>
      </div>

      <nav className="tabs">
        {ROUTES.map(item => (
          <a
            key={item.id}
            className={`tab ${route === item.id ? "active" : ""}`}
            href={routePath(item.id)}
            title={item.hint}
            onClick={event => {
              // Real links: ctrl/cmd-click and "open in new tab" keep working,
              // because only plain left-clicks are turned into pushState.
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              open(item.id);
            }}
          >
            {item.label}
          </a>
        ))}
      </nav>

      <div className="quick">
        <span className="crumb mono" title="当前页面路径">{routePath(route)}</span>
        <button
          className="small"
          disabled={!settings?.mcpUrl}
          onClick={() => { void copyText(settings?.mcpUrl ?? ""); showToast("MCP 地址已复制。"); }}
        >
          复制 MCP 地址
        </button>
        <button className="small" onClick={() => open("health")}>一键体检</button>
        <button
          className="small"
          onClick={() => { setReloadKey(key => key + 1); void refreshSettings(); showToast("已刷新。"); }}
        >
          刷新本页
        </button>
      </div>

      <div className="page" key={`${route}-${reloadKey}`}>
        {route === "status" && <StatusTab settings={settings} act={act} onRefresh={refreshSettings} />}
        {route === "sessions" && <SessionsPage />}
        {route === "tools" && <ToolsPage />}
        {route === "health" && <HealthPage act={act} />}
        {route === "services" && <ServicesTab />}
        {route === "logs" && <LogsTab />}
        {route === "stats" && <StatsTab />}
        {route === "tokens" && (
          <SettingsStateGuard settings={settings}><TokensTab settings={settings!} act={act} /></SettingsStateGuard>
        )}
        {route === "settings" && <SettingsTab settings={settings} act={act} notify={showToast} />}
      </div>

      {/* Persistent node on purpose: toggling .show on the same element is
          what lets the fade in/out transitions actually run. */}
      <div
        className={`toast ${toast ? "show" : ""} ${toast?.isError ? "error" : ""}`}
        role={toast?.isError ? "alert" : "status"}
      >
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
