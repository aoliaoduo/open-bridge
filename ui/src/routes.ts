/**
 * Console routes.
 *
 * The panel used to be one page whose "tabs" were component state: the address
 * bar never moved, no page could be linked, bookmarked or opened in a second
 * window, and a reload always dropped the operator back on 状态. Every page now
 * has a real path under /console/ — the server already answers any /console/*
 * with the SPA shell (see api-router.ts), so this file is the only place that
 * decides what a path means.
 *
 * The page list is also the navigation model: each page belongs to one group,
 * and the sidebar renders the groups in this order (groups came with the
 * redesign — nine flat tabs were the most the old top strip could hold, and a
 * flat list of nine said nothing about how the pages relate).
 */
import { t } from "./i18n";

export type RouteId =
  | "status"
  | "sessions"
  | "todos"
  | "tools"
  | "health"
  | "services"
  | "logs"
  | "stats"
  | "security"
  | "settings";

export type RouteGroupId = "instance" | "ops" | "config";

export interface RouteGroupSpec {
  id: RouteGroupId;
  /** Getter, not a string: the label has to re-read the active language on
   *  every render, and a module-level constant would freeze the first one. */
  label: () => string;
}

export interface RouteSpec {
  id: RouteId;
  /** Getter for the same reason as RouteGroupSpec.label. */
  label: () => string;
  /** Shown as the link tooltip; also the one-line answer to "what is this page for". */
  hint: () => string;
  group: RouteGroupId;
  /**
   * Icon geometry, 24x24, stroked (never filled) — kept here rather than in the
   * sidebar so a new page cannot be added without deciding its icon, the same
   * way it cannot be added without a label.
   */
  icon: string[];
}

/**
 * Group order is deliberate: 实例 is the "what is happening right now" group and
 * opens first, 运维 is what you do about it, 配置 changes how the instance
 * behaves (and is the only group whose pages write config).
 */
export const ROUTE_GROUPS: RouteGroupSpec[] = [
  { id: "instance", label: () => t("实例", "Instance") },
  { id: "ops", label: () => t("运维", "Operations") },
  { id: "config", label: () => t("配置", "Configuration") },
];

export const ROUTES: RouteSpec[] = [
  {
    id: "status",
    label: () => t("状态", "Status"),
    hint: () => t("MCP 端点、运行控制与实时状态", "MCP endpoint, run controls and live state"),
    group: "instance",
    icon: ["M12 13.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z", "M13.9 9.6 19.5 4", "M4.5 19.5a8.5 8.5 0 0115 0"],
  },
  {
    id: "sessions",
    label: () => t("会话", "Sessions"),
    hint: () => t("谁连着这个实例", "Who is connected to this instance"),
    group: "instance",
    icon: ["M8.5 11a3 3 0 100-6 3 3 0 000 6z", "M3 19.5a5.5 5.5 0 0111 0", "M16 5.6a3 3 0 010 5.8", "M17.2 14.4a5.5 5.5 0 014.3 5.1"],
  },
  {
    id: "todos",
    label: () => t("任务", "Todos"),
    hint: () => t("AI 正在做什么：任务清单与最新进展", "What the AI is doing: its task list and latest progress"),
    group: "instance",
    // A checklist: a box, a tick inside it, and two list lines beside it.
    icon: ["M3.5 5.5h5v5h-5z", "M4.8 8l1.3 1.3 2.2-2.4", "M11.5 6.5h9", "M11.5 10h6", "M3.5 15.5h5v5h-5z", "M11.5 16.5h9", "M11.5 20h6"],
  },
  {
    id: "tools",
    label: () => t("工具", "Tools"),
    hint: () => t("这台实例实际对外公布的 MCP 工具清单", "The MCP tools this instance actually advertises"),
    group: "instance",
    icon: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  },
  {
    id: "health",
    label: () => t("体检", "Health"),
    hint: () => t("逐项检查实例、隧道与公网连通性", "Check the instance, the tunnel and public reachability"),
    group: "instance",
    icon: ["M12 3.2 19 6v6.2c0 4.3-2.9 7.4-7 8.6-4.1-1.2-7-4.3-7-8.6V6z", "M9 12.2l2.2 2.2 4.3-4.4"],
  },
  {
    id: "services",
    label: () => t("服务", "Services"),
    hint: () => t("保存过的命名进程：启动、停止、重启", "Saved named processes: start, stop, restart"),
    group: "ops",
    icon: ["M3.5 4.5h17v6h-17z", "M3.5 13.5h17v6h-17z", "M7 7.5h.01", "M7 16.5h.01"],
  },
  {
    id: "logs",
    label: () => t("日志", "Logs"),
    hint: () => t("实时日志流与轮转设置", "Live log stream and rotation settings"),
    group: "ops",
    icon: ["M5 3.5h14v17H5z", "M8.5 8.5h7", "M8.5 12h7", "M8.5 15.5h4"],
  },
  {
    id: "stats",
    label: () => t("统计", "Stats"),
    hint: () => t("调用次数、耗时与工具排行", "Call counts, latency and a tool leaderboard"),
    group: "ops",
    icon: ["M5 20V10.5", "M12 20V4", "M19 20v-6.5"],
  },
  {
    id: "security",
    label: () => t("安全", "Security"),
    hint: () => t("暴露面、Bearer 门禁、令牌与 OAuth", "Exposure, bearer gate, tokens and OAuth"),
    group: "config",
    icon: ["M6.5 11h11v9.5h-11z", "M9.5 11V8a2.5 2.5 0 015 0v3", "M12 15v2"],
  },
  {
    id: "settings",
    label: () => t("设置", "Settings"),
    hint: () => t("隧道、端口、目录、Shell、通知与并发", "Tunnel, ports, directories, shell, notifications and locks"),
    group: "config",
    icon: ["M4 7h16", "M4 12h16", "M4 17h16", "M9.5 5v4", "M15.5 10v4", "M9.5 15v4"],
  },
];

export function routeSpec(id: RouteId): RouteSpec {
  // Every RouteId has a spec (the union and the array are written together), so
  // this cannot fall through; the fallback keeps the shell render total anyway.
  // The `!` restates that ROUTES is the non-empty literal array declared above.
  return ROUTES.find(route => route.id === id) ?? ROUTES[0]!;
}

export function routeGroupLabel(id: RouteId): string {
  const spec = routeSpec(id);
  return ROUTE_GROUPS.find(group => group.id === spec.group)?.label() ?? "";
}

/**
 * 设置 is one sidebar page but seven real sub-pages: each card lives at its own
 * path (`/console/settings/<section>`) so a deep link opens exactly the card
 * the operator meant — the anchor-scroll rail only ever faked this.
 */
export type SettingsSectionId = "tunnel" | "network" | "files" | "shell" | "notify" | "locks";

export interface SettingsSectionSpec {
  id: SettingsSectionId;
  label: () => string;
  /** One-line answer to "what does this sub-page configure"; drives PageHeader. */
  hint: () => string;
}

/** Card order matches the operator's mental model: connectivity first, hygiene last. */
export const SETTINGS_SECTIONS: SettingsSectionSpec[] = [
  { id: "tunnel", label: () => t("隧道", "Tunnel"), hint: () => t("隧道提供商、凭据、预留域名与公网发布", "Tunnel provider, credentials, reserved domain and public exposure") },
  { id: "network", label: () => t("端口", "Ports"), hint: () => t("本机监听端口与公网健康检查超时", "Local listen port and public health-check timeout") },
  { id: "files", label: () => t("目录", "Directories"), hint: () => t("文件访问范围与目录白名单", "File access scope and the directory allowlist") },
  { id: "shell", label: () => t("Shell", "Shell"), hint: () => t("命令执行使用的 shell", "The shell commands run through") },
  { id: "notify", label: () => t("通知", "Notifications"), hint: () => t("手机通知（Bark）：模式、设备密钥与测试发送", "Phone push (Bark): mode, device key and a test send") },
  { id: "locks", label: () => t("并发", "Locks"), hint: () => t("并发锁与占用/等待上限", "Concurrency locks and hold/wait ceilings") },
];

export const SETTINGS_DEFAULT_SECTION: SettingsSectionId = "tunnel";

export function settingsSectionSpec(id: SettingsSectionId): SettingsSectionSpec {
  // Same totality argument as routeSpec: the union and the array are written
  // together; the fallback keeps the header render total anyway.
  return SETTINGS_SECTIONS.find(section => section.id === id) ?? SETTINGS_SECTIONS[0]!;
}

export function settingsSectionPath(id: SettingsSectionId): string {
  return `${routePath("settings")}/${id}`;
}

/**
 * The sub-section of a /console/settings/... path, defaulting for the bare
 * /console/settings (the sidebar's link) and for anything foreign — an
 * unknown tail means the URL was mistyped, and the first card is the safe answer.
 */
export function currentSettingsSection(pathname?: string): SettingsSectionId {
  const trimmed = (pathname ?? window.location?.pathname ?? "").replace(/\/+$/, "");
  const prefix = `${routePath("settings")}/`;
  if (!trimmed.startsWith(prefix)) return SETTINGS_DEFAULT_SECTION;
  const tail = trimmed.slice(prefix.length);
  return SETTINGS_SECTIONS.some(section => section.id === tail)
    ? (tail as SettingsSectionId)
    : SETTINGS_DEFAULT_SECTION;
}

/** pushState for a settings sub-page; mirrors navigate()'s SPA-only rule. */
export function navigateToSettings(section: SettingsSectionId): void {
  const target = settingsSectionPath(section);
  if (window.location.pathname === target) return;
  window.history.pushState({ route: "settings", section }, "", target);
}

export const CONSOLE_BASE = "/console";

export function routePath(id: RouteId): string {
  return `${CONSOLE_BASE}/${id}`;
}

/**
 * Path -> page. Anything unrecognised (including bare /console and the old
 * single-page URL) is 状态, so every existing bookmark keeps working.
 */
export function currentRoute(pathname?: string): RouteId {
  // Tolerant on purpose: a test (or a browser with a stubbed location) may hand
  // us an object without pathname, and landing on 状态 is always a safe answer.
  const trimmed = (pathname ?? window.location?.pathname ?? "").replace(/\/+$/, "");
  if (trimmed !== CONSOLE_BASE && !trimmed.startsWith(`${CONSOLE_BASE}/`)) return "status";
  const tail = trimmed.slice(CONSOLE_BASE.length).replace(/^\/+/, "");
  // The 令牌 page moved to 安全: old bookmarks land on the new page
  // instead of falling through to 状态.
  if (tail === "tokens") return "security";
  // Settings sub-pages (/console/settings/notify, …) are all one sidebar page:
  // the section itself is currentSettingsSection's business, not the route's.
  if (tail === "settings" || tail.startsWith("settings/")) return "settings";
  return ROUTES.some(route => route.id === tail) ? (tail as RouteId) : "status";
}

/**
 * pushState only: the SPA is already loaded, so a real navigation would just
 * make the browser re-fetch the shell it is sitting on.
 */
export function navigate(id: RouteId): void {
  const target = routePath(id);
  if (window.location.pathname === target) return;
  window.history.pushState({ route: id }, "", target);
}
