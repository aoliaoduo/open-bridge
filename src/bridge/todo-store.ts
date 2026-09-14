import { host } from "../host/host.js";
import { state } from "./state.js";
import {
  isProgressCategory,
  isProgressPhase,
  normalizeLevel,
  type ProgressCategory,
  type ProgressLevel,
  type ProgressPhase,
} from "./progress-vocabulary.js";

const TODOS_STATE_PREFIX = "openBridge.todos.";

/**
 * One progress report. `phase` and `category` are typed as members of the
 * closed vocabulary in `progress-vocabulary.ts` rather than `string`, so a
 * caller cannot persist an arbitrary value even by accident.
 */
export interface TodoProgressEntry {
  message: string;
  phase?: ProgressPhase;
  category?: ProgressCategory;
  percent?: number;
  level: ProgressLevel;
  at: string;
  /**
   * Which session said this. The document-level `sessionId` cannot answer that
   * question — it belongs to whoever last wrote the TODOS, and the two halves
   * of this document are written by different tools at different times. A
   * report kept from a previous agent would otherwise sit under a fresh list
   * looking like live progress, which is exactly what it is not.
   *
   * Absent on entries written before this field existed; the console treats
   * that as "not from the current session", which is definitionally true.
   */
  sessionId?: string;
}

export interface TodoStoreSnapshot {
  todos: unknown[];
  lastProgress: TodoProgressEntry | null;
  updatedAt: string;
  sessionId?: string;
}

let persistTail: Promise<void> = Promise.resolve();

function todoStoreKey(): string {
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
 * state.update let two calls queued in the same tick (e.g. a parallel
 * batch of set_todos + report_progress) clobber each other's fields with stale
 * values. Reading inside the serialized tail makes every write merge with the
 * latest persisted state instead.
 */
function enqueueTodoWrite(build: (current: TodoStoreSnapshot) => TodoStoreSnapshot): void {
  const key = todoStoreKey();
  persistTail = persistTail
    .then(async () => {
      const current = loadRawStore(key);
      await host().state.update(key, build(current));
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

export function persistProgress(entry: {
  message: string;
  phase?: ProgressPhase;
  category?: ProgressCategory;
  percent?: number;
  level?: ProgressLevel;
}): void {
  enqueueTodoWrite(current => ({
    todos: current.todos ?? [],
    lastProgress: {
      message: String(entry.message ?? ""),
      // Re-check membership on the way in: the types are erased at runtime and
      // this document is also read back from disk, so an out-of-vocabulary value
      // must not be persisted even if a caller bypassed the type.
      ...(isProgressPhase(entry.phase) ? { phase: entry.phase } : {}),
      ...(isProgressCategory(entry.category) ? { category: entry.category } : {}),
      percent: typeof entry.percent === "number" ? entry.percent : undefined,
      level: normalizeLevel(entry.level),
      at: new Date().toISOString(),
      // Stamped from the session that is reporting, not from the document:
      // this is the claim "an agent that is still connected said this".
      ...(currentSessionId() ? { sessionId: currentSessionId() } : {}),
    },
    updatedAt: new Date().toISOString(),
    sessionId: current.sessionId,
  }));
}

function loadRawStore(key?: string): TodoStoreSnapshot {
  const k = key ?? todoStoreKey();
  const defaultSnapshot: TodoStoreSnapshot = {
    todos: [],
    lastProgress: null,
    updatedAt: new Date().toISOString(),
  };
  try {
    const stored = host().state.get<TodoStoreSnapshot | null>(k, null);
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
