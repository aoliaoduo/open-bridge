import { useCallback, useEffect, useRef, useState } from "react";
import { api, type TodoBoard, type TodoItem } from "../api";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/**
 * 任务 — the checklist the connected AI is working through.
 *
 * The data existed from the day `set_todos` shipped, but the console only ever
 * showed `todos: <number>` in one column of the 会话 table. An operator could
 * see that an agent was busy and never what it was busy with; the plan was
 * visible to the AI and to the phone push, but not on the one screen a human
 * actually watches. This page is that missing view.
 *
 * It is read-only on purpose. The list is the agent's working memory — a
 * console that let a human tick items off would be writing to the other side's
 * plan mid-run, and the two would silently disagree about what was done.
 */

/** Getter per status so the labels re-read the active language on each render. */
const STATUS_LABEL: Record<string, () => string> = {
  completed: () => t("已完成", "Done"),
  in_progress: () => t("进行中", "In progress"),
  pending: () => t("待办", "To do"),
};

function tone(status: string): "ok" | "accent" | "idle" {
  if (status === "completed") return "ok";
  if (status === "in_progress") return "accent";
  return "idle";
}

/** "3 分钟前" beats an ISO string for a value that is only ever read as "how long ago". */
function ago(iso: string | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return t(`${seconds} 秒前`, `${seconds}s ago`);
  if (seconds < 3600) return t(`${Math.round(seconds / 60)} 分钟前`, `${Math.round(seconds / 60)}m ago`);
  if (seconds < 86400) return t(`${Math.round(seconds / 3600)} 小时前`, `${Math.round(seconds / 3600)}h ago`);
  return t(`${Math.round(seconds / 86400)} 天前`, `${Math.round(seconds / 86400)}d ago`);
}

function TodoRow({ todo, index }: { todo: TodoItem; index: number }) {
  const done = todo.status === "completed";
  const active = todo.status === "in_progress";
  return (
    <li className={`todo-row ${todo.status}`}>
      <span className="todo-mark" aria-hidden="true">
        {done ? (
          <svg viewBox="0 0 24 24" fill="none" className="todo-icon">
            <path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : active ? (
          <svg viewBox="0 0 24 24" fill="none" className="todo-icon spin">
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round" strokeDasharray="40 14" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" className="todo-icon">
            <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        )}
      </span>
      <span className="todo-index">{index + 1}</span>
      <span className="todo-title">{todo.title}</span>
      <Chip tone={tone(todo.status)}>{STATUS_LABEL[todo.status]?.() ?? todo.status}</Chip>
    </li>
  );
}

export function TodosPage() {
  const [board, setBoard] = useState<TodoBoard | null>(null);
  const [note, setNote] = useState("");
  // Same expired-response guard the other polling pages use: a slow request
  // that left before a refresh must not overwrite the newer answer.
  const pollSeq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++pollSeq.current;
    try {
      const next = await api.todos();
      if (pollSeq.current === mine) {
        setBoard(next);
        setNote("");
      }
    } catch (error) {
      if (pollSeq.current === mine) setNote(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 2s: fast enough that a watched agent feels live, slow enough to be free.
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!board) {
    return (
      <Card title={t("任务清单", "Task list")} desc={t("AI 通过 set_todos 写入的计划", "The plan the AI wrote with set_todos")}>
        {note ? <p className="muted">{note}</p> : <Skeleton lines={4} />}
      </Card>
    );
  }

  const { counts, todos } = board;
  const percent = counts.total > 0 ? Math.round((counts.completed / counts.total) * 100) : 0;
  const current = todos.find(todo => todo.status === "in_progress");

  return (
    <>
      <Card
        title={t("任务清单", "Task list")}
        desc={t(
          "AI 通过 set_todos 写入的计划；本页只读，勾选由 AI 那边推进",
          "The plan the AI wrote with set_todos. Read-only here — the AI ticks the boxes.",
        )}
        actions={
          board.stale
            ? (
              <Chip
                tone="warn"
                title={t(
                  "没有会话在驱动这份清单，它是上一个 AI 断开时留下的",
                  "No session is driving this list; it was left behind when the last AI disconnected",
                )}
              >
                {t("已离线", "Stale")}
              </Chip>
            )
            : <Chip tone="ok">{t("实时", "Live")}</Chip>
        }
      >
        {counts.total === 0 ? (
          <EmptyState title={t("还没有任务", "No tasks yet")}>
            {t("连上来的 AI 调用 ", "Once a connected AI calls ")}
            <code>set_todos</code>
            {t("后，它的计划会实时出现在这里。", ", its plan appears here live.")}
          </EmptyState>
        ) : (
          <>
            <div className="todo-summary">
              <div className="todo-bar" role="progressbar" aria-valuenow={percent}
                aria-valuemin={0} aria-valuemax={100}>
                <div className="todo-bar-fill" style={{ width: `${percent}%` }} />
              </div>
              <div className="todo-legend">
                <strong>{counts.completed}/{counts.total}</strong>
                <span className="muted">{t(`已完成 ${percent}%`, `${percent}% done`)}</span>
                {counts.in_progress > 0
                  && <Chip tone="accent">{t(`进行中 ${counts.in_progress}`, `${counts.in_progress} in progress`)}</Chip>}
                {counts.pending > 0
                  && <Chip tone="idle">{t(`待办 ${counts.pending}`, `${counts.pending} to do`)}</Chip>}
              </div>
            </div>

            {current && (
              <p className="todo-current">
                {t("正在做：", "Working on: ")}<strong>{current.title}</strong>
              </p>
            )}

            <ul className="todo-list">
              {todos.map((todo, index) => <TodoRow key={todo.id} todo={todo} index={index} />)}
            </ul>

            <p className="muted todo-foot">
              {t("更新于 ", "Updated ")}{ago(board.updated_at) || t("刚刚", "just now")}
              {board.idle_ms !== null && board.idle_ms > 60_000
                && t(
                  ` · 该会话已空闲 ${Math.round(board.idle_ms / 60_000)} 分钟`,
                  ` · session idle for ${Math.round(board.idle_ms / 60_000)} min`,
                )}
            </p>
          </>
        )}
      </Card>

      {board.last_progress && (
        <Card
          title={t("最新进展", "Latest progress")}
          desc={t("AI 通过 report_progress 报的一行", "The one-liner the AI sent with report_progress")}
        >
          <p className="todo-progress-msg">{board.last_progress.message}</p>
          <p className="muted">
            {board.last_progress.phase && <>{t("阶段 ", "Phase ")}{board.last_progress.phase} · </>}
            {typeof board.last_progress.percent === "number" && <>{board.last_progress.percent}% · </>}
            {ago(board.last_progress.at)}
          </p>
        </Card>
      )}

      {note && <p className="muted">{note}</p>}
    </>
  );
}
