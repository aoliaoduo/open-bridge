import { host } from "../../host/host.js";
import { applyCompletionTimes, persistTodos } from "../todo-store.js";
import { state, type SessionState } from "../state.js";
import type { JsonArgs } from "./json-args.js";

/** Same cap advertised by the set_todos schema. */
const MAX_TODOS = 100;

/** Replace the current session/workspace todo list and durably persist it. */
export async function setTodos(args: JsonArgs, session?: SessionState): Promise<unknown[]> {
  const next = validateTodos(args.todos);
  const enriched = applyCompletionTimes(state.todos, next);
  const previousStateTodos = state.todos;
  const previousSessionTodos = session?.todos;
  const previousLatestSession = state.latestSession;

  if (session) {
    session.todos = enriched;
    state.latestSession = session;
  }
  state.todos = [...enriched];

  try {
    await persistTodos(enriched);
  } catch (error) {
    state.todos = previousStateTodos;
    if (session && previousSessionTodos) session.todos = previousSessionTodos;
    state.latestSession = previousLatestSession;
    host().ui.update();
    throw new Error(
      `Todos were not saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  host().ui.update();
  return next;
}

/** Strict runtime validation for the write-only set_todos tool. */
function validateTodos(value: unknown): Array<{ id: string; title: string; status: string }> {
  if (!Array.isArray(value)) {
    throw new Error(
      "todos must be an array. (expected 'todos': object[]) "
      + "set_todos replaces the whole list; use get_todos to read the current one.",
    );
  }
  if (value.length > MAX_TODOS) {
    throw new Error(`todos must contain at most ${MAX_TODOS} items (received ${value.length}).`);
  }

  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Todo ${index + 1} must be an object.`);
    }
    const todo = item as Record<string, unknown>;
    const id = String(todo.id ?? "").trim();
    const title = String(todo.title ?? "").trim();
    const status = String(todo.status ?? "");
    if (!id || !title || !["pending", "in_progress", "completed"].includes(status)) {
      const missing = [!id && "id", !title && "title"].filter(Boolean).join(", ");
      const detail = missing
        ? `missing ${missing}`
        : `status must be pending, in_progress or completed (got ${JSON.stringify(status)})`;
      throw new Error(`Todo ${index + 1}: ${detail}. (expected 'todos[i]': object)`);
    }
    if (seen.has(id)) throw new Error(`Duplicate todo id: ${id}`);
    seen.add(id);
    return { id, title, status };
  });
}
