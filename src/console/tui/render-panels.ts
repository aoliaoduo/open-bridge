/** Task/change/diff panel content; frame composition stays in render.ts. */
import { paint, spinnerFrame, type ColorName } from "./theme.js";
import { inlineText, padEndVisual, padStartVisual, stripAnsi, truncateVisual, visualWidth, wrapVisual } from "./text.js";
import { formatClock, formatCount, formatDatedClock } from "./render-format.js";
import type { TuiSnapshot } from "./render-model.js";

const PROGRESS_PHASE_LABELS = {
  queued: "排队",
  preparing: "准备",
  running: "进行",
  verifying: "验证",
  done: "完成",
} as const;
const PROGRESS_CATEGORY_LABELS = {
  read: "读取",
  edit: "编辑",
  command: "命令",
  test: "测试",
  build: "构建",
  other: "其他",
} as const;

function progressPanelRows(snap: TuiSnapshot, width: number, now: number): string[] {
  const progress = snap.progress;
  if (progress === undefined) return [];
  const tone: ColorName = progress.level === "error" ? "error"
    : progress.level === "warning" ? "review"
    : progress.phase === "done" ? "success"
    : "accent";
  const percent = typeof progress.percent === "number" && Number.isFinite(progress.percent)
    ? `${Math.round(progress.percent * 10) / 10}%`
    : undefined;
  const meta = [
    progress.phase ? PROGRESS_PHASE_LABELS[progress.phase] : undefined,
    progress.category ? PROGRESS_CATEGORY_LABELS[progress.category] : undefined,
    percent,
    formatDatedClock(String(progress.at ?? ""), now),
  ].filter((part): part is string => part !== undefined);
  const label = "◆ 最新进度";
  const labelWidth = Math.min(width, visualWidth(label));
  const heading = `${paint(tone, truncateVisual(label, labelWidth), { bold: true })}${
    width > labelWidth && meta.length
      ? paint("dim", truncateVisual(` · ${meta.join(" · ")}`, width - labelWidth))
      : ""
  }`;
  const rows = [heading];
  const bodyWidth = Math.max(1, width - 2);
  const messageRows = stripAnsi(String(progress.message ?? "")).replace(/\r\n?/g, "\n").split("\n")
    .flatMap(line => wrapVisual(inlineText(line.replace(/\t/g, "    ")), bodyWidth));
  for (const line of messageRows.length ? messageRows : [""]) {
    rows.push(`${paint("dim", "  ")}${paint("text", line)}`);
  }
  rows.push("");
  return rows;
}

/** Task titles wrap with a measured icon gutter, including in CJK terminals. */
export function taskPanelRows(snap: TuiSnapshot, width: number, spin: number, now: number): string[] {
  const rows = progressPanelRows(snap, width, now);
  if (snap.todos.length === 0) {
    rows.push(paint("dim", "暂无任务"));
    return rows;
  }
  const hasProgress = rows.length > 0;
  const gutter = Math.max(visualWidth("✓"), visualWidth("·"), visualWidth(spinnerFrame(spin))) + 1;
  for (const todo of snap.todos) {
    const isCurrent = todo.status === "in_progress";
    const mark = todo.status === "completed" ? paint("success", "✓")
      : isCurrent ? paint("accent", spinnerFrame(spin), { bold: true })
      : paint("dim", "·");
    // 完成 → muted（内容略亮于背景）、时钟 dim（元数据退后）：同一行里
    // 两种灰阶一眼可分；进行中保持 text 加粗、待办保持 dim。
    const titleColor: ColorName = isCurrent ? "text" : todo.status === "completed" ? "muted" : "dim";
    // 完成时刻固定右列（formatClock 定宽），正文换行边界与时间无关 ——
    // 与活动行时长列同一个防闪烁约定。
    const stamp = todo.status === "completed" && todo.completedAt !== undefined ? formatClock(todo.completedAt) : "";
    // 时钟右缘抵面板右缘，与标题栏「更新 HH:MM:SS」的时间同列 —— 标题栏的
    // 时间没有尾随空隙，行内的也不该有（此前 +1 让行内时钟缩进了一列）。
    const stampCols = stamp === "" ? 0 : visualWidth(stamp);
    // 长标题撑满换行预算时，padEnd 的间隔会归零、时钟直接贴住正文 ——
    // 完成行的换行预算再让出 2 列，保证时钟与标题之间至少两条空隙。
    const stampGap = stampCols > 0 ? 2 : 0;
    // A title may contain real line breaks. They must become viewport rows,
    // never embedded terminal newlines that escape the frame's height budget.
    const wrapped = stripAnsi(todo.title).replace(/\r\n?/g, "\n").split("\n")
      .flatMap(line => wrapVisual(inlineText(line.replace(/\t/g, "    ")), Math.max(1, width - gutter - stampCols - stampGap)));
    wrapped.forEach((line, index) => {
      const body = `${index === 0 ? padEndVisual(mark, gutter) : " ".repeat(gutter)}${paint(titleColor, line, { bold: isCurrent })}`;
      if (index === 0 && stamp !== "") {
        rows.push(`${padEndVisual(body, Math.max(0, width - stampCols))}${paint("dim", stamp)}`);
      } else {
        rows.push(padEndVisual(body, width));
      }
    });
    rows.push("");
  }
  rows.pop(); // no trailing spacer: End must land on the final task's text
  // progressPanelRows already contributes one separator. Keep exactly that one
  // so the latest report reads as context for the list, not as another todo.
  if (hasProgress && rows[rows.length - 1] === "") rows.pop();
  return rows;
}


/** Per-file +/- list for the Tab 「变更」 page: one selectable file per row. */
export function changePanelRows(snap: TuiSnapshot, width: number, cursor = 0): string[] {
  if (snap.changes.status === "loading") return [paint("dim", "正在读取变更…")];
  if (snap.changes.status === "not-git") return [paint("dim", "非 git")];
  if (snap.changes.status === "unavailable") return [paint("dim", "读取失败")];
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
    const selected = index === cursor;
    const bold = selected ? { bold: true } : undefined;
    const shown = truncateVisual(path, pathWidth);
    const counts = entry.binary
      ? padEndVisual(paint("dim", "二进制", bold), gutter)
      : `${paint("success", padStartVisual(addTexts[index] ?? "", addW), bold)} ${delTexts[index] ? paint("error", padStartVisual(delTexts[index] ?? "", delW), bold) : " ".repeat(delW)} `;
    const tag = entry.untracked && visualWidth(shown) + visualWidth(" 未跟踪") <= pathWidth ? paint("dim", " 未跟踪", bold) : "";
    rows.push(`${counts}${paint("text", shown, bold)}${tag}`);
  }
  return rows;
}

/** Diff preview: cumulative review or one selected working-tree file. */
export function diffPanelRows(snap: TuiSnapshot, width: number): string[] {
  const diff = snap.diff;
  const fileDiff = diff?.kind === "file";
  if (diff === undefined || diff.loading) return [paint("dim", `正在读取${fileDiff ? "文件" : "累计"} diff…`)];
  if (!diff.ok) return [paint("dim", truncateVisual(diff.reason || "读取失败", width))];
  if (diff.text === "") {
    if (fileDiff) return [paint("dim", "该文件当前没有可显示的工作树 diff")];
    return [paint("dim", diff.checkpoint === "established"
      ? "已建立审阅基线；出现新改动后再按 d 刷新"
      : "自上次审阅以来没有改动")];
  }
  const summary = fileDiff
    ? `文件 diff · ${inlineText(diff.path ?? "")}${diff.truncated ? " · 已截断" : ""}`
    : `累计 diff · 自 ${diff.since}${diff.truncated ? " · 已截断" : ""}`;
  const rows = [paint("dim", truncateVisual(summary, width))];
  for (const raw of diff.text.split("\n")) {
    const line = inlineText(raw.replace(/\t/g, "    "));
    if (line.startsWith("+")) rows.push(paint("success", truncateVisual(line, width)));
    else if (line.startsWith("-")) rows.push(paint("error", truncateVisual(line, width)));
    else if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) rows.push(paint("dim", truncateVisual(line, width)));
    else rows.push(paint("text", truncateVisual(line, width)));
  }
  return rows;
}
