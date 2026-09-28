import { state } from "../state.js";

export interface SessionActivityView {
  id: string;
  client: string;
  era: "legacy" | "modern";
  stateless: boolean;
  closable: boolean;
  connectedAt: string | null;
  firstSeen?: string;
  lastUsed: string;
  calls: number | null;
  todoCount: number | null;
  inFlight: number;
  idleMs: number;
}

/**
 * Canonical internal projection of both protocol eras.
 *
 * It intentionally does not choose a public wire shape. MCP and the console
 * expose different field names and slightly different subsets, but they must
 * agree on the underlying facts (timestamps, busy count, closeability and
 * whether modern traffic is a session at all).
 */
export function sessionActivityViews(now = Date.now()): SessionActivityView[] {
  const legacy = [...state.sessions.entries()].map(([id, session]): SessionActivityView => ({
    id,
    client: session.client ?? "未标识客户端",
    era: "legacy",
    stateless: false,
    closable: true,
    connectedAt: new Date(session.connectedAt ?? session.lastUsed).toISOString(),
    lastUsed: new Date(session.lastUsed).toISOString(),
    calls: session.calls ?? 0,
    todoCount: Array.isArray(session.todos) ? session.todos.length : 0,
    inFlight: session.activeRequests,
    idleMs: Math.max(0, now - session.lastUsed),
  }));

  if (state.modernLastUsed <= 0) return legacy;
  return [...legacy, {
    id: "modern",
    client: "Modern MCP (stateless)",
    era: "modern",
    stateless: true,
    closable: false,
    connectedAt: null,
    firstSeen: new Date(state.modernSince || state.modernLastUsed).toISOString(),
    lastUsed: new Date(state.modernLastUsed).toISOString(),
    calls: null,
    todoCount: null,
    inFlight: state.modernInFlight,
    idleMs: Math.max(0, now - state.modernLastUsed),
  }];
}
