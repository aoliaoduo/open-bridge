import { routeGroupLabel, routePath, routeSpec, type RouteId } from "../routes";
import { themePrefLabel, type ThemePref } from "../theme";
import type { SettingsState } from "../api";
import { Chip } from "./Chip";

interface Props {
  route: RouteId;
  settings: SettingsState | null;
  themePref: ThemePref;
  onCycleTheme: () => void;
  onOpen: (id: RouteId) => void;
  onCopyMcp: () => void;
  onRefresh: () => void;
  onToggleDrawer: () => void;
}

/**
 * Header: breadcrumb, run state, and the three actions that apply to whatever
 * page is open.
 *
 * What moved here: the running chip and version (so the answer to "is it up,
 * and which build is this page from" is visible from every page), the theme
 * switch, and the console path — which used to sit in a row of buttons below
 * the tabs, where it read as an action rather than as an address.
 *
 * What left: the flat tab strip (now the sidebar) and the page title (now the
 * page header, where it can be a heading instead of a tab).
 */
export function Topbar({ route, settings, themePref, onCycleTheme, onOpen, onCopyMcp, onRefresh, onToggleDrawer }: Props) {
  const spec = routeSpec(route);
  const running = Boolean(settings?.running);

  return (
    <header className="topbar">
      <button type="button" className="icon-btn menu-btn" aria-label="打开导航" title="打开导航" onClick={onToggleDrawer}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      <nav className="crumbs" aria-label="面包屑">
        <span className="crumb">控制台</span>
        <span className="crumb-sep" aria-hidden="true">/</span>
        <span className="crumb">{routeGroupLabel(route)}</span>
        <span className="crumb-sep" aria-hidden="true">/</span>
        <span className="crumb current">{spec.label}</span>
        <span className="crumb-path mono" title="当前页面路径">{routePath(route)}</span>
      </nav>

      <div className="topbar-actions">
        <Chip tone={running ? "ok" : "idle"}>{settings ? settings.statusText : "连接中…"}</Chip>
        {settings?.version ? (
          <span className="mono version" title="构建版本（package.json）">v{settings.version}</span>
        ) : null}
        <button type="button" className="ghost small" onClick={onCycleTheme} title="在 跟随系统 / 浅色 / 深色 之间切换">
          主题：{themePrefLabel(themePref)}
        </button>
        <button type="button" className="small" disabled={!settings?.mcpUrl} onClick={onCopyMcp}>
          复制 MCP 地址
        </button>
        <button type="button" className="small" onClick={() => onOpen("health")}>
          一键体检
        </button>
        <button type="button" className="small" onClick={onRefresh}>
          刷新本页
        </button>
      </div>
    </header>
  );
}
