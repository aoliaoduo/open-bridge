/**
 * Pure renderers for the serve-console TUI (stage 1: status area + event stream).
 *
 * Every function maps a TuiSnapshot to strings of exactly `width` visual
 * columns — no stdout, no timers, no bridge imports — so the whole layout is
 * unit-testable and the driver stays a thin pump. The design language (top bar
 * with a status capsule, overview/process cards with a health gradient, a
 * timestamped event stream with ✓/✕/spinner icons, a one-line usage footer) is
 * ported from ainovel-cli's TUI (internal/entry/tui/*.go): same colour roles,
 * same gradient thresholds, same three-state icons.
 *
 * Painting happens at segment granularity: each plain segment is measured and
 * truncated BEFORE it is painted, because truncation is not escape-aware.
 */

import { paint, healthColor, spinnerFrame, type ColorName } from "./theme.js";
import { fillVisualWidth, stripAnsi, truncateVisual, padEndVisual, padStartVisual, visualWidth } from "./text.js";

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
  maxSessions: number;
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
  const leftText = `◆ open-bridge v${snap.version} · 端口 ${snap.port}`;
  const capsule = CAPSULE[snap.bridgeState];
  // The busy state replaces the static dot with the live spinner — the same
  // trick ainovel-cli's top bar uses so the capsule itself carries motion.
  const icon = snap.bridgeState === "running" && busy ? spinnerFrame(spin) : capsule.icon;
  const rightText = `${icon} ${capsule.label}`;

  // ainovel-cli's top-bar cell math: the centre keeps at least a third of the
  // width, the sides split the rest evenly.
  const innerW = Math.max(12, width);
  const titleText = truncateVisual(snap.rootName, Math.max(8, Math.floor(innerW / 3)));
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
  const sessionPct = snap.maxSessions > 0 ? (snap.sessions / snap.maxSessions) * 100 : 0;
  const segments: Array<{ text: string; color: ColorName }> = [
    { text: `运行 ${formatDuration(snap.uptimeMs)}`, color: "text" },
    { text: `调用 ${formatCount(snap.calls)}（✓ ${formatCount(snap.successes)} ✕ ${formatCount(snap.failures)}）`, color: snap.failures > 0 ? "review" : "text" },
    { text: `会话 ${snap.sessions}/${snap.maxSessions}${snap.sessionsActive > 0 ? ` · 活跃 ${snap.sessionsActive}` : ""}`, color: healthColor(sessionPct) },
    { text: `进程 ${snap.runningCommands.length}`, color: "text" },
  ];
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
    const left = truncateVisual(`▸ ${command.id.slice(0, 8)} ${command.command}`, leftBudget);
    const pad = Math.max(1, inner - visualWidth(left) - visualWidth(rightPlain));
    rows.push(`${paint("text", left)}${" ".repeat(pad)}${paint(healthColor(pct), rightPlain)}`);
  }
  return rows;
}

/** One event line, exactly `width` columns — shared by the stacked stream and
 *  the workbench panel so the two cannot drift apart. */
export function eventRow(
  event: TuiSnapshot["events"][number],
  width: number,
  spin: number,
  now: number,
): string {
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
        ? formatDuration(event.durationMs)
        : "";
  const headPlain = `${formatClock(event.at)} ${event.status === "running" ? spinnerFrame(spin) : event.status === "completed" ? "✓" : event.status === "error" ? "✕" : event.status === "warning" ? "⚠" : "◆"} ${event.tool}`;
  const rightBudget = rightText === "" ? 0 : visualWidth(rightText) + 1;
  // On a narrow window the message is the first thing to go (the timestamp,
  // the state icon and the tool name identify the row; the message decorates it).
  const msgBudget = width - visualWidth(headPlain) - rightBudget - 2;
  const msgPart = msgBudget >= 1 ? ` ${paint("muted", truncateVisual(event.message, msgBudget))}` : "";
  let left = `${paint("dim", formatClock(event.at))} ${icon} ${paint("tool", event.tool)}${msgPart}`;
  if (visualWidth(left) > width - (rightBudget > 0 ? visualWidth(rightText) : 0)) {
    // Absurdly narrow: keep the information, lose the paint.
    left = truncateVisual(stripAnsi(left), Math.max(4, width - (rightBudget > 0 ? visualWidth(rightText) : 0)));
  }
  return rightText === "" ? padEndVisual(left, width) : `${padEndVisual(left, width - visualWidth(rightText))}${paint("dim", rightText)}`;
}

function renderEvents(snap: TuiSnapshot, width: number, budget: number, spin: number, now: number): string[] {
  if (budget <= 0) return [];
  const out: string[] = [];
  const head = "─ 活动 ";
  out.push(paint("dim", `${head}${fillVisualWidth("─", Math.max(1, width - visualWidth(head)))}`));
  for (const event of snap.events.slice(0, Math.max(0, budget - 1))) {
    out.push(eventRow(event, width, spin, now));
  }
  return out;
}

function renderFooter(snap: TuiSnapshot, width: number): string[] {
  // One fact, one place: the top bar owns identity, port and status; the
  // sidebar owns the counters and the tunnel; the footer owns the MCP address
  // — the thing an operator reaches for. The first live screen printed the
  // port three times, sessions and calls twice, and the workspace name twice.
  const line1 = padEndVisual(paint("muted", truncateVisual(`MCP ${snap.mcpUrl}`, width)), width);
  const line2 = paint("dim", truncateVisual(`Ctrl+C 停止 · ↑↓ 滚动 · End 最新 · 日志 ${snap.logPath} · --no-tui 关闭界面`, width));
  return [line1, line2];
}

// --- workbench layout (stage 3): fixed sidebar + scrollable event panel -----
//
// The TUI is a VIEWING surface by design: settings and background operations
// live in the web console, and the workbench adds no command input. Its one
// interaction is scrolling the activity history, handled by the driver.

/** Event rows visible in the workbench panel for a terminal size. */
export function workbenchPanelRows(width: number, height: number): number {
  void width;
  return Math.max(1, height - 5); // top bar + divider (2) + panel title (1) + footer (2)
}

/** Largest first-visible index that still shows the newest event (the tail). */
export function maxFirstVisible(eventCount: number, rows: number): number {
  return Math.max(0, eventCount - rows);
}

/**
 * Which events the panel shows. `firstVisible` beyond the tail clamps to the
 * tail, so "follow the latest" is simply "a first-visible larger than the
 * event count" — the same value the driver keeps until the user scrolls.
 */
export function visibleEvents<T>(events: readonly T[], firstVisible: number, rows: number): T[] {
  const max = maxFirstVisible(events.length, rows);
  const start = Math.min(Math.max(0, Math.floor(firstVisible)), max);
  return events.slice(start, start + Math.max(1, rows));
}

export type ScrollKey = "up" | "down" | "pageup" | "pagedown" | "home" | "end";

/** One pure scroll step: older = smaller index, `end` re-locks to the tail. */
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
  const sessionPct = snap.maxSessions > 0 ? (snap.sessions / snap.maxSessions) * 100 : 0;
  sidebarField(lines, width, "会话", `${snap.sessions}/${snap.maxSessions}${snap.sessionsActive > 0 ? ` · 活跃 ${snap.sessionsActive}` : ""}`, healthColor(sessionPct));
  sidebarField(lines, width, "进程", `${snap.runningCommands.length}`);
  if (snap.serviceRows.length > 0) {
    sidebarField(lines, width, "服务", `${snap.serviceRows.filter(s => s.running).length}/${snap.serviceRows.length}`);
  }

  if (snap.runningCommands.length > 0) {
    // No empty placeholder section: the 概览 counter already says 进程 0.
    section("进程");
    for (const command of snap.runningCommands.slice(0, 6)) {
      const pct = command.capacityBytes > 0 ? Math.min(100, (command.capturedBytes / command.capacityBytes) * 100) : 0;
      const right = `${Math.round(pct)}%`;
      const left = truncateVisual(`▸ ${command.id.slice(0, 8)} ${command.command}`, Math.max(6, width - visualWidth(right) - 1));
      lines.push(`${paint("text", left)} ${paint(healthColor(pct), right)}`);
    }
  }

  if (snap.serviceRows.length > 0) {
    section("服务");
    for (const service of snap.serviceRows.slice(0, 8)) {
      const mark = service.running ? paint("success", "●") : paint("dim", "○");
      lines.push(`${mark} ${paint(service.running ? "text" : "dim", truncateVisual(service.name, Math.max(4, width - 3)))}`);
    }
  }
  return lines;
}

function renderWorkbench(
  snap: TuiSnapshot,
  options: { width: number; height: number; spin: number; now: number; busy: boolean; firstVisible: number },
): string[] {
  const { width, height, spin, now, busy } = options;
  const sidebarW = Math.max(24, Math.min(40, Math.floor(width * 0.3)));
  const panelW = width - sidebarW - visualWidth("│");
  const bodyRows = height - 4;
  const rows = Math.max(1, bodyRows - 1);

  const sidebar = renderSidebar(snap, sidebarW).slice(0, bodyRows);
  while (sidebar.length < bodyRows) sidebar.push("");

  const maxFirst = maxFirstVisible(snap.events.length, rows);
  const first = Math.min(Math.max(0, Math.floor(options.firstVisible)), maxFirst);
  const older = first; // rows of retained history above the current view
  // Off the tail (older events exist below the view) the way back deserves a
  // hint even when no rows sit above the view yet.
  const offTail = first < maxFirst;
  const titleLeft = `─ 活动 (${snap.events.length}) `;
  const hint = offTail ? (older > 0 ? `↑${older} 行 · End 回底 ` : "End 回底 ") : "";
  const panel: string[] = [
    `${padEndVisual(paint("dim", titleLeft), Math.max(1, panelW - visualWidth(hint)))}${hint === "" ? "" : paint("accent", hint)}`,
    ...visibleEvents(snap.events, first, rows).map(event => eventRow(event, panelW, spin, now)),
  ];
  while (panel.length < bodyRows) panel.push("");

  const lines: string[] = [renderTopBar(snap, width, busy, spin), paint("dim", fillVisualWidth("─", width))];
  for (let i = 0; i < bodyRows; i += 1) {
    lines.push(`${padEndVisual(sidebar[i] ?? "", sidebarW)}${paint("dim", "│")}${padEndVisual(panel[i] ?? "", panelW)}`);
  }
  lines.push(...renderFooter(snap, width));
  return lines.slice(0, height).map(line => {
    const w = visualWidth(line);
    if (w > width) return padEndVisual(truncateVisual(stripAnsi(line), width), width);
    return padEndVisual(line, width);
  });
}

/**
 * Lay out one full frame. The row budget is exact: whatever the terminal
 * height, the result never exceeds `height` lines (a wrapped line would smear
 * the repaint), and every line is padded to `width` so residue from a wider
 * previous frame is overwritten.
 *
 * Small-window ladder: the process card drops first, then the overview loses
 * its MCP row; the top bar, at least one event row and the footer survive.
 */
export function renderFrame(
  snap: TuiSnapshot,
  options: { width: number; height: number; spinnerFrame?: number; now?: number; firstVisible?: number },
): string[] {
  const width = Math.max(20, Math.min(400, Math.floor(options.width)));
  const height = Math.max(6, Math.min(200, Math.floor(options.height)));
  const spin = options.spinnerFrame ?? 0;
  const now = options.now ?? Date.now();
  const busy = snap.sessionsActive > 0 || snap.runningCommands.length > 0;

  // The workbench split needs room for both columns; a narrow or short
  // terminal keeps the stage-1 stacked layout, which packs small frames best.
  if (width >= 76 && height >= 22) {
    return renderWorkbench(snap, { width, height, spin, now, busy, firstVisible: options.firstVisible ?? Number.MAX_SAFE_INTEGER });
  }

  const lines: string[] = [renderTopBar(snap, width, busy, spin), paint("dim", fillVisualWidth("─", width))];

  const overview = boxLines("概览", renderOverviewRows(snap, width), width);
  const processRows = renderProcessRows(snap, width, 4);
  const processes = processRows.length > 0 ? boxLines("进程", processRows, width) : [];
  const footer = renderFooter(snap, width);

  let eventsBudget = height - lines.length - overview.length - processes.length - footer.length;
  if (eventsBudget < 1 && processes.length > 0) {
    eventsBudget += processes.length;
    processes.length = 0;
  }
  if (eventsBudget < 1 && overview.length > 0) {
    // Still short: drop the overview box whole — the survival set is the top
    // bar, one event row and the footer.
    eventsBudget += overview.length;
    overview.length = 0;
  }
  eventsBudget = Math.max(0, eventsBudget);

  lines.push(...overview, ...processes, ...renderEvents(snap, width, eventsBudget, spin, now));
  // Pin the footer to the bottom rows: with few events the frame would
  // otherwise top-pack, leaving the lower terminal dark and the footer
  // floating mid-screen. ainovel-cli's layout keeps its status bar on the
  // last line whatever the content height; so does this one.
  while (lines.length < height - footer.length) lines.push("");
  lines.push(...footer);
  // Final safety net: a row that still measures past `width` (a corner the
  // budget math above could not foresee) is degraded to unpainted truncation
  // and re-padded — a 2-column character at the seam can leave the cut one
  // column short, and a wrapped line would smear the repaint.
  return lines.slice(0, height).map(line => {
    const w = visualWidth(line);
    if (w > width) return padEndVisual(truncateVisual(stripAnsi(line), width), width);
    return padEndVisual(line, width);
  });
}
