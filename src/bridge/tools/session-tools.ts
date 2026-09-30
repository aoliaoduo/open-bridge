import { sessionActivityViews } from "../sessions/session-views.js";

/**
 * "Who is connected?" — both MCP eras, in one answer.
 *
 * Legacy rows own real transports and can be closed. The modern stateless era
 * has no transport/session id, so it is represented explicitly as non-closable
 * instead of disappearing from the operator's view.
 */
export function listSessions(): unknown {
  return sessionActivityViews().map(row => row.stateless
    ? {
        session_id: row.id,
        era: row.era,
        stateless: true,
        closable: false,
        connected_at: null,
        first_seen: row.firstSeen,
        last_used: row.lastUsed,
        in_flight: row.inFlight,
      }
    : {
        session_id: row.id,
        era: row.era,
        stateless: false,
        closable: true,
        connected_at: row.connectedAt,
        last_used: row.lastUsed,
        calls: row.calls,
        todo_count: row.todoCount,
      });
}
