import { useCallback, useEffect, useRef, useState } from "react";
import { api, copyText, reloadConsole, type SecretPayload, type SettingsActionResult, type SettingsState } from "./api";
import { currentRoute, currentSettingsSection, navigate, navigateToSettings, routeSpec, settingsSectionSpec, type RouteId, type SettingsSectionId } from "./routes";
import { applyTheme, initTheme, nextThemePref, storeThemePref, watchSystemTheme, type ThemePref } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { PageHeader } from "./components/PageHeader";
import { Skeleton } from "./components/Skeleton";
import { StatusTab } from "./components/StatusTab";
import { SettingsTab } from "./components/SettingsTab";
import { SecurityPage } from "./components/SecurityPage";
import { LogsTab } from "./components/LogsTab";
import { StatsTab } from "./components/StatsTab";
import { ServicesTab } from "./components/ServicesTab";
import { SessionsPage } from "./components/SessionsPage";
import { TodosPage } from "./components/TodosPage";
import { ToolsPage } from "./components/ToolsPage";
import { HealthPage } from "./components/HealthPage";

interface ToastMsg { text: string; isError: boolean }

/** Sidebar collapse is a per-browser preference, not server state. */
const NAV_KEY = "openBridge.console.nav.collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage?.getItem(NAV_KEY) === "1";
  } catch {
    return false;
  }
}

function storeCollapsed(value: boolean): void {
  try {
    window.localStorage?.setItem(NAV_KEY, value ? "1" : "0");
  } catch {
    // A browser that refuses storage still gets the collapsed state for this
    // session; only remembering it fails.
  }
}

/**
 * The shell: navigation, header, toast and the one-time-secret dialog.
 *
 * The URL is the source of truth for which page is open (see routes.ts): each
 * page survives a reload, can be bookmarked, and can be opened in a second
 * window — none of which was possible while the tabs were component state.
 */
export function App() {
  const [route, setRoute] = useState<RouteId>(() => currentRoute());
  // Which settings sub-page is open. Independent state (not parsed per render)
  // so back/forward and in-page clicks drive it the same way.
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>(() => currentSettingsSection());
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const [secret, setSecret] = useState<SecretPayload | null>(null);
  // Bumped by 刷新本页 so the open page remounts and re-reads its data.
  const [reloadKey, setReloadKey] = useState(0);
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed());
  // Overlay drawer, narrow windows only; harmless (and invisible) on desktop.
  const [drawer, setDrawer] = useState(false);
  const [themePref, setThemePref] = useState<ThemePref>(() => initTheme());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const secretBox = useRef<HTMLDivElement | null>(null);

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
  // leave the address bar and the rendered page disagreeing. Settings
  // sub-pages ride the same popstate: one history entry per card switch.
  useEffect(() => {
    const onPopState = () => {
      setRoute(currentRoute());
      setSettingsSection(currentSettingsSection());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // With several consoles open (one per instance/port) the browser tab is the
  // only thing that says which page this one is.
  useEffect(() => {
    const label = routeSpec(route).label;
    document.title = `${label} · Open Bridge 控制台`;
  }, [route]);

  // 跟随系统 has to keep following: an OS switch at dusk must repaint the console
  // without a reload. An explicit 浅色/深色 ignores the OS until it is changed.
  useEffect(() => {
    if (themePref !== "system") return;
    return watchSystemTheme(() => { applyTheme("system"); });
  }, [themePref]);

  // The one-time secret is a modal, so it has to behave like one: Escape closes
  // it (there was no keyboard way out at all) and focus moves into it, otherwise
  // the plaintext sat behind a keyboard-invisible wall. The shell below is
  // also marked inert so Tab cannot escape the dialog back into the page.
  useEffect(() => {
    if (!secret) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSecret(null); };
    window.addEventListener("keydown", onKey);
    // Lock the page scroll while the dialog is up so a long secret does not
    // bring a scrollbar back and shift the layout behind the mask.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    secretBox.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [secret]);

  // The drawer is an overlay, so it needs the overlay's keyboard exit.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const open = useCallback((id: RouteId) => {
    navigate(id);
    setRoute(id);
  }, []);

  /** Switch to a settings sub-page; works from anywhere (one history entry). */
  const openSettings = useCallback((section: SettingsSectionId) => {
    navigateToSettings(section);
    setRoute("settings");
    setSettingsSection(section);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(previous => {
      storeCollapsed(!previous);
      return !previous;
    });
  }, []);

  const cycleTheme = useCallback(() => {
    setThemePref(previous => {
      const next = nextThemePref(previous);
      applyTheme(next);
      storeThemePref(next);
      return next;
    });
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

  const spec = routeSpec(route);
  // Settings sub-pages speak for themselves in the header: the section's own
  // label and hint replace the generic "设置" ones, so the header always
  // names what is actually being configured.
  const header = route === "settings"
    ? (() => {
        const sectionSpec = settingsSectionSpec(settingsSection);
        return { title: `设置 · ${sectionSpec.label}`, hint: sectionSpec.hint };
      })()
    : { title: spec.label, hint: spec.hint };

  return (
    // The shell root carries the layout class but stays interactive; inert is
    // applied to the page subtree so the dialog (rendered as a sibling) keeps
    // focus and the rest of the UI falls out of the tab order. The toast also
    // stays live so the operator can still see the "密钥已复制" feedback.
    <div className={`shell${collapsed ? " nav-collapsed" : ""}`}>
      <div className="shell-page" inert={secret ? true : undefined}>
        <Sidebar
          route={route}
          collapsed={collapsed}
          drawerOpen={drawer}
          themePref={themePref}
          onToggleCollapsed={toggleCollapsed}
          onOpen={open}
          onCloseDrawer={() => setDrawer(false)}
          onCycleTheme={cycleTheme}
        />
        {drawer ? <div className="scrim" onClick={() => setDrawer(false)} /> : null}

        <div className="main">
          <Topbar
            route={route}
            settings={settings}
            themePref={themePref}
            onCycleTheme={cycleTheme}
            onOpen={open}
            onCopyMcp={() => { void copyText(settings?.mcpUrl ?? ""); showToast("MCP 地址已复制。"); }}
            onRefresh={() => { setReloadKey(key => key + 1); void refreshSettings(); showToast("已刷新。"); }}
            onToggleDrawer={() => setDrawer(value => !value)}
          />

          <main className="content">
            <PageHeader title={header.title} hint={header.hint} />
            <div className="page" key={`${route}-${reloadKey}`}>
              {route === "status" && <StatusTab act={act} onRefresh={refreshSettings} notify={showToast} onOpen={open} />}
              {route === "sessions" && <SessionsPage notify={showToast} />}
              {route === "todos" && <TodosPage />}
              {route === "tools" && <ToolsPage notify={showToast} />}
              {route === "health" && <HealthPage onOpen={open} />}
              {route === "services" && <ServicesTab notify={showToast} />}
              {route === "logs" && <LogsTab />}
              {route === "stats" && <StatsTab />}
              {route === "security" && (settings ? (
                <SecurityPage settings={settings} act={act} notify={showToast} />
              ) : (
                <Skeleton lines={4} />
              ))}
              {route === "settings" && (
                <SettingsTab
                  settings={settings}
                  act={act}
                  notify={showToast}
                  section={settingsSection}
                  onSectionChange={openSettings}
                />
              )}
            </div>
          </main>
        </div>
      </div>

      {/* Persistent node on purpose: toggling .show on the same element is
          what lets the fade in/out transitions actually run. Kept outside the
          inert subtree so the "密钥已复制" feedback still appears while the
          dialog is open. role/aria-live only attach when there is something
          to announce, otherwise the empty live region is a no-op for AT. */}
      <div
        className={`toast ${toast ? "show" : ""} ${toast?.isError ? "error" : ""}`}
        role={toast ? (toast.isError ? "alert" : "status") : undefined}
        aria-live="polite"
      >
        {toast?.text}
      </div>

      {secret && (
        <div className="mask" onClick={() => setSecret(null)}>
          <div
            className="card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="secret-title"
            tabIndex={-1}
            ref={secretBox}
            onClick={event => event.stopPropagation()}
          >
            <h2 id="secret-title">{secret.kind === "minted" ? "令牌已创建" : "令牌已轮换"}</h2>
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
