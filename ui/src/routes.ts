/**
 * Console routes.
 *
 * The panel used to be one page whose "tabs" were component state: the address
 * bar never moved, no page could be linked, bookmarked or opened in a second
 * window, and a reload always dropped the operator back on 状态. Every page now
 * has a real path under /console/ — the server already answers any /console/*
 * with the SPA shell (see api-router.ts), so this file is the only place that
 * decides what a path means.
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

export interface RouteSpec {
  id: RouteId;
  label: string;
  /** Shown as the link tooltip; also the one-line answer to "what is this page for". */
  hint: string;
}

export const ROUTES: RouteSpec[] = [
  { id: "status", label: "状态", hint: "MCP 端点、运行控制与实时状态" },
  { id: "sessions", label: "会话", hint: "谁连着这个实例，以及正在被占用的文件锁" },
  { id: "tools", label: "工具", hint: "这台实例实际对外公布的 MCP 工具清单" },
  { id: "health", label: "体检", hint: "逐项检查实例、隧道与公网连通性" },
  { id: "services", label: "服务", hint: "保存过的命名进程：启动、停止、重启" },
  { id: "logs", label: "日志", hint: "实时日志流" },
  { id: "stats", label: "统计", hint: "调用次数、耗时与工具排行" },
  { id: "tokens", label: "令牌", hint: "鉴权令牌的创建、轮换与吊销" },
  { id: "settings", label: "设置", hint: "隧道、端口、工作区与并发等运行参数" },
];

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
