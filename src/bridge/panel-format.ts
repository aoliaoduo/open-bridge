/**
 * Pure formatting/normalization helpers for the dashboard panel.
 * No vscode or bridge-state imports, so the logic stays unit-testable.
 */

/** Short relative timestamp for activity rows: 刚刚 / 12s / 42m / 3h / 2d. */
export function relativeTimeShort(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Chinese duration for service uptime: 42 秒 / 42 分钟 / 3 小时 / 2 天. */
export function durationCn(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

export type PanelTodoStatus = "completed" | "in_progress" | "pending";

export interface PanelTodo {
  id: string;
  title: string;
  status: PanelTodoStatus;
}

/** Normalize raw session todos into the panel checklist shape, dropping malformed entries. */
export function normalizeTodos(value: unknown): PanelTodo[] {
  if (!Array.isArray(value)) return [];
  const out: PanelTodo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const id = String(raw.id ?? "").trim();
    const title = String(raw.title ?? "").trim();
    const status = raw.status;
    if (!id || !title) continue;
    if (status !== "completed" && status !== "in_progress" && status !== "pending") continue;
    out.push({ id, title, status });
  }
  return out;
}

/** One rendered group of the todo checklist. `summary` is set for the completed group. */
export interface TodoGroupState {
  status: PanelTodoStatus;
  label: string;
  /** Collapsed-header summary (e.g. "已完成 2 项"); only the completed group sets it. */
  summary: string;
  items: PanelTodo[];
}

/** Render order for grouped todo rows: active work first, done last. */
export const TODO_GROUP_ORDER: readonly PanelTodoStatus[] = ["in_progress", "pending", "completed"];

/** Chinese group label used by both the static render and the live patch. */
export function todoGroupLabel(status: PanelTodoStatus): string {
  return status === "in_progress" ? "进行中" : status === "pending" ? "待办" : "已完成";
}

/** Collapsed summary text for the completed group. */
export function todoDoneSummary(count: number): string {
  return `已完成 ${count} 项`;
}

/**
 * Group todos by status in render order (in_progress, pending, completed);
 * empty groups are omitted. Pure, so both the static render and the live
 * postMessage patch consume the same structure.
 */
export function groupTodos(todos: readonly PanelTodo[]): TodoGroupState[] {
  const byStatus = new Map<PanelTodoStatus, PanelTodo[]>();
  for (const todo of todos) {
    const list = byStatus.get(todo.status) ?? [];
    list.push(todo);
    byStatus.set(todo.status, list);
  }
  return TODO_GROUP_ORDER
    .filter(status => byStatus.has(status))
    .map(status => {
      const items = byStatus.get(status)!;
      return {
        status,
        label: todoGroupLabel(status),
        summary: status === "completed" ? todoDoneSummary(items.length) : "",
        items,
      };
    });
}

/** Compose the service card sub-line: `group · :port · 42 分钟|已停止|未启动`. */
export function serviceSubLine(
  group: string,
  port: number | undefined,
  status: "running" | "stopped" | "idle",
  uptimeText: string,
): string {
  const parts = [group || "default"];
  if (port) parts.push(`:${port}`);
  parts.push(status === "running" ? uptimeText : status === "stopped" ? "已停止" : "未启动");
  return parts.join(" · ");
}

/**
 * Activity sources that are Bridge-internal lifecycle noise (Bridge start/stop,
 * ngrok tunnel events, health probes, process spawn/exit bookkeeping). The
 * panel activity section is about what the AI client is doing, so these are
 * filtered out; the OutputChannel keeps the full unfiltered log.
 */
export const INTERNAL_ACTIVITY_TOOLS: ReadonlySet<string> = new Set(["bridge", "ngrok", "health", "process"]);

/** True for activity entries that belong in the panel (tool-call records). */
export function isPanelActivity(tool: string): boolean {
  return !INTERNAL_ACTIVITY_TOOLS.has(tool);
}

/** Split `items` into the first `max` entries and the number of remaining ones. */
export function takeWithOverflow<T>(items: readonly T[], max: number): { shown: T[]; overflow: number } {
  const shown = items.slice(0, Math.max(max, 0));
  return { shown, overflow: items.length - shown.length };
}

/** Aggregate-row text for processes hidden behind the visible process rows. */
export function overflowProcessesText(overflow: number): string {
  return `另 ${overflow} 个进程运行中`;
}

/**
 * Aggregate diff badge for a patch change list: "+2/−1" (totals across files).
 * Empty string when nothing changed so rows can omit the span entirely.
 */
export function formatDiffBadge(changes: ReadonlyArray<{ additions: number; deletions: number }>): string {
  const additions = changes.reduce((sum, c) => sum + (Number(c.additions) || 0), 0);
  const deletions = changes.reduce((sum, c) => sum + (Number(c.deletions) || 0), 0);
  if (!additions && !deletions) return "";
  return `+${additions}/−${deletions}`;
}

/** Top-N tools by call count (ties broken alphabetically), for the usage stats section. */
export function topToolsByCount(byTool: Record<string, number>, max = 3): Array<{ name: string; count: number }> {
  return Object.entries(byTool)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, Math.max(max, 0));
}
