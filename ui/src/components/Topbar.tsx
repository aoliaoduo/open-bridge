import { routeGroupLabel, routePath, routeSpec, type RouteId } from "../routes";
import { t } from "../i18n";
import type { SettingsState } from "../api";
import { Chip } from "./Chip";

interface Props {
  route: RouteId;
  settings: SettingsState | null;
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
  route, settings, onToggleDrawer,
}: Props) {
  const spec = routeSpec(route);
  const running = Boolean(settings?.running);

  return (
    <header className="topbar">
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
          {settings ? settings.statusText : t("连接中…", "Connecting…")}
        </Chip>
        {settings?.version ? (
          <span className="mono version" title={t("构建版本（package.json）", "Build version (package.json)")}>
            v{settings.version}
          </span>
        ) : null}
      </div>
    </header>
  );
}
