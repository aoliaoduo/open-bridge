/** Workbench sidebar rendering for operator state and local resources. */
import { healthColor, paint, type ColorName } from "./theme.js";
import { inlineText, padEndVisual, truncateVisual, visualWidth, wrapVisual } from "./text.js";
import { exposureTag, formatCount, formatDuration, tunnelTag } from "./render-format.js";
import type { TuiSnapshot } from "./render-model.js";

function sidebarField(lines: string[], width: number, label: string, value: string, color: ColorName = "text"): void {
  const labelPart = paint("muted", padEndVisual(label, 8));
  lines.push(`${labelPart} ${paint(color, truncateVisual(value, Math.max(4, width - 10)))}`);
}

export function renderSidebar(
  snap: TuiSnapshot,
  width: number,
  maxRows?: number,
  actionNotice?: { text: string; tone: "success" | "error" },
): string[] {
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push(paint("dim", padEndVisual(`─ ${title} `, width)));
  };

  section("概览");
  // No 状态 or 工作区 fields: the top-bar capsule and title already own those facts.
  const tag = tunnelTag(snap);
  sidebarField(lines, width, "隧道", tag.text, tag.color);
  const exposure = exposureTag(snap);
  sidebarField(lines, width, "访问", exposure.text, exposure.color);
  sidebarField(lines, width, "运行", formatDuration(snap.uptimeMs));
  sidebarField(lines, width, "调用", `${formatCount(snap.calls)} · ✓ ${formatCount(snap.successes)} ✕ ${formatCount(snap.failures)}`, snap.failures > 0 ? "review" : "text");
  // No /64 cap: the session ceiling is developer knowledge; the operator
  // only needs to know how many clients are connected right now.
  sidebarField(lines, width, "会话", `${snap.sessions}${snap.sessionsActive > 0 ? ` · 活跃 ${snap.sessionsActive}` : ""}${snap.modernSeen ? (snap.modernInFlight > 0 ? ` · 无状态 ${snap.modernInFlight} 活跃` : " · 无状态") : ""}`, snap.modernInFlight > 0 ? "accent" : "text");
  sidebarField(lines, width, "进程", `${snap.runningCommands.length}`);
  if (snap.serviceRows.length > 0) {
    sidebarField(lines, width, "服务", `${snap.serviceRows.filter(s => s.running).length}/${snap.serviceRows.length}`);
  }
  // A permanent resident: the row answers "is there uncommitted work?" and a
  // missing row cannot say whether that means clean or not-watching. Clean
  // reads as 干净; a workspace without git is named honestly, not faked;
  // a timeout or a failed read of a real repo is 读取失败, never 非 git.
  if (snap.changes.status === "loading") {
    sidebarField(lines, width, "变更", "读取中…", "dim");
  } else if (snap.changes.status === "not-git") {
    sidebarField(lines, width, "变更", "非 git", "dim");
  } else if (snap.changes.status === "unavailable") {
    sidebarField(lines, width, "变更", "读取失败", "dim");
  } else if (snap.changes.files === 0 && snap.changes.insertions === 0 && snap.changes.deletions === 0) {
    sidebarField(lines, width, "变更", "干净", "dim");
  } else {
    // The diff convention every tool shares: additions green, deletions red.
    // The numbers outrank the tail — on a narrow sidebar the file count is
    // the first thing to go, never the signs.
    const add = `+${formatCount(snap.changes.insertions)}`;
    const del = `-${formatCount(snap.changes.deletions)}`;
    const tail = ` · ${snap.changes.files} 文件`;
    const budget = Math.max(4, width - 10);
    const tailFits = visualWidth(add) + 1 + visualWidth(del) + visualWidth(tail) <= budget;
    lines.push(
      `${paint("muted", padEndVisual("变更", 8))} ${paint("success", add)} ${paint("error", del)}${tailFits ? paint("text", tail) : ""}`,
    );
  }

  if (snap.todosTotal > 0) {
    // Progress summary: completed / total with percentage
    const completed = snap.todos.filter(todo => todo.status === "completed").length;
    const inProgress = snap.todos.filter(todo => todo.status === "in_progress").length;
    const pct = Math.round((completed / snap.todosTotal) * 100);
    const color: ColorName = completed === snap.todosTotal ? "success" : inProgress > 0 ? "accent" : "text";
    sidebarField(lines, width, "任务", `${completed}/${snap.todosTotal}（${pct}%）`, color);
  }

  if (snap.runningCommands.length > 0) {
    // No empty placeholder section: the 概览 counter already says 进程 0.
    const shown = Math.min(6, snap.runningCommands.length);
    const hidden = snap.runningCommands.length - shown;
    section(hidden > 0 ? `进程 · +${hidden}` : "进程");
    for (const command of snap.runningCommands.slice(0, shown)) {
      const pct = command.capacityBytes > 0 ? Math.min(100, (command.capturedBytes / command.capacityBytes) * 100) : 0;
      const right = `${Math.round(pct)}%`;
      const left = truncateVisual(`▸ ${inlineText(command.id).slice(0, 8)} ${inlineText(command.command)}`, Math.max(6, width - visualWidth(right) - 1));
      lines.push(`${paint("text", left)} ${paint(healthColor(pct), right)}`);
    }
  }

  if (snap.serviceRows.length > 0) {
    const shown = Math.min(8, snap.serviceRows.length);
    const hidden = snap.serviceRows.length - shown;
    section(hidden > 0 ? `服务 · +${hidden}` : "服务");
    for (const service of snap.serviceRows.slice(0, shown)) {
      const mark = service.running ? paint("success", "●") : paint("dim", "○");
      lines.push(`${mark} ${paint(service.running ? "text" : "dim", truncateVisual(inlineText(service.name), Math.max(4, width - 3)))}`);
    }
  }

  const addrLines = wrapVisual(`控制台 http://127.0.0.1:${snap.port}/console`, width)
    .map(line => paint("muted", line));
  const utilityLines = [
    ...(actionNotice ? [paint(actionNotice.tone, truncateVisual(actionNotice.text, width))] : []),
    paint("muted", truncateVisual("快捷 u URL · p 接入提示词", width)),
    ...addrLines,
  ];

  if (maxRows !== undefined) {
    if (lines.length + utilityLines.length <= maxRows) {
      const padCount = maxRows - lines.length - utilityLines.length;
      return [...lines, ...Array.from({ length: padCount }, () => ""), ...utilityLines];
    }
    const allowedTop = Math.max(0, maxRows - utilityLines.length);
    return [...lines.slice(0, allowedTop), ...utilityLines];
  }

  return [...lines, ...utilityLines];
}
