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
import { stripAnsi, truncateVisual, padEndVisual, padStartVisual, visualWidth } from "./text.js";

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
  public: { text: "隧道 ●", color: "accent" },
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
  const inner = width - 4;
  if (inner < 10 || rows.length === 0) return [];
  const head = `─ ${title} `;
  const top = `╭${head}${"─".repeat(Math.max(1, width - 2 - visualWidth(head)))}╮`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
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

  // Row 2 — where to connect, and how far the tunnel reaches.
  const tag = TUNNEL_TAG[snap.tunnel];
  const urlBudget = inner - visualWidth(tag.text) - 3;
  const url = truncateVisual(`MCP ${snap.mcpUrl}`, Math.max(10, urlBudget));
  const urls = `${paint("muted", url)}  ${paint(tag.color, tag.text)}`;

  return [counters, urls];
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

function renderEvents(snap: TuiSnapshot, width: number, budget: number, spin: number, now: number): string[] {
  if (budget <= 0) return [];
  const out: string[] = [];
  const head = "─ 活动 ";
  out.push(paint("dim", `${head}${"─".repeat(Math.max(1, width - visualWidth(head)))}`));
  for (const event of snap.events.slice(0, Math.max(0, budget - 1))) {
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
    out.push(rightText === "" ? padEndVisual(left, width) : `${padEndVisual(left, width - visualWidth(rightText))}${paint("dim", rightText)}`);
  }
  return out;
}

function renderFooter(snap: TuiSnapshot, width: number): string[] {
  const leftRest = ` open-bridge · 会话 ${snap.sessions}/${snap.maxSessions} · 调用 ${formatCount(snap.calls)} · 端口 ${snap.port}`;
  const right = truncateVisual(`./${snap.rootName}`, Math.max(4, width - 12));
  const rightW = visualWidth(right);
  let leftCut = truncateVisual(leftRest, Math.max(10, width - rightW - 1));
  let gapSpaces = width - 1 - visualWidth(leftCut) - rightW;
  if (gapSpaces < 0) {
    // The left side filled its budget exactly and the minimum gap would push
    // past the edge — cut the left side further instead of overflowing.
    leftCut = truncateVisual(leftRest, Math.max(4, visualWidth(leftCut) + gapSpaces));
    gapSpaces = width - 1 - visualWidth(leftCut) - rightW;
  }
  if (gapSpaces < 0) gapSpaces = 0;
  const line1 = `${paint("accent", "◆", { bold: true })}${paint("dim", leftCut)}${" ".repeat(gapSpaces)}${paint("dim", right)}`;
  const line2 = paint("dim", truncateVisual(`Ctrl+C 停止 · 日志 ${snap.logPath} · --no-tui 关闭界面`, width));
  return [padEndVisual(line1, width), line2];
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
  options: { width: number; height: number; spinnerFrame?: number; now?: number },
): string[] {
  const width = Math.max(20, Math.min(400, Math.floor(options.width)));
  const height = Math.max(6, Math.min(200, Math.floor(options.height)));
  const spin = options.spinnerFrame ?? 0;
  const now = options.now ?? Date.now();
  const busy = snap.sessionsActive > 0 || snap.runningCommands.length > 0;

  const lines: string[] = [renderTopBar(snap, width, busy, spin), paint("dim", "─".repeat(width))];

  const overview = boxLines("概览", renderOverviewRows(snap, width), width);
  const processRows = renderProcessRows(snap, width, 4);
  const processes = processRows.length > 0 ? boxLines("进程", processRows, width) : [];
  const footer = renderFooter(snap, width);

  let eventsBudget = height - lines.length - overview.length - processes.length - footer.length;
  if (eventsBudget < 1 && processes.length > 0) {
    eventsBudget += processes.length;
    processes.length = 0;
  }
  if (eventsBudget < 1 && overview.length >= 3) {
    // Drop the MCP row, keep the counters row.
    overview.splice(2, 1);
    eventsBudget += 1;
  }
  eventsBudget = Math.max(0, eventsBudget);

  lines.push(...overview, ...processes, ...renderEvents(snap, width, eventsBudget, spin, now), ...footer);
  // Final safety net: a row that still measures past `width` (a corner the
  // budget math above could not foresee) is degraded to unpainted truncation
  // rather than wrapping and smearing the repaint.
  return lines.slice(0, height).map(line => {
    const w = visualWidth(line);
    if (w > width) return truncateVisual(stripAnsi(line), width);
    return padEndVisual(line, width);
  });
}
