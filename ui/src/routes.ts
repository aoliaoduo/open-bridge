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
export type RouteId =
  | "status"
  | "sessions"
  | "tools"
  | "health"
  | "services"
  | "logs"
  | "stats"
  | "tokens"
  | "settings";

export type RouteGroupId = "instance" | "ops" | "config";

export interface RouteGroupSpec {
  id: RouteGroupId;
  label: string;
}

export interface RouteSpec {
  id: RouteId;
  label: string;
  /** Shown as the link tooltip; also the one-line answer to "what is this page for". */
  hint: string;
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
  { id: "instance", label: "实例" },
  { id: "ops", label: "运维" },
  { id: "config", label: "配置" },
];

export const ROUTES: RouteSpec[] = [
  {
    id: "status",
    label: "状态",
    hint: "MCP 端点、运行控制与实时状态",
    group: "instance",
    icon: ["M12 13.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z", "M13.9 9.6 19.5 4", "M4.5 19.5a8.5 8.5 0 0115 0"],
  },
  {
    id: "sessions",
    label: "会话",
    hint: "谁连着这个实例，以及正在被占用的文件锁",
    group: "instance",
    icon: ["M8.5 11a3 3 0 100-6 3 3 0 000 6z", "M3 19.5a5.5 5.5 0 0111 0", "M16 5.6a3 3 0 010 5.8", "M17.2 14.4a5.5 5.5 0 014.3 5.1"],
  },
  {
    id: "tools",
    label: "工具",
    hint: "这台实例实际对外公布的 MCP 工具清单",
    group: "instance",
    icon: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  },
  {
    id: "health",
    label: "体检",
    hint: "逐项检查实例、隧道与公网连通性",
    group: "instance",
    icon: ["M12 3.2 19 6v6.2c0 4.3-2.9 7.4-7 8.6-4.1-1.2-7-4.3-7-8.6V6z", "M9 12.2l2.2 2.2 4.3-4.4"],
  },
  {
    id: "services",
    label: "服务",
    hint: "保存过的命名进程：启动、停止、重启",
    group: "ops",
    icon: ["M3.5 4.5h17v6h-17z", "M3.5 13.5h17v6h-17z", "M7 7.5h.01", "M7 16.5h.01"],
  },
  {
    id: "logs",
    label: "日志",
    hint: "实时日志流",
    group: "ops",
    icon: ["M5 3.5h14v17H5z", "M8.5 8.5h7", "M8.5 12h7", "M8.5 15.5h4"],
  },
  {
    id: "stats",
    label: "统计",
    hint: "调用次数、耗时与工具排行",
    group: "ops",
    icon: ["M5 20V10.5", "M12 20V4", "M19 20v-6.5"],
  },
  {
    id: "tokens",
    label: "令牌",
    hint: "鉴权令牌的创建、轮换与吊销",
    group: "ops",
    icon: ["M6.5 11h11v9.5h-11z", "M9.5 11V8a2.5 2.5 0 015 0v3", "M12 15v2"],
  },
  {
    id: "settings",
    label: "设置",
    hint: "隧道、端口、工作区与并发等运行参数",
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
  return ROUTE_GROUPS.find(group => group.id === spec.group)?.label ?? "";
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
