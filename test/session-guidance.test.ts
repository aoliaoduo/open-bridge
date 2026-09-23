/**
 * Two legacy failures that used to be the same response, and why telling them
 * apart is a fix rather than a nicety.
 *
 * The 2025-era path is stateful: `initialize` mints a session id and every later
 * request must carry it. When one does not, the transport answered a single
 * opaque `400 -32000 "Bad Request: Server not initialized"` for both of these:
 *
 *  - never handshook (fix: send `initialize`), and
 *  - handshook against a session that no longer exists — a Bridge restart, an
 *    idle reap, a different instance behind the same URL (fix: send `initialize`
 *    AGAIN; the old id is dead).
 *
 * Seen from the outside those are the same three words, and the natural reading
 * of them is "this endpoint is broken" — the one conclusion that leads nowhere.
 * So each case gets its own status, code and `data.reason`, and the pair stays
 * branchable from a client.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { legacySessionProblem } from "../src/bridge/mcp/session-guidance.js";

test("initialize is never refused: it is the way out of both failures", () => {
  assert.equal(legacySessionProblem({ method: "initialize", hasSessionId: false, known: false }), undefined);
  assert.equal(
    legacySessionProblem({ method: "initialize", hasSessionId: true, known: false }),
    undefined,
    "an id the server does not know is ignored rather than refused, so the handshake still succeeds",
  );
});

test("traffic on a live session is never intercepted", () => {
  assert.equal(legacySessionProblem({ method: "tools/call", hasSessionId: true, known: true }), undefined);
});

test("no session id at all: handshake first, keeping the transport's own status and code", () => {
  const problem = legacySessionProblem({ method: "tools/call", hasSessionId: false, known: false });
  assert.equal(problem?.status, 400, "the status a client already handles for this case");
  assert.equal(problem?.code, -32000, "the code a client may already key on");
  assert.equal(problem?.reason, "initialize-required");
  assert.match(problem!.message, /initialize/);
  assert.match(problem!.hint, /mcp-session-id/);
});

test("an id nobody knows: 404, its own code, its own reason", () => {
  const problem = legacySessionProblem({ method: "tools/call", hasSessionId: true, known: false });
  assert.equal(problem?.status, 404, "the specification's answer for an unknown session id");
  assert.equal(problem?.code, -32001, "a code of its own, so a client can branch without parsing prose");
  assert.equal(problem?.reason, "session-expired");
  assert.match(problem!.hint, /initialize/);
});

test("the two failures are finally distinguishable", () => {
  const missing = legacySessionProblem({ method: "tools/call", hasSessionId: false, known: false })!;
  const expired = legacySessionProblem({ method: "tools/call", hasSessionId: true, known: false })!;
  assert.notEqual(missing.status, expired.status, "different statuses");
  assert.notEqual(missing.code, expired.code, "different codes");
  assert.notEqual(missing.reason, expired.reason, "different reasons");
});

test("a request without a method (GET, the SSE listen stream) is guided the same way", () => {
  assert.equal(legacySessionProblem({ hasSessionId: false, known: false })?.reason, "initialize-required");
  assert.equal(legacySessionProblem({ hasSessionId: true, known: false })?.reason, "session-expired");
});
