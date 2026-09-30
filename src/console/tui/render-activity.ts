/** Activity-list rendering, detail rendering, and pure viewport scrolling. */
import type { ActivitySubjectKind } from "../../bridge/activity-presentation.js";
import { paint, spinnerFrame, type ColorName } from "./theme.js";
import { inlineText, padEndVisual, padStartVisual, stripAnsi, truncateVisual, truncateVisualTail, visualWidth, wrapVisualSoft } from "./text.js";
import { formatClock, formatDuration } from "./render-format.js";
import type { TuiSnapshot } from "./render-model.js";

/** Stable event identity; old in-memory rows fall back to their legacy key. */
export function eventKeyOf(event: { id?: string; at: string; tool: string }): string {
  return event.id ? `id:${event.id}` : `${event.at}|${event.tool}`;
}

function truncateActivityField(text: string, kind: ActivitySubjectKind | undefined, width: number): string {
  const plain = inlineText(text);
  return kind === "path" ? truncateVisualTail(plain, width) : truncateVisual(plain, width);
}

function activityHeadlineBody(event: TuiSnapshot["events"][number], width: number): string {
  if (width <= 0) return "";
  const subject = inlineText(event.subject ?? event.message);
  const qualifier = inlineText(event.qualifier ?? "");
  const failure = inlineText(event.failure ?? "");
  const sep = " · ";
  const sepW = visualWidth(sep);

  // Failure is the decision-making fact. On narrow rows it replaces ordinary
  // args entirely; with room, keep a compact subject so the operator still
  // knows which target failed.
  if (failure) {
    if (!subject || width < 28) return truncateVisual(failure, width);
    const failureBudget = Math.min(visualWidth(failure), Math.max(12, Math.floor(width * 0.58)));
    const subjectBudget = width - sepW - failureBudget;
    if (subjectBudget < 6) return truncateVisual(failure, width);
    return `${truncateActivityField(subject, event.subjectKind, subjectBudget)}${sep}${truncateVisual(failure, failureBudget)}`;
  }

  if (!qualifier) return truncateActivityField(subject, event.subjectKind, width);
  const full = `${subject}${sep}${qualifier}`;
  if (visualWidth(full) <= width) return full;
  if (width < 22) return truncateActivityField(subject, event.subjectKind, width);

  // Subject is primary. Qualifiers (scope, range, count) get at most ~1/3 of
  // the row and disappear first when space is tight.
  const qualifierBudget = Math.min(visualWidth(qualifier), Math.max(6, Math.floor(width * 0.34)));
  const subjectBudget = width - sepW - qualifierBudget;
  if (subjectBudget < 8) return truncateActivityField(subject, event.subjectKind, width);
  return `${truncateActivityField(subject, event.subjectKind, subjectBudget)}${sep}${truncateActivityField(qualifier, event.qualifierKind, qualifierBudget)}`;
}

/**
 * One event, exactly one row: time/status/action and duration stay stable while
 * the semantic headline consumes the remaining width. Enter owns full detail.
 */
export function eventListRow(
  event: TuiSnapshot["events"][number],
  width: number,
  spin: number,
  now: number,
  selected = false,
): string {
  const action = inlineText(event.action ?? event.tool);
  // 光标行保持每段自己的色相、只叠加粗体 —— 整行刷成单色会把状态、
  // 工具、时刻的分层全部抹平（默认光标就停在最上面一行上）。
  const bold = selected ? { bold: true } : undefined;
  const icon =
    event.status === "running" ? paint("accent", spinnerFrame(spin), { bold: true })
    : event.status === "completed" ? paint("success", "✓", bold)
    : event.status === "error" ? paint("error", "✕", { bold: true })
    : event.status === "warning" ? paint("review", "⚠", bold)
    : paint("context", "◆", bold);
  const rightText =
    event.status === "running"
      ? `${formatDuration(Math.max(0, now - Date.parse(event.at)))}…`
      : event.durationMs !== undefined
        ? (event.durationMs < 1000 ? `${Math.round(event.durationMs)}ms` : formatDuration(event.durationMs))
        : "";
  const fullClock = formatClock(event.at);
  const clock = width < 50 ? fullClock.slice(0, 5) : fullClock;
  const mark = event.status === "running" ? spinnerFrame(spin)
    : event.status === "completed" ? "✓"
    : event.status === "error" ? "✕"
    : event.status === "warning" ? "⚠"
    : "◆";
  // Wide workbench views name the actual MCP tool instead of squeezing every
  // call into a generic 8-column verb. Keep narrow terminals compact, but give
  // common 15–20 character tool ids enough room when the panel can afford it.
  const actionWidth = width < 56 ? 4 : width < 70 ? 12 : 20;
  const actionCell = padEndVisual(truncateVisual(action, actionWidth), actionWidth);
  const prefixPlain = `${clock} ${mark} ${actionCell} `;
  const prefix = `${paint("dim", clock, bold)} ${icon} ${paint(event.subtle === true ? "dim" : "tool", actionCell, bold)} `;
  const prefixW = visualWidth(prefixPlain);
  // 时长列固定宽：运行中行的时长逐秒变化（9s→10s、59s→1m00s），右侧宽度一变，
  // 正文边界就移动一列，面板底部行因此偶发翻转 —— 操作者看到的是「最后一行
  // 偶尔闪烁」。右列一律右对齐到固定宽，行布局与时长彻底无关。
  const DURATION_W = 7; // 容纳 "59m59s"；正常时长不会更宽，超宽走整行截断。
  const rightW = rightText === "" ? 0 : DURATION_W;
  const rightShown = rightText === "" ? "" : padStartVisual(rightText, DURATION_W);
  const msgWidth = Math.max(1, width - prefixW - (rightW > 0 ? rightW + 1 : 0));
  const shown = activityHeadlineBody(event, msgWidth);
  const bodyTone: ColorName = event.status === "error" ? "error"
    : event.status === "warning" ? "review"
    : selected ? "text"
    : event.subtle === true ? "dim"
    : "muted";
  const left = `${prefix}${shown.length > 0 ? paint(bodyTone, shown, bold) : ""}`;
  const line = rightShown === ""
    ? padEndVisual(left, width)
    : `${padEndVisual(left, Math.max(0, width - rightW))}${paint("dim", rightShown)}`;
  const safe = visualWidth(line) > width ? padEndVisual(truncateVisual(stripAnsi(line), width), width) : padEndVisual(line, width);
  return safe;
}

/** Enter 的目的地：一条事件的全文（record 已在源头截到 500 字符）。 */
export function eventDetailRows(
  snap: TuiSnapshot,
  width: number,
  key: string | undefined,
): string[] {
  const event = snap.events.find(candidate => eventKeyOf(candidate) === key);
  if (key === undefined || event === undefined) return [padEndVisual(paint("dim", "该事件已滚出活动日志"), width)];
  const icon =
    event.status === "running" ? paint("accent", "…", { bold: true })
    : event.status === "completed" ? paint("success", "✓")
    : event.status === "error" ? paint("error", "✕", { bold: true })
    : event.status === "warning" ? paint("review", "⚠")
    : paint("context", "◆");
  const duration = event.durationMs !== undefined ? ` · ${formatDuration(event.durationMs)}` : "";
  const head = `${paint("dim", formatClock(event.at))} ${icon} ${paint("tool", inlineText(event.tool))}${paint("dim", duration)}`;
  const detail = (event.detail !== undefined && event.detail !== "" ? event.detail : event.message).replace(/\r\n?/g, "\n");
  const body = detail.split("\n").flatMap(segment => wrapVisualSoft(segment, Math.max(1, width)));
  return [head, "", ...body.map(segment => paint("muted", segment))].map(line => padEndVisual(line, width));
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
