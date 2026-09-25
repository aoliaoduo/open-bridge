import { useEffect, useState } from "react";
import { routeGroupLabel, routePath, routeSpec, type RouteId } from "../routes";
import { t } from "../i18n";
import { themePrefLabel, type ThemePref } from "../theme";
import type { SettingsState } from "../api";
import { Chip } from "./Chip";

/** The header badge, rendered in the page's language from the structured
 *  status the server sends (the server does not know the browser's language). */
function statusLine(status: SettingsState["status"]): string {
  switch (status.kind) {
    case "connected": return t(`已连接 · ${status.sessions ?? 0} 个会话`, `Connected · ${status.sessions ?? 0} session(s)`);
    case "ready": return t("已就绪", "Ready");
    case "offline": return t("离线", "Offline");
    case "stopped": return t("已停止", "Stopped");
    case "error": return t("错误", "Error");
  }
}

/**
 * Sun, moon, or half-and-half for "follow the system".
 *
 * Three distinct silhouettes rather than one icon with a badge: the point of
 * moving this into the bar was to read the current mode without reading a
 * word, and a shared outline with a small marker would not survive a glance.
 */
function ThemeIcon({ pref }: { pref: ThemePref }) {
  if (pref === "light") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 3.4v2M12 18.6v2M3.4 12h2M18.6 12h2M6.1 6.1l1.4 1.4M16.5 16.5l1.4 1.4M17.9 6.1l-1.4 1.4M7.5 16.5l-1.4 1.4"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (pref === "dark") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M20 13.4A8.2 8.2 0 0 1 10.6 4a8.2 8.2 0 1 0 9.4 9.4Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  // system: a circle split down the middle, filled on one side.
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
    </svg>
  );
}

/**
 * Must stay in step with the 900px breakpoint in console.css that turns the
 * sidebar into a drawer. Two numbers that have to agree is a real risk, so
 * console-css.test.ts asserts they match rather than trusting a comment.
 */
const DRAWER_MAX_WIDTH = 900;

function useNarrowViewport(): boolean {
  const query = `(max-width: ${DRAWER_MAX_WIDTH}px)`;
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = (): void => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

interface Props {
  route: RouteId;
  settings: SettingsState | null;
  themePref: ThemePref;
  onCycleTheme: () => void;
  onToggleDrawer: () => void;
}

/**
 * Header: breadcrumb, run state, and the three actions that apply to whatever
 * page is open.
 *
 * What moved here: the running chip and version (so the answer to "is it up,
 * and which build is this page from" is visible from every page) and the
 * console path — which used to sit in a row of buttons below the tabs, where
 * it read as an address rendered as an action.
 *
 * What left: the flat tab strip (now the sidebar) and the page title (now the
 * page header, where it can be a heading instead of a tab).
 *
 * What was removed rather than moved: 复制 MCP 地址, 一键体检, 刷新本页 and a
 * second theme toggle. Each already had a home — the endpoint card copies the
 * URL, 体检 runs its own checks and is one nav click away, the browser's own
 * reload is more reliable than a button that only re-fetches, and the sidebar
 * foot owns the theme. A global action row that duplicates page controls
 * makes every page look like it has four things to do.
 */
export function Topbar({
  route, settings, themePref, onCycleTheme, onToggleDrawer,
}: Props) {
  const narrow = useNarrowViewport();
  const spec = routeSpec(route);
  const running = Boolean(settings?.running);

  return (
    <header className="topbar">
      {/* Rendered only where the drawer exists. Hiding it with CSS was not
          enough twice over: once because `.menu-btn` lost the cascade to
          `button.icon-btn` and it stayed visible at every width, and then
          because even a correctly hidden button is still in the DOM, still
          focusable by keyboard, and still toggling state that no stylesheet
          responds to above 900px. A control that cannot do anything should
          not exist, not merely be invisible. */}
      {narrow ? (
        <button
          type="button"
          className="icon-btn menu-btn"
          aria-label={t("打开导航", "Open navigation")}
          title={t("打开导航", "Open navigation")}
          onClick={onToggleDrawer}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      ) : null}

      <nav className="crumbs" aria-label={t("面包屑", "Breadcrumb")}>
        <span className="crumb">{t("控制台", "Console")}</span>
        <span className="crumb-sep" aria-hidden="true">/</span>
        <span className="crumb">{routeGroupLabel(route)}</span>
        <span className="crumb-sep" aria-hidden="true">/</span>
        <span className="crumb current">{spec.label()}</span>
        <span className="crumb-path mono" title={t("当前页面路径", "Current page path")}>{routePath(route)}</span>
      </nav>

      <div className="topbar-actions">
        <Chip tone={running ? "ok" : "idle"}>
          {settings ? statusLine(settings.status) : t("连接中…", "Connecting…")}
        </Chip>
        {settings?.version ? (
          <span className="mono version" title={t("构建版本（package.json）", "Build version (package.json)")}>
            v{settings.version}
          </span>
        ) : null}
        {/* An icon, not the old "主题：跟随系统" line. The label spelled out a
            state that the icon shows at a glance, and it was the widest thing
            in a bar that otherwise holds two short readouts. The current mode
            stays reachable in words through the tooltip and the accessible
            name, so nothing is lost for anyone who needs it spoken. */}
        <button
          type="button"
          className="icon-btn theme-btn"
          onClick={onCycleTheme}
          title={`${t("主题：", "Theme: ")}${themePrefLabel(themePref)}${t("（点击切换）", " — click to cycle")}`}
          aria-label={`${t("主题：", "Theme: ")}${themePrefLabel(themePref)}`}
        >
          <ThemeIcon pref={themePref} />
        </button>
      </div>
    </header>
  );
}
