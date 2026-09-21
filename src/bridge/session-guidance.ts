/**
 * What to say when a legacy-era request arrives without a usable session.
 *
 * The 2025-era path is stateful: `initialize` mints a session id and every later
 * request must carry it back. When one does not, the transport answers a single
 * opaque refusal — `400 -32000 "Bad Request: Server not initialized"` — for two
 * situations whose fixes are not the same thing:
 *
 *  - the client never handshook (send `initialize` first), and
 *  - the client handshook against a session that no longer exists: the Bridge
 *    id was never issued, idle-expired, or belongs to a different workspace
 *    (send `initialize` again). A restart of the same Bridge does not 404 an id
 *    it issued: the ticket is persisted and the transport is rebuilt on arrival.
 *
 * From the outside those are the same three words, and the natural reading of
 * them is "this endpoint is broken" — the one conclusion that leads nowhere.
 * Found the hard way: an agent burned a whole probe round concluding the server
 * was misconfigured, while the same server was happily serving modern-era
 * requests two lines of code away.
 *
 * So each case gets its own status, its own code and a `data.reason` a client can
 * branch on. The never-handshook case keeps the transport's own status and code
 * (400 / -32000) so anything already keying on them keeps working; the dead-id
 * case answers 404, which is what the specification asks for when a session id is
 * unknown. Two failures that finally look different from the outside.
 *
 * Not handled here, deliberately: `initialize` itself. It is the way out of both
 * problems, and the transport already does the tolerant thing — an id it does not
 * recognise is ignored rather than refused, so a reconnecting client gets a fresh
 * session instead of an error about the one it lost.
 */

/** The two ways a legacy-era request can arrive without a live session. */
export type LegacySessionReason = "initialize-required" | "session-expired";

export interface LegacySessionProblem {
  /** 400 for "handshake first", 404 for "that session is gone". */
  status: 400 | 404;
  /** -32000 keeps the transport's existing meaning; -32001 is only ever this one. */
  code: -32000 | -32001;
  reason: LegacySessionReason;
  /** What is wrong, in one sentence. */
  message: string;
  /** The next request to make. */
  hint: string;
}

/**
 * The guidance for one inbound legacy request, or `undefined` when there is
 * nothing to say — which is every ordinary request on a live session.
 */
export function legacySessionProblem(input: {
  /** The JSON-RPC method, when the request has a readable one. */
  method?: string;
  /** Whether the request carried a non-empty `mcp-session-id` header. */
  hasSessionId: boolean;
  /** Whether that id (if any) resolves to a live session. */
  known: boolean;
}): LegacySessionProblem | undefined {
  if (input.method === "initialize") return undefined;
  if (input.known) return undefined;

  if (input.hasSessionId) {
    return {
      status: 404,
      code: -32001,
      reason: "session-expired",
      message: "This request's mcp-session-id is not a live session on this Bridge.",
      hint: "This session id was never issued by this Bridge, or it idle-expired. "
        + "Send initialize to get a new id, then repeat this request with it. "
        + "A restart does not drop an id this Bridge issued: retry the same id first.",
    };
  }
  return {
    status: 400,
    code: -32000,
    reason: "initialize-required",
    message: "No mcp-session-id header: the 2025-era protocol path needs an initialize handshake "
      + "before any other request.",
    hint: "POST initialize first and keep the mcp-session-id it returns, sending it on every "
      + "later request. (A 2026-07-28-era client needs no handshake: it sends the "
      + "MCP-Protocol-Version / MCP-Method / MCP-Name headers and a per-request params._meta "
      + "envelope instead.)",
  };
}
