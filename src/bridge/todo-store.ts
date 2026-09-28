import { host } from "../host/host.js";
import { state } from "./state.js";
import {
  isProgressCategory,
  isProgressPhase,
  normalizeLevel,
  type ProgressCategory,
  type ProgressLevel,
  type ProgressPhase,
} from "./tools/progress-vocabulary.js";

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
/**
 * One in-memory copy for the ACTIVE workspace. The TUI repaints every 500 ms,
 * so reading the persisted state store on each frame would turn a presentation
 * concern into continuous IO. The cache is replaced after a successful write
 * and whenever loadTodoStore() establishes a new active-workspace snapshot.
 */
let cachedStore: { key: string; snapshot: TodoStoreSnapshot } | undefined;

function cloneProgress(progress: TodoProgressEntry | null): TodoProgressEntry | null {
  return progress === null ? null : { ...progress };
}

function cacheStore(key: string, snapshot: TodoStoreSnapshot): void {
  cachedStore = {
    key,
    snapshot: {
      todos: cloneTodos(snapshot.todos),
      lastProgress: cloneProgress(snapshot.lastProgress),
      updatedAt: snapshot.updatedAt,
      ...(snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
    },
  };
}

/** The TUI reads this instead of re-reading the store every 500 ms tick. */
export function todoFreshness(): string | undefined {
  const key = todoStoreKey();
  return cachedStore?.key === key ? cachedStore.snapshot.updatedAt : undefined;
}

/** Latest persisted report_progress for the active workspace, with no IO. */
export function todoProgress(): TodoProgressEntry | null {
  const key = todoStoreKey();
  return cachedStore?.key === key ? cloneProgress(cachedStore.snapshot.lastProgress) : null;
}

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
      const built = build(current);
      await host().state.update(key, built);
      cacheStore(key, built);
    })
    .catch(() => undefined);
}

/**
 * 盖完成时间戳：上一份清单里没完成、这一份完成的条目标上 completedAt；
 * 已完成的保持原时间戳（幂等——三路消费方各自调用也不会漂移），回到
 * 未完成则摘除。session.todos（控制台）、state.todos（TUI）与持久文档
 * 共用这一个纯函数，显示层永远与存储层说同一套时间。
 */
export function applyCompletionTimes(
  previous: unknown[],
  next: Array<{ id: string; title: string; status: string }>,
  nowIso: string = new Date().toISOString(),
): Array<{ id: string; title: string; status: string; completedAt?: string }> {
  const priorStatus = new Map<string, string>();
  const priorStamp = new Map<string, string>();
  for (const item of previous) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { id?: unknown; status?: unknown; completedAt?: unknown };
    if (typeof record.id !== "string") continue;
    if (typeof record.status === "string") priorStatus.set(record.id, record.status);
    if (record.status === "completed" && typeof record.completedAt === "string") {
      priorStamp.set(record.id, record.completedAt);
    }
  }
  return next.map(item => {
    if (item.status === "completed") {
      const existing = (item as { completedAt?: unknown }).completedAt;
      const kept = priorStatus.get(item.id) === "completed" ? priorStamp.get(item.id) : undefined;
      return { ...item, completedAt: typeof existing === "string" ? existing : kept ?? nowIso };
    }
    const { completedAt: _dropped, ...rest } = item as { completedAt?: unknown };
    return rest as typeof item;
  });
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
  const key = todoStoreKey();
  const snapshot = loadRawStore(key);
  // 启动加载把文档里的历史 updatedAt / lastProgress 接进内存视图：重启后
  // TUI 仍然知道这份清单和最近一次进度是什么时候写下的。
  cacheStore(key, snapshot);
  return snapshot;
}
