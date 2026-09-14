import { ROUTES, ROUTE_GROUPS, routePath, type RouteId } from "../routes";
import { t } from "../i18n";
import { themePrefLabel, type ThemePref } from "../theme";

interface Props {
  route: RouteId;
  /** Narrow rail (icons only) — the desktop collapse state. */
  collapsed: boolean;
  /** Overlay drawer on narrow windows; always false on desktop. */
  drawerOpen: boolean;
  /** Current theme preference; the foot button surfaces it on every screen. */
  themePref: ThemePref;
  onToggleCollapsed: () => void;
  onOpen: (id: RouteId) => void;
  onCloseDrawer: () => void;
  onCycleTheme: () => void;
}

/**
 * 左侧导航 (instance / ops / config), collapsible, drawer under 900px.
 *
 * Nine flat tabs across the top were the previous navigation. They survived the
 * move to real paths but they could not survive a tenth page, and a flat strip
 * says nothing about the shape of the console: 状态/会话/工具/体检 answer "what is
 * happening", 服务/日志/统计 are what you do about it, and 安全/设置 are the
 * config pages that write config. The grouped sidebar is the reference layout for
 * exactly this reason (and it frees the top bar for breadcrumbs and actions).
 *
 * Collapsing keeps the labels in the DOM and hides them visually (`sr-only`-like
 * clipping in CSS) instead of unmounting them: display:none would also remove
 * them from each link's accessible name, so a collapsed rail would be announced
 * as a list of unlabelled links.
 */
export function Sidebar({ route, collapsed, drawerOpen, themePref, onToggleCollapsed, onOpen, onCloseDrawer, onCycleTheme }: Props) {
  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}${drawerOpen ? " drawer-open" : ""}`}>
      <div className="brand">
        <svg className="logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M2 17h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M4 17v-3a8 8 0 0 1 16 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M8 17v-2.5M12 17v-4.5M16 17v-2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="brand-text">
          <span className="brand-name">Open Bridge</span>
          <span className="brand-sub">{t("控制台", "Console")}</span>
        </span>
        <button
          type="button"
          className="icon-btn collapse-btn"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("展开导航", "Expand navigation") : t("收起导航", "Collapse navigation")}
          title={collapsed ? t("展开导航", "Expand navigation") : t("收起导航", "Collapse navigation")}
          onClick={onToggleCollapsed}
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d={collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"}
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <nav className="nav" aria-label={t("控制台导航", "Console navigation")}>
        {ROUTE_GROUPS.map(group => (
          <div className="nav-group" key={group.id}>
            <div className="nav-group-label">{group.label()}</div>
            {ROUTES.filter(item => item.group === group.id).map(item => (
              <a
                key={item.id}
                className={`nav-item${route === item.id ? " active" : ""}`}
                href={routePath(item.id)}
                title={item.hint()}
                aria-current={route === item.id ? "page" : undefined}
                onClick={event => {
                  // Real links: ctrl/cmd-click and "open in new tab" keep working,
                  // because only plain left-clicks are turned into pushState.
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  onOpen(item.id);
                  onCloseDrawer();
                }}
              >
                <svg className="nav-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  {item.icon.map((path, index) => (
                    <path key={index} d={path} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  ))}
                </svg>
                <span className="nav-label">{item.label()}</span>
              </a>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        {/* The topbar hides its theme toggle on narrow screens to keep the
            action row from wrapping; the sidebar foot gives the same control
            a permanent home so 跟随系统 / 浅色 / 深色 is reachable on mobile. */}
        <button
          type="button"
          className="ghost theme-foot"
          onClick={onCycleTheme}
          title={t("在 跟随系统 / 浅色 / 深色 之间切换", "Switch between System / Light / Dark")}
        >
          {t("主题：", "Theme: ")}{themePrefLabel(themePref)}
        </button>
        <span className="sidebar-foot-note">{t("独立版 · 本地面板", "Standalone · local panel")}</span>
      </div>
    </aside>
  );
}
