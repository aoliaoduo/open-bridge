/**
 * Pure renderers for the serve-console TUI.
 *
 * Every function maps a TuiSnapshot to strings of exactly `width` visual
 * columns — no stdout, no timers, no bridge imports — so the whole layout is
 * unit-testable and the driver stays a thin pump. The design language (top bar
 * with a status capsule, overview/process cards with a health gradient, a
 * timestamped event stream with ✓/✕/spinner icons, a pinned address footer) is
 * ported from ainovel-cli's TUI (internal/entry/tui/*.go): same colour roles,
 * same gradient thresholds, same three-state icons.
 *
 * Painting happens at segment granularity: each plain segment is measured and
 * truncated BEFORE it is painted, because truncation is not escape-aware.
 */

import { paint, healthColor, spinnerFrame, type ColorName } from "./theme.js";
import { fillVisualWidth, stripAnsi, inlineText, truncateVisual, padEndVisual, padStartVisual, visualWidth, wrapVisual, wrapVisualSoft } from "./text.js";

export type TuiEventStatus = "running" | "completed" | "error" | "progress" | "warning";

/** The driver's whole view model. Assembled by snapshot.ts, rendered here. */
export type TuiSnapshot = {
  version: string;
  rootName: string;
  bridgeState: "running" | "stopping" | "stopped";
  port: number;
  tunnel: "public" | "local" | "follower" | "blocked";
  mcpUrl: string;
  uptimeMs: number;
  calls: number;
  successes: number;
  failures: number;
  sessions: number;
  sessionsActive: number;
  /** Complete current task list; the viewport, not the snapshot, limits rows. */
  todos: Array<{ title: string; status: string }>;
  /** Total task count shared by both layouts. */
  todosTotal: number;
  /** Workspace changes since the last commit; absent = 非 git; unavailable = 读取失败. */
  changes?: {
    files: number;
    insertions: number;
    deletions: number;
    unavailable?: boolean;
    entries?: Array<{ path: string; insertions: number; deletions: number; untracked?: boolean; binary?: boolean }>;
  };
  runningCommands: Array<{
    id: string;
    command: string;
    elapsedMs: number;
    capturedBytes: number;
    capacityBytes: number;
  }>;
  servicesTotal: number;
  servicesRunning: number;
  /** Per-service rows for the workbench sidebar (name + live state). */
  serviceRows: Array<{ name: string; running: boolean }>;
  events: Array<{ at: string; tool: string; status: TuiEventStatus; message: string; durationMs?: number }>;
  logPath: string;
};

// --- pure formatters (unit-tested; no locale surprises) ---

export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000));
  if (safe < 60) return `${safe}s`;
  if (safe < 3600) return `${Math.floor(safe / 60)}m${String(safe % 60).padStart(2, "0")}s`;
  return `${Math.floor(safe / 3600)}h${String(Math.floor((safe % 3600) / 60)).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.floor(bytes))}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function formatCount(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString("en-US");
}

/** Local HH:MM:SS for an ISO instant — the console speaks wall clock (see node-host.ts). */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, "0")).join(":");
}

// --- vocabulary (ported from ainovel-cli's theme.go status tables) ---

const CAPSULE: Record<TuiSnapshot["bridgeState"], { icon: string; label: string; color: ColorName }> = {
  running: { icon: "●", label: "运行中", color: "running" },
  stopping: { icon: "⏸", label: "停止中", color: "review" },
  stopped: { icon: "○", label: "未启动", color: "dim" },
};

const TUNNEL_TAG: Record<TuiSnapshot["tunnel"], { text: string; color: ColorName }> = {
  // The value must not repeat the field label: 「隧道 隧道 ●」 read as a stutter.
  public: { text: "公网 ●", color: "accent" },
  local: { text: "仅本机", color: "dim" },
  follower: { text: "跟随实例", color: "review" },
  blocked: { text: "隧道受阻", color: "error" },
};

function bar(percent: number, cells: number): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  return `${"▓".repeat(filled)}${"░".repeat(Math.max(0, cells - filled))}`;
}

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
  const leftText = `◆ open-bridge v${inlineText(snap.version)} · 端口 ${snap.port}`;
  const capsule = CAPSULE[snap.bridgeState];
  // The busy state replaces the static dot with the live spinner — the same
  // trick ainovel-cli's top bar uses so the capsule itself carries motion.
  const icon = snap.bridgeState === "running" && busy ? spinnerFrame(spin) : capsule.icon;
  const rightText = `${icon} ${capsule.label}`;

  // ainovel-cli's top-bar cell math: the centre keeps at least a third of the
  // width, the sides split the rest evenly.
  const innerW = Math.max(12, width);
  const titleText = truncateVisual(inlineText(snap.rootName), Math.max(8, Math.floor(innerW / 3)));
  let centerW = Math.max(16, visualWidth(titleText) + 6);
  if (centerW > innerW - 24) centerW = Math.max(8, innerW - 24);
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
    { text: `会话 ${snap.sessions}${snap.sessionsActive > 0 ? ` · 活跃 ${snap.sessionsActive}` : ""}`, color: "text" },
    { text: `进程 ${snap.runningCommands.length}`, color: "text" },
  ];
  if (snap.todosTotal > 0) {
    const inProgress = snap.todos.filter(todo => todo.status === "in_progress").length;
    segments.push({ text: `任务 ${snap.todosTotal}（${inProgress} 进行中）`, color: inProgress > 0 ? "accent" : "text" });
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

  // The tunnel tag rides the counters row; the MCP address moved to the
  // footer, which owns it exclusively (it used to appear in both places).
  const tag = TUNNEL_TAG[snap.tunnel];
  segments.push({ text: tag.text, color: tag.color });

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

/** One event, wrapped to `width` columns. Continuation lines keep the message; nothing is `...`-amputated. */
export function eventRows(
  event: TuiSnapshot["events"][number],
  width: number,
  spin: number,
  now: number,
): string[] {
  const tool = inlineText(event.tool);
  const message = inlineText(event.message);
  const icon =
    event.status === "running" ? paint("accent", spinnerFrame(spin), { bold: true })
    : event.status === "completed" ? paint("success", "✓")
    : event.status === "error" ? paint("error", "✕", { bold: true })
    : event.status === "warning" ? paint("review", "⚠")
    : paint("context", "◆");
  // A running row shows live elapsed time; a finished row shows the matched
  // duration only when the invoke/outcome pair was actually observed —
  // never an invented one.
  const rightText =
    event.status === "running"
      ? `${formatDuration(Math.max(0, now - Date.parse(event.at)))}…`
      : event.durationMs !== undefined
        ? (event.durationMs < 1000 ? `${Math.round(event.durationMs)}ms` : formatDuration(event.durationMs))
        : "";
  const clock = formatClock(event.at);
  const mark = event.status === "running" ? spinnerFrame(spin)
    : event.status === "completed" ? "✓"
    : event.status === "error" ? "✕"
    : event.status === "warning" ? "⚠"
    : "◆";
  const prefixPlain = `${clock} ${mark} ${tool} `;
  const prefix = `${paint("dim", clock)} ${icon} ${paint("tool", tool)} `;
  const prefixW = visualWidth(prefixPlain);
  const rightW = rightText === "" ? 0 : visualWidth(rightText);
  const msgWidth = Math.max(1, width - prefixW - (rightW > 0 ? rightW + 1 : 0));
  const chunks = wrapVisualSoft(message, msgWidth);
  if (chunks.length === 0) chunks.push("");
  return chunks.map((chunk, index) => {
    if (index === 0) {
      const left = `${prefix}${chunk.length > 0 ? paint("muted", chunk) : ""}`;
      const line = rightText === ""
        ? padEndVisual(left, width)
        : `${padEndVisual(left, Math.max(0, width - rightW))}${paint("dim", rightText)}`;
      if (visualWidth(line) > width) return padEndVisual(truncateVisual(stripAnsi(line), width), width);
      return padEndVisual(line, width);
    }
    return padEndVisual(`${" ".repeat(prefixW)}${paint("muted", chunk)}`, width);
  });
}

export function eventRow(
  event: TuiSnapshot["events"][number],
  width: number,
  spin: number,
  now: number,
): string {
  return eventRows(event, width, spin, now)[0] ?? padEndVisual("", width);
}


function renderFooter(snap: TuiSnapshot, width: number): string[] {
  // One fact, one place: the top bar owns identity, port and status; the
  // sidebar owns the counters and the tunnel; the footer owns the addresses —
  // the web console entry (the api-router loopback gate only answers the
  // local Host, so this is always the local address) and the MCP URL.
  const line1 = padEndVisual(paint("muted", truncateVisual(`控制台 http://127.0.0.1:${snap.port}/console/`, width)), width);
  // One address per row: sharing truncated the MCP URL into "..." on small
  // screens — the one string an operator copies. The instruction row is gone
  // entirely; closing the window stops the serve, and the scroll keys surface
  // in the panel title the moment they matter (while scrolled).
  const line2 = padEndVisual(paint("muted", truncateVisual(`MCP ${inlineText(snap.mcpUrl)}`, width)), width);
  return [line1, line2];
}

// --- workbench layout (stage 3): fixed sidebar + scrollable event panel -----
//
// The TUI is a VIEWING surface by design: settings and background operations
// live in the web console, and the workbench adds no command input. Its
// interactions are Tab view switching and scrolling the selected viewport.

/** Event rows visible in the workbench panel for a terminal size. */
export function workbenchPanelRows(width: number, height: number): number {
  void width;
  return Math.max(1, height - 5); // top bar + divider (2) + panel title (1) + footer (2)
}

/** Largest first-visible index that still shows the oldest event (the bottom). */
export function maxFirstVisible(eventCount: number, rows: number): number {
  return Math.max(0, eventCount - rows);
}

/**
 * Which events the panel shows. `firstVisible` below zero clamps to the head
 * — index 0, the newest event — so "follow the latest" is simply "a
 * first-visible of -1", the value the driver keeps until the user scrolls.
 */
export function visibleEvents<T>(events: readonly T[], firstVisible: number, rows: number): T[] {
  const max = maxFirstVisible(events.length, rows);
  const start = Math.min(Math.max(0, Math.floor(firstVisible)), max);
  return events.slice(start, start + Math.max(1, rows));
}

export type ScrollKey = "up" | "down" | "pageup" | "pagedown" | "home" | "end";

/** One pure scroll step: newer = smaller index, `home` re-locks to the head. */
export function advanceScroll(key: ScrollKey, current: number, eventCount: number, rows: number): number {
  const max = maxFirstVisible(eventCount, rows);
  const page = Math.max(1, rows - 1);
  const at = Math.min(Math.max(0, current), max);
  switch (key) {
    case "up": return Math.max(0, at - 1);
    case "down": return Math.min(max, at + 1);
    case "pageup": return Math.max(0, at - page);
    case "pagedown": return Math.min(max, at + page);
    case "home": return 0;
    case "end": return max;
  }
}

function sidebarField(lines: string[], width: number, label: string, value: string, color: ColorName = "text"): void {
  const labelPart = paint("muted", padEndVisual(label, 8));
  lines.push(`${labelPart} ${paint(color, truncateVisual(value, Math.max(4, width - 10)))}`);
}

function renderSidebar(snap: TuiSnapshot, width: number): string[] {
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push(paint("dim", padEndVisual(`─ ${title} `, width)));
  };

  section("概览");
  // No 状态 field: the top-bar capsule already owns that fact — the first live
  // screen showed it twice.
  const tag = TUNNEL_TAG[snap.tunnel];
  sidebarField(lines, width, "隧道", tag.text, tag.color);
  sidebarField(lines, width, "运行", formatDuration(snap.uptimeMs));
  sidebarField(lines, width, "调用", `${formatCount(snap.calls)} · ✓ ${formatCount(snap.successes)} ✕ ${formatCount(snap.failures)}`, snap.failures > 0 ? "review" : "text");
  // No /64 cap: the session ceiling is developer knowledge; the operator
  // only needs to know how many clients are connected right now.
  sidebarField(lines, width, "会话", `${snap.sessions}${snap.sessionsActive > 0 ? ` · 活跃 ${snap.sessionsActive}` : ""}`);
  sidebarField(lines, width, "进程", `${snap.runningCommands.length}`);
  if (snap.serviceRows.length > 0) {
    sidebarField(lines, width, "服务", `${snap.serviceRows.filter(s => s.running).length}/${snap.serviceRows.length}`);
  }
  // A permanent resident: the row answers "is there uncommitted work?" and a
  // missing row cannot say whether that means clean or not-watching. Clean
  // reads as 干净; a workspace without git is named honestly, not faked;
  // a timeout or a failed read of a real repo is 读取失败, never 非 git.
  if (snap.changes === undefined) {
    sidebarField(lines, width, "变更", "非 git", "dim");
  } else if (snap.changes.unavailable) {
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
    // One summary line, never truncated titles: the full list lives in the
    // wide task view (Tab) — a 33-column sidebar can only amputate them.
    const inProgress = snap.todos.filter(todo => todo.status === "in_progress").length;
    sidebarField(lines, width, "任务", `${snap.todosTotal}（${inProgress} 进行中）`, inProgress > 0 ? "accent" : "text");
  }

  if (snap.runningCommands.length > 0) {
    // No empty placeholder section: the 概览 counter already says 进程 0.
    section("进程");
    for (const command of snap.runningCommands.slice(0, 6)) {
      const pct = command.capacityBytes > 0 ? Math.min(100, (command.capturedBytes / command.capacityBytes) * 100) : 0;
      const right = `${Math.round(pct)}%`;
      const left = truncateVisual(`▸ ${inlineText(command.id).slice(0, 8)} ${inlineText(command.command)}`, Math.max(6, width - visualWidth(right) - 1));
      lines.push(`${paint("text", left)} ${paint(healthColor(pct), right)}`);
    }
  }

  if (snap.serviceRows.length > 0) {
    section("服务");
    for (const service of snap.serviceRows.slice(0, 8)) {
      const mark = service.running ? paint("success", "●") : paint("dim", "○");
      lines.push(`${mark} ${paint(service.running ? "text" : "dim", truncateVisual(inlineText(service.name), Math.max(4, width - 3)))}`);
    }
  }
  return lines;
}

/** Task titles wrap with a measured icon gutter, including in CJK terminals. */
function taskPanelRows(snap: TuiSnapshot, width: number, spin: number): string[] {
  if (snap.todos.length === 0) return [paint("dim", "暂无任务")];
  const rows: string[] = [];
  const gutter = Math.max(visualWidth("✓"), visualWidth("·"), visualWidth(spinnerFrame(spin))) + 1;
  for (const todo of snap.todos) {
    const isCurrent = todo.status === "in_progress";
    const mark = todo.status === "completed" ? paint("success", "✓")
      : isCurrent ? paint("accent", spinnerFrame(spin), { bold: true })
      : paint("dim", "·");
    const titleColor: ColorName = isCurrent ? "text" : "dim";
    // A title may contain real line breaks. They must become viewport rows,
    // never embedded terminal newlines that escape the frame's height budget.
    const wrapped = stripAnsi(todo.title).replace(/\r\n?/g, "\n").split("\n")
      .flatMap(line => wrapVisual(inlineText(line.replace(/\t/g, "    ")), Math.max(1, width - gutter)));
    wrapped.forEach((line, index) => {
      rows.push(`${index === 0 ? padEndVisual(mark, gutter) : " ".repeat(gutter)}${paint(titleColor, line, { bold: isCurrent })}`);
    });
    rows.push("");
  }
  rows.pop(); // no trailing spacer: End must land on the final task's text
  return rows;
}


/** Per-file +/- list for the Tab 「变更」 page. Paths wrap; counts keep their columns. */
function changePanelRows(snap: TuiSnapshot, width: number): string[] {
  if (snap.changes === undefined) return [paint("dim", "非 git")];
  if (snap.changes.unavailable) return [paint("dim", "读取失败")];
  const entries = snap.changes.entries ?? [];
  if (entries.length === 0) return [paint("dim", "暂无变更")];

  const addTexts = entries.map(entry => entry.binary ? "" : `+${formatCount(entry.insertions)}`);
  const delTexts = entries.map(entry => entry.binary || (entry.untracked && entry.deletions === 0) ? "" : `-${formatCount(entry.deletions)}`);
  const addW = Math.max(2, ...addTexts.map(text => visualWidth(text)));
  const delW = Math.max(2, ...delTexts.map(text => visualWidth(text)));
  const gutter = addW + 1 + delW + 1;
  const pathWidth = Math.max(1, width - gutter);
  const rows: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const path = inlineText(entry.path).replace(/\t/g, "    ");
    const wrapped = wrapVisual(path, pathWidth);
    const counts = entry.binary
      ? padEndVisual(paint("dim", "二进制"), gutter)
      : `${paint("success", padStartVisual(addTexts[index] ?? "", addW))} ${delTexts[index] ? paint("error", padStartVisual(delTexts[index] ?? "", delW)) : " ".repeat(delW)} `;
    wrapped.forEach((line, lineIndex) => {
      if (lineIndex === 0) {
        const tag = entry.untracked && visualWidth(line) + visualWidth(" 未跟踪") <= pathWidth ? paint("dim", " 未跟踪") : "";
        rows.push(`${counts}${paint("text", line)}${tag}`);
      } else {
        rows.push(`${" ".repeat(gutter)}${paint("text", line)}`);
      }
    });
  }
  return rows;
}

export type PanelView = "activity" | "tasks" | "changes";
export const PANEL_VIEWS: readonly PanelView[] = ["activity", "tasks", "changes"];
export function nextPanelView(view: PanelView): PanelView {
  const index = PANEL_VIEWS.indexOf(view);
  return PANEL_VIEWS[(index + 1) % PANEL_VIEWS.length] ?? "activity";
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
  options: { width: number; height: number; panelView: PanelView; now?: number; spinnerFrame?: number },
): { rows: number; totalRows: number } {
  const layout = frameLayout(snap, options.width, options.height, options.panelView);
  return {
    rows: layout.panelRows,
    totalRows: options.panelView === "tasks" ? taskPanelRows(snap, layout.panelWidth, options.spinnerFrame ?? 0).length
      : options.panelView === "changes" ? changePanelRows(snap, layout.panelWidth).length
      : snap.events.flatMap(event => eventRows(event, layout.panelWidth, options.spinnerFrame ?? 0, options.now ?? 0)).length,
  };
}

function renderPanel(
  snap: TuiSnapshot, width: number, rows: number, spin: number, now: number,
  view: PanelView, firstVisible: number,
): string[] {
  const tasksView = view === "tasks";
  const changesView = view === "changes";
  const content = tasksView ? taskPanelRows(snap, width, spin)
    : changesView ? changePanelRows(snap, width)
    : snap.events.flatMap(event => eventRows(event, width, spin, now));
  const requested = Number.isFinite(firstVisible) ? Math.floor(firstVisible) : 0;
  const first = Math.min(Math.max(0, requested), maxFirstVisible(content.length, rows));
  const count = tasksView ? snap.todosTotal : changesView ? (snap.changes?.entries?.length ?? snap.changes?.files ?? 0) : snap.events.length;
  const label = `${tasksView ? "任务" : changesView ? "变更" : "活动"} (${count})`;
  let title = `─ ${label} `;
  const listView = tasksView || changesView;
  // Scroll position only: Tab still cycles the views, but the title no longer
  // advertises the next page (「Tab 任务」 read as the current view).
  let hint = "";
  if (tasksView && snap.todosTotal > 0) {
    const completed = snap.todos.filter(t => t.status === "completed").length;
    const inProgress = snap.todos.filter(t => t.status === "in_progress").length;
    const pct = Math.round((completed / snap.todosTotal) * 100);
    const scrollInfo = content.length > rows ? `${first + 1}-${Math.min(first + rows, content.length)}/${content.length} 行` : "";
    if (content.length > rows) {
      hint = `${completed}/${snap.todosTotal} · ${scrollInfo}`;
      if (visualWidth(title) + visualWidth(hint) > width) hint = scrollInfo;
    } else {
      hint = `${bar(pct, 8)} ${pct}% · ${completed}/${snap.todosTotal} 完成${inProgress > 0 ? ` · ${inProgress} 进行中` : ""}`;
      if (visualWidth(title) + visualWidth(hint) > width) {
        hint = `${pct}% · ${completed}/${snap.todosTotal}`;
      }
    }
  } else if (listView) {
    hint = content.length > rows ? `${first + 1}-${Math.min(first + rows, content.length)}/${content.length} 行` : "";
  } else {
    hint = first > 0 ? `↑${first} 行 · Home 回顶` : "";
  }
  if (visualWidth(title) + visualWidth(hint) > width) hint = "";
  if (visualWidth(title) + visualWidth(hint) > width) title = `${label} `;
  const titleWidth = Math.max(1, width - visualWidth(hint));
  const heading = `${padEndVisual(paint("dim", truncateVisual(title, titleWidth)), titleWidth)}${hint === "" ? "" : paint("accent", hint)}`;
  const panel = [heading, ...visibleEvents(content, first, rows)];
  while (panel.length < rows + 1) panel.push("");
  return panel;
}

function renderWorkbench(
  snap: TuiSnapshot,
  options: {
    layout: FrameLayout; spin: number; now: number; busy: boolean;
    firstVisible: number; taskFirstVisible: number; changeFirstVisible: number; panelView: PanelView;
  },
): string[] {
  const { layout, spin, now, busy, panelView } = options;
  const { width, height, sidebarWidth, panelWidth, panelRows } = layout;
  const bodyRows = panelRows + 1;
  const sidebar = renderSidebar(snap, sidebarWidth).slice(0, bodyRows);
  while (sidebar.length < bodyRows) sidebar.push("");
  const first = panelView === "tasks" ? options.taskFirstVisible
    : panelView === "changes" ? options.changeFirstVisible
    : options.firstVisible;
  const panel = renderPanel(snap, panelWidth, panelRows, spin, now, panelView, first);
  const lines = [renderTopBar(snap, width, busy, spin), paint("dim", fillVisualWidth("─", width))];
  for (let i = 0; i < bodyRows; i += 1) {
    lines.push(`${padEndVisual(sidebar[i] ?? "", sidebarWidth)}${paint("dim", "│")}${padEndVisual(panel[i] ?? "", panelWidth)}`);
  }
  lines.push(...renderFooter(snap, width));
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
    firstVisible?: number; taskFirstVisible?: number; changeFirstVisible?: number; panelView?: PanelView;
  },
): string[] {
  const panelView = options.panelView ?? "activity";
  const layout = frameLayout(snap, options.width, options.height, panelView);
  const { width, height, panelRows } = layout;
  const spin = options.spinnerFrame ?? 0;
  const now = options.now ?? Date.now();
  const busy = snap.sessionsActive > 0 || snap.runningCommands.length > 0;
  const firstVisible = options.firstVisible ?? -1;
  const taskFirstVisible = options.taskFirstVisible ?? 0;
  const changeFirstVisible = options.changeFirstVisible ?? 0;
  if (layout.sidebarWidth > 0) {
    return renderWorkbench(snap, { layout, spin, now, busy, firstVisible, taskFirstVisible, changeFirstVisible, panelView });
  }
  const first = panelView === "tasks" ? taskFirstVisible
    : panelView === "changes" ? changeFirstVisible
    : firstVisible;
  const lines = [
    renderTopBar(snap, width, busy, spin), paint("dim", fillVisualWidth("─", width)),
    ...layout.overview, ...layout.processes,
    ...renderPanel(snap, width, panelRows, spin, now, panelView, first),
    ...renderFooter(snap, width),
  ];
  return fitFrame(lines, width, height);
}
