/**
 * Pure composition layer for the serve-console TUI.
 *
 * Detailed formatters and panel renderers live in focused sibling modules;
 * this file keeps the stable public façade used by the driver, controller
 * and tests while owning frame/layout composition.
 */

import { paint, healthColor, spinnerFrame, type ColorName } from "./theme.js";
import { fillVisualWidth, stripAnsi, inlineText, truncateVisual, padEndVisual, padStartVisual, visualWidth } from "./text.js";
import type { TuiSnapshot } from "./render-model.js";
import { bar, formatBytes, formatClock, formatCount, formatDuration } from "./render-format.js";
import { eventDetailRows, eventListRow, maxFirstVisible, visibleEvents } from "./render-activity.js";
import { renderSidebar } from "./render-sidebar.js";
import { changePanelRows, diffPanelRows, taskPanelRows } from "./render-panels.js";

export type { TuiSnapshot, TuiEventStatus } from "./render-model.js";
export type { ScrollKey } from "./render-activity.js";
export { formatBytes, formatClock, formatCount, formatDatedClock, formatDuration, tunnelTag, exposureTag } from "./render-format.js";
export { advanceScroll, eventDetailRows, eventKeyOf, eventListRow, maxFirstVisible, visibleEvents } from "./render-activity.js";
// --- vocabulary (ported from ainovel-cli's theme.go status tables) ---

const CAPSULE: Record<TuiSnapshot["bridgeState"], { icon: string; label: string; color: ColorName }> = {
  running: { icon: "●", label: "运行中", color: "running" },
  stopping: { icon: "⏸", label: "停止中", color: "review" },
  stopped: { icon: "○", label: "未启动", color: "dim" },
};

/** Wrap rows in a rounded box with an inline title (lipgloss RoundedBorder). */
function boxLines(title: string, rows: string[], width: number): string[] {
  // Border and padding costs are MEASURED, not assumed: in a CJK-terminal
  // regime the box characters themselves render two columns each.
  const side = visualWidth("│");
  const inner = width - 2 * side - 2;
  if (inner < 10 || rows.length === 0) return [];
  const head = `─ ${title} `;
  const top = `╭${head}${fillVisualWidth("─", Math.max(1, width - 2 * side - visualWidth(head)))}╮`;
  const bottom = `╰${fillVisualWidth("─", width - 2 * side)}╯`;
  return [top, ...rows.map(row => `│ ${padEndVisual(row, inner)} │`), bottom];
}

function renderTopBar(snap: TuiSnapshot, width: number, busy: boolean, spin: number): string {
  const version = inlineText(snap.version.replace(/^v/, ""));
  const leftText = `v${version}`;
  const capsule = CAPSULE[snap.bridgeState];
  // The busy state replaces the static dot with the live spinner — the same
  // trick ainovel-cli's top bar uses so the capsule itself carries motion.
  const icon = snap.bridgeState === "running" && busy ? spinnerFrame(spin) : capsule.icon;
  const rightText = `${icon} ${capsule.label}`;

  // Top-bar layout: left is version, right is live state capsule,
  // center is the active workspace directory.
  const innerW = Math.max(12, width);
  const workspace = snap.workspaceRoot || snap.rootName;
  const maxTitleW = Math.max(8, innerW - 20);
  const titleText = truncateVisual(inlineText(workspace), maxTitleW);
  let centerW = Math.max(16, visualWidth(titleText) + 4);
  if (centerW > innerW - 20) centerW = Math.max(8, innerW - 20);
  let sideTotal = innerW - centerW;
  if (sideTotal < 0) {
    sideTotal = 0;
    centerW = innerW;
  }
  const leftW = Math.floor(sideTotal / 2);
  const rightW = sideTotal - leftW;
  const leftCell = padEndVisual(truncateVisual(leftText, leftW), leftW);
  const gap = centerW - visualWidth(titleText);
  const centerCell = padEndVisual(`${" ".repeat(Math.max(0, Math.floor(gap / 2)))}${titleText}`, centerW);
  const rightCell = padStartVisual(rightText, rightW);
  return padEndVisual(
    `${paint("dim", leftCell)}${paint("text", centerCell, { bold: true })}${paint(capsule.color, rightCell)}`,
    width,
  );
}

function renderOverviewRows(snap: TuiSnapshot, width: number): string[] {
  const inner = width - 4;

  // Row 1 — counters. Segments are dropped from the end when the window is too
  // narrow for all of them (uptime and calls outrank the rest).
  const segments: Array<{ text: string; color: ColorName }> = [
    { text: `运行 ${formatDuration(snap.uptimeMs)}`, color: "text" },
    { text: `调用 ${formatCount(snap.calls)}（✓ ${formatCount(snap.successes)} ✕ ${formatCount(snap.failures)}）`, color: snap.failures > 0 ? "review" : "text" },
    { text: `会话 ${snap.sessions}${snap.sessionsActive > 0 ? ` · 活跃 ${snap.sessionsActive}` : ""}${snap.modernSeen ? (snap.modernInFlight > 0 ? ` · 无状态 ${snap.modernInFlight} 活跃` : " · 无状态") : ""}`, color: snap.modernInFlight > 0 ? "accent" : "text" },
    { text: `进程 ${snap.runningCommands.length}`, color: "text" },
  ];
  if (snap.todosTotal > 0) {
    const completed = snap.todos.filter(todo => todo.status === "completed").length;
    const inProgress = snap.todos.filter(todo => todo.status === "in_progress").length;
    const pct = Math.round((completed / snap.todosTotal) * 100);
    const color: ColorName = completed === snap.todosTotal ? "success" : inProgress > 0 ? "accent" : "text";
    segments.push({ text: `任务 ${completed}/${snap.todosTotal}（${pct}%）`, color });
  }
  if (snap.servicesTotal > 0) {
    segments.push({ text: `服务 ${snap.servicesRunning}/${snap.servicesTotal}`, color: snap.servicesRunning < snap.servicesTotal ? "review" : "success" });
  }
  const sep = paint("dim", " · ");
  let counters = "";
  for (const segment of segments) {
    const candidate = counters === "" ? paint(segment.color, segment.text) : `${counters}${sep}${paint(segment.color, segment.text)}`;
    if (visualWidth(candidate) > inner) break;
    counters = candidate;
  }

  return [counters];
}

function renderProcessRows(snap: TuiSnapshot, width: number, maxRows: number): string[] {
  const inner = width - 4;
  const rows: string[] = [];
  for (const command of snap.runningCommands.slice(0, maxRows)) {
    // Output-buffer fill ratio: the same "context health" idea ainovel-cli's
    // gradient encodes for its model context, applied to the capture budget a
    // running command can actually exhaust.
    const pct = command.capacityBytes > 0 ? Math.min(100, (command.capturedBytes / command.capacityBytes) * 100) : 0;
    const rightPlain = `${formatDuration(command.elapsedMs)} · ${formatBytes(command.capturedBytes)}/${formatBytes(command.capacityBytes)} ${bar(pct, 10)} ${Math.round(pct)}%`;
    const leftBudget = Math.max(12, inner - visualWidth(rightPlain) - 1);
    const left = truncateVisual(`▸ ${inlineText(command.id).slice(0, 8)} ${inlineText(command.command)}`, leftBudget);
    const pad = Math.max(1, inner - visualWidth(left) - visualWidth(rightPlain));
    rows.push(`${paint("text", left)}${" ".repeat(pad)}${paint(healthColor(pct), rightPlain)}`);
  }
  return rows;
}

function renderFooter(snap: TuiSnapshot, width: number): string[] {
  // The TUI is an observability surface, not a connection-secret surface. The
  // local Web Console address is safe and useful here; the tokenized MCP URL is
  // intentionally left to the startup banner and `open-bridge url`.
  return [padEndVisual(
    paint("muted", truncateVisual(`控制台 http://127.0.0.1:${snap.port}/console`, width)),
    width,
  )];
}

// --- workbench layout (stage 3): fixed sidebar + scrollable event panel -----
//
// The TUI is a VIEWING surface by design: settings and background operations
// live in the web console, and the workbench adds no command input. Its
// interactions are Tab view switching and scrolling the selected viewport.

/** Event rows visible in the workbench panel for a terminal size. */
function workbenchPanelRows(width: number, height: number): number {
  const wide = width >= 76 && height >= 22;
  return Math.max(1, height - (wide ? 3 : 4)); // wide: top bar + divider (2) + panel title (1); narrow also has one footer row
}

/** Largest first-visible index that still shows the oldest event (the bottom). */

export type PanelView = "activity" | "tasks" | "changes" | "diff" | "event";

export const PANEL_VIEWS = ["activity", "tasks", "changes"] as const;
type MainPanelView = typeof PANEL_VIEWS[number];
export function nextPanelView(view: PanelView): PanelView {
  const index = PANEL_VIEWS.indexOf(view as MainPanelView);
  return PANEL_VIEWS[(index + 1) % PANEL_VIEWS.length] ?? "activity";
}

function mainPanelNavigation(view: MainPanelView, count: number): string {
  const labels: Record<MainPanelView, string> = { activity: "活动", tasks: "任务", changes: "变更" };
  return `─ ${PANEL_VIEWS.map(candidate => candidate === view ? `[${labels[candidate]} ${count}]` : labels[candidate]).join(" · ")} [Tab] `;
}

function mainPanelView(view: PanelView): MainPanelView | undefined {
  return PANEL_VIEWS.includes(view as MainPanelView) ? view as MainPanelView : undefined;
}

function panelContentRows(view: PanelView, rows: number): number {
  return mainPanelView(view) !== undefined && rows > 1 ? rows - 1 : rows;
}

type FrameLayout = {
  width: number;
  height: number;
  sidebarWidth: number;
  panelWidth: number;
  panelRows: number;
  overview: string[];
  processes: string[];
};

/** One geometry source for both rendering and the driver's scroll steps. */
function frameLayout(snap: TuiSnapshot, width: number, height: number, view: PanelView): FrameLayout {
  width = Math.max(20, Math.min(400, Number.isFinite(width) ? Math.floor(width) : 80));
  height = Math.max(6, Math.min(200, Number.isFinite(height) ? Math.floor(height) : 24));
  const wide = width >= 76 && height >= 22;
  const sidebarWidth = wide ? Math.max(24, Math.min(40, Math.floor(width * 0.3))) : 0;
  const panelWidth = wide ? width - sidebarWidth - visualWidth("│") : width;
  // A narrow task view uses the whole body. The activity view keeps its
  // compact overview/process cards, dropping them before the last event row.
  const overview = !wide && view === "activity" ? boxLines("概览", renderOverviewRows(snap, width), width) : [];
  const processRows = !wide && view === "activity" ? renderProcessRows(snap, width, 4) : [];
  const processes = processRows.length > 0 ? boxLines("进程", processRows, width) : [];
  let panelRows = workbenchPanelRows(width, height) - overview.length - processes.length;
  if (panelRows < 1 && processes.length > 0) {
    panelRows += processes.length;
    processes.length = 0;
  }
  if (panelRows < 1 && overview.length > 0) {
    panelRows += overview.length;
    overview.length = 0;
  }
  return { width, height, sidebarWidth, panelWidth, panelRows: Math.max(1, panelRows), overview, processes };
}

/** The real viewport's row counts, including wrapped task titles and spacers. */
export function panelScrollMetrics(
  snap: TuiSnapshot,
  options: { width: number; height: number; panelView: PanelView; now?: number; spinnerFrame?: number; eventDetailKey?: string },
): { rows: number; totalRows: number } {
  const layout = frameLayout(snap, options.width, options.height, options.panelView);
  return {
    rows: panelContentRows(options.panelView, layout.panelRows),
    totalRows: options.panelView === "tasks" ? taskPanelRows(snap, layout.panelWidth, options.spinnerFrame ?? 0, options.now ?? Date.now()).length
      : options.panelView === "changes" ? changePanelRows(snap, layout.panelWidth).length
      : options.panelView === "diff" ? diffPanelRows(snap, layout.panelWidth).length
      : options.panelView === "event" ? eventDetailRows(snap, layout.panelWidth, options.eventDetailKey).length
      : snap.events.length, // 单行模式：一行就是一条事件，光标下标与行号同轴
  };
}

function renderPanel(
  snap: TuiSnapshot, width: number, rows: number, spin: number, now: number,
  view: PanelView, firstVisible: number, cursor = 0, detailKey?: string, changeCursor = 0,
): string[] {
  const tasksView = view === "tasks";
  const changesView = view === "changes";
  const diffView = view === "diff";
  const eventView = view === "event";
  const content = tasksView ? taskPanelRows(snap, width, spin, now)
    : changesView ? changePanelRows(snap, width, changeCursor)
    : diffView ? diffPanelRows(snap, width)
    : eventView ? eventDetailRows(snap, width, detailKey)
    : snap.events.map((event, index) => eventListRow(event, width, spin, now, index === cursor));
  const count = tasksView ? snap.todosTotal : changesView ? (snap.changes.status === "ready" ? (snap.changes.entries?.length ?? snap.changes.files) : 0)
    : diffView ? (snap.diff?.text ? snap.diff.text.split("\n").length : 0)
    : snap.events.length;
  const label = eventView ? "事件详情" : diffView ? (snap.diff?.kind === "file" ? "文件 diff" : "累计 diff") : `${tasksView ? "任务" : changesView ? "变更" : "活动"} (${count})`;
  const plainTitle = `─ ${label} `;
  const mainView = mainPanelView(view);
  const contentRows = panelContentRows(view, rows);
  const requested = Number.isFinite(firstVisible) ? Math.floor(firstVisible) : 0;
  const first = Math.min(Math.max(0, requested), maxFirstVisible(content.length, contentRows));
  let title = mainView === undefined ? plainTitle : mainPanelNavigation(mainView, count);
  const listView = tasksView || changesView || diffView;
  let hint = "";
  let hintTone: "accent" | "review" = "accent";
  if (tasksView && snap.todosTotal > 0) {
    const completed = snap.todos.filter(t => t.status === "completed").length;
    const pct = Math.round((completed / snap.todosTotal) * 100);
    const scrollInfo = content.length > contentRows ? `${first + 1}-${Math.min(first + contentRows, content.length)}/${content.length} 行` : "";
    if (content.length > contentRows) {
      hint = `${completed}/${snap.todosTotal} · ${scrollInfo}`;
      if (visualWidth(title) + visualWidth(hint) > width) hint = scrollInfo;
    } else {
      hint = `${bar(pct, 8)} ${pct}% · ${completed}/${snap.todosTotal} 完成`;
      if (visualWidth(title) + visualWidth(hint) > width) {
        hint = `${pct}% · ${completed}/${snap.todosTotal}`;
      }
    }
    // 新鲜度与卡住预警：有进行中任务却长时间没有写入，是最像「静默卡住」
    // 的形状 —— 预警色盖过常规提示。
    const updatedMs = snap.todosUpdatedAt !== undefined ? Date.parse(snap.todosUpdatedAt) : Number.NaN;
    if (Number.isFinite(updatedMs)) {
      const ageMin = Math.max(0, Math.round((now - updatedMs) / 60_000));
      if (snap.todos.some(todo => todo.status === "in_progress") && ageMin >= 10) {
        hintTone = "review";
        hint = `⚠ ${ageMin} 分钟未更新`;
        if (visualWidth(title) + visualWidth(hint) > width) hint = `⚠${ageMin}m`;
      } else if (ageMin < 24 * 60) {
        const stamp = `更新 ${formatClock(snap.todosUpdatedAt!)}`;
        hint = hint === "" ? stamp : `${hint} · ${stamp}`;
        if (visualWidth(title) + visualWidth(hint) > width) hint = stamp;
      }
    }
  } else if (listView) {
    const scroll = content.length > contentRows ? `${first + 1}-${Math.min(first + contentRows, content.length)}/${content.length} 行` : "";
    // 变更页与活动页共享光标/Enter 心智；d 继续保留累计审阅预览。
    hint = diffView ? "Esc 返回变更" : changesView
      ? (snap.changes.status === "ready" && (snap.changes.entries?.length ?? 0) > 0 ? "↑↓ 选择 · Enter 文件 diff · d 累计" : "d 累计 diff")
      : "";
    if (hint !== "" && scroll !== "") hint = `${hint} · ${scroll}`;
    else if (hint === "") hint = scroll;
  } else if (eventView) {
    // 与 diff 预览同一约定：Esc 是唯一出口，靠标题提示被发现。
    hint = "Esc 返回活动";
  } else {
    const scroll = first > 0 ? `↑${first} 行` : content.length > contentRows ? `↓${content.length - contentRows} 行` : "";
    // 光标选择是新交互，靠标题提示被发现；宽度不够时由下方统一丢弃。
    hint = scroll === "" ? "↑↓ 选择 · Enter 展开" : `Enter 展开 · ${scroll}`;
  }
  if (visualWidth(title) + visualWidth(hint) > width) hint = "";
  if (visualWidth(title) > width && mainView !== undefined) title = plainTitle;
  if (visualWidth(title) + visualWidth(hint) > width) title = `${label} `;
  const titleWidth = Math.max(1, width - visualWidth(hint));
  const heading = `${padEndVisual(paint("dim", truncateVisual(title, titleWidth)), titleWidth)}${hint === "" ? "" : paint(hintTone, hint)}`;
  const spacer = mainView !== undefined && rows > 1 ? [""] : [];
  const panel = [heading, ...spacer, ...visibleEvents(content, first, contentRows)];
  while (panel.length < rows + 1) panel.push("");
  return panel;
}

function renderWorkbench(
  snap: TuiSnapshot,
  options: {
    layout: FrameLayout; spin: number; now: number; busy: boolean;
    firstVisible: number; taskFirstVisible: number; changeFirstVisible: number; diffFirstVisible: number; panelView: PanelView;
    expandFirstVisible: number;
    activityCursor: number; changeCursor: number; eventDetailKey?: string;
  },
): string[] {
  const { layout, spin, now, busy, panelView } = options;
  const { width, height, sidebarWidth, panelWidth, panelRows } = layout;
  const bodyRows = panelRows + 1;
  const sidebar = renderSidebar(snap, sidebarWidth, bodyRows);
  const first = panelView === "tasks" ? options.taskFirstVisible
    : panelView === "changes" ? options.changeFirstVisible
    : panelView === "diff" ? options.diffFirstVisible
    : panelView === "event" ? options.expandFirstVisible
    : options.firstVisible;
  const panel = renderPanel(snap, panelWidth, panelRows, spin, now, panelView, first, options.activityCursor, options.eventDetailKey, options.changeCursor);
  const lines = [renderTopBar(snap, width, busy, spin), paint("dim", fillVisualWidth("─", width))];
  for (let i = 0; i < bodyRows; i += 1) {
    lines.push(`${padEndVisual(sidebar[i] ?? "", sidebarWidth)}${paint("dim", "│")}${padEndVisual(panel[i] ?? "", panelWidth)}`);
  }
  return fitFrame(lines, width, height);
}

/** Exact rows/columns also erase residue after a terminal resize. */
function fitFrame(lines: string[], width: number, height: number): string[] {
  return lines.slice(0, height).map(line => {
    if (visualWidth(line) > width) return padEndVisual(truncateVisual(stripAnsi(line), width), width);
    return padEndVisual(line, width);
  });
}

/** Both layouts render the selected view and use independent scroll offsets. */
export function renderFrame(
  snap: TuiSnapshot,
  options: {
    width: number; height: number; spinnerFrame?: number; now?: number;
    firstVisible?: number; taskFirstVisible?: number; changeFirstVisible?: number; diffFirstVisible?: number; panelView?: PanelView;
    expandFirstVisible?: number;
    activityCursor?: number; changeCursor?: number; eventDetailKey?: string;
  },
): string[] {
  const panelView = options.panelView ?? "activity";
  const layout = frameLayout(snap, options.width, options.height, panelView);
  const { width, height, panelRows } = layout;
  const spin = options.spinnerFrame ?? 0;
  const now = options.now ?? Date.now();
  const busy = snap.sessionsActive > 0 || snap.modernInFlight > 0 || snap.runningCommands.length > 0;
  const firstVisible = options.firstVisible ?? -1;
  const taskFirstVisible = options.taskFirstVisible ?? 0;
  const changeFirstVisible = options.changeFirstVisible ?? 0;
  const diffFirstVisible = options.diffFirstVisible ?? 0;
  const activityCursor = options.activityCursor ?? 0;
  const changeCursor = options.changeCursor ?? 0;
  if (layout.sidebarWidth > 0) {
    return renderWorkbench(snap, { layout, spin, now, busy, firstVisible, taskFirstVisible, changeFirstVisible, diffFirstVisible, panelView, expandFirstVisible: options.expandFirstVisible ?? 0, activityCursor, changeCursor, eventDetailKey: options.eventDetailKey });
  }
  const first = panelView === "tasks" ? taskFirstVisible
    : panelView === "changes" ? changeFirstVisible
    : panelView === "diff" ? diffFirstVisible
    : panelView === "event" ? (options.expandFirstVisible ?? 0)
    : firstVisible;
  const lines = [
    renderTopBar(snap, width, busy, spin), paint("dim", fillVisualWidth("─", width)),
    ...layout.overview, ...layout.processes,
    ...renderPanel(snap, width, panelRows, spin, now, panelView, first, activityCursor, options.eventDetailKey, changeCursor),
    ...renderFooter(snap, width),
  ];
  return fitFrame(lines, width, height);
}
