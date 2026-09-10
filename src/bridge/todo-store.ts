import { host } from "../host/host.js";
import { state } from "./state.js";

export const TODOS_STATE_PREFIX = "openBridge.todos.";

export interface TodoProgressEntry {
  message: string;
  phase?: string;
  percent?: number;
  level: string;
  at: string;
}

export interface TodoStoreSnapshot {
  todos: unknown[];
  lastProgress: TodoProgressEntry | null;
  updatedAt: string;
  sessionId?: string;
}

let persistTail: Promise<void> = Promise.resolve();

export function todoStoreKey(): string {
  return `${TODOS_STATE_PREFIX}${state.activeWorkspaceRoot || "unbound"}`;
}

function cloneTodos(todos: unknown[]): unknown[] {
  return Array.isArray(todos)
    ? todos.map(t => (t !== null && typeof t === "object" ? { ...(t as object) } : t))
    : [];
}

function currentSessionId(): string | undefined {
  if (!state.latestSession) return undefined;
  return [...state.sessions.entries()].find(([, session]) => session === state.latestSession)?.[0] ?? undefined;
}

/**
 * Serialized read-merge-write persistence. Both persistTodos and persistProgress
 * write the SAME per-workspace document; reading at call time and deferring the
 * globalState.update let two calls queued in the same tick (e.g. a parallel
 * batch of set_todos + report_progress) clobber each other's fields with stale
 * values. Reading inside the serialized tail makes every write merge with the
 * latest persisted state instead.
 */
function enqueueTodoWrite(build: (current: TodoStoreSnapshot) => TodoStoreSnapshot): void {
  const key = todoStoreKey();
  persistTail = persistTail
    .then(async () => {
      const current = loadRawStore(key);
      await host().globalState.update(key, build(current));
    })
    .catch(() => undefined);
}

export function persistTodos(todos: unknown[]): void {
  enqueueTodoWrite(current => ({
    todos: cloneTodos(todos),
    lastProgress: current.lastProgress ?? null,
    updatedAt: new Date().toISOString(),
    sessionId: currentSessionId(),
  }));
}

export function persistProgress(entry: { message: string; phase?: string; percent?: number; level?: string }): void {
  enqueueTodoWrite(current => ({
    todos: current.todos ?? [],
    lastProgress: {
      message: String(entry.message ?? ""),
      phase: entry.phase ? String(entry.phase) : undefined,
      percent: typeof entry.percent === "number" ? entry.percent : undefined,
      level: String(entry.level ?? "info"),
      at: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
    sessionId: current.sessionId,
  }));
}

export function loadRawStore(key?: string): TodoStoreSnapshot {
  const k = key ?? todoStoreKey();
  const defaultSnapshot: TodoStoreSnapshot = {
    todos: [],
    lastProgress: null,
    updatedAt: new Date().toISOString(),
  };
  try {
    const stored = host().globalState.get<TodoStoreSnapshot | null>(k, null);
    if (!stored || typeof stored !== "object" || stored === null) return defaultSnapshot;
    return {
      todos: Array.isArray(stored.todos) ? stored.todos : [],
      lastProgress: (stored.lastProgress && typeof stored.lastProgress === "object" && stored.lastProgress !== null) ? stored.lastProgress : null,
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : new Date().toISOString(),
      sessionId: typeof stored.sessionId === "string" ? stored.sessionId : undefined,
    };
  } catch {
    return defaultSnapshot;
  }
}

export function loadTodoStore(): TodoStoreSnapshot {
  return loadRawStore();
}
