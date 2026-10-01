import { state } from "../../bridge/runtime-state.js";
import { loadTodoStore } from "../../bridge/todo-store.js";
import { sessionActivityViews } from "../../bridge/sessions/session-views.js";

export function sessionViews(): Array<Record<string, unknown>> {
  return sessionActivityViews()
    .map(row => ({
      id: row.id,
      client: row.client,
      era: row.era,
      stateless: row.stateless,
      closable: row.closable,
      connected_at: row.connectedAt,
      ...(row.firstSeen ? { first_seen: row.firstSeen } : {}),
      calls: row.calls,
      last_used: row.lastUsed,
      idle_ms: row.idleMs,
      active_requests: row.inFlight,
      todos: row.todoCount,
    }))
    .sort((a, b) => Date.parse(b.last_used) - Date.parse(a.last_used));
}

interface TodoView {
  id: string;
  title: string;
  status: string;
  completed_at?: string;
}

function asTodo(value: unknown): TodoView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const title = typeof raw.title === "string" ? raw.title : "";
  const status = typeof raw.status === "string" ? raw.status : "";
  if (!id || !title) return undefined;
  const completedAt = typeof raw.completed_at === "string"
    ? raw.completed_at
    : typeof raw.completedAt === "string" ? raw.completedAt : undefined;
  return {
    id,
    title,
    status: ["pending", "in_progress", "completed"].includes(status) ? status : "pending",
    ...(completedAt !== undefined ? { completed_at: completedAt } : {}),
  };
}

/** Console projection of the live todo board, falling back to persisted history. */
export function todoView(): Record<string, unknown> {
  const stored = loadTodoStore();
  const liveEntry = [...state.sessions.entries()].find(([, candidate]) => candidate === state.latestSession);
  const session = liveEntry?.[1];
  const live = Array.isArray(session?.todos) ? session.todos : undefined;
  const source = live !== undefined ? live : stored.todos;
  const todos = (Array.isArray(source) ? source : [])
    .map(asTodo)
    .filter((todo): todo is TodoView => todo !== undefined);
  const counts = { total: todos.length, pending: 0, in_progress: 0, completed: 0 };
  for (const todo of todos) {
    if (todo.status === "completed") counts.completed += 1;
    else if (todo.status === "in_progress") counts.in_progress += 1;
    else counts.pending += 1;
  }
  const liveSessionId = liveEntry?.[0];
  const progressStale = stored.lastProgress
    ? !liveSessionId || stored.lastProgress.sessionId !== liveSessionId
    : false;
  return {
    todos,
    counts,
    stale: live === undefined,
    updated_at: stored.updatedAt,
    last_progress: stored.lastProgress,
    progress_stale: progressStale,
    idle_ms: session ? Math.max(0, Date.now() - session.lastUsed) : null,
  };
}

export function firstLine(text: unknown): string {
  const value = typeof text === "string" ? text : "";
  return value.split("\n")[0]!.trim();
}
