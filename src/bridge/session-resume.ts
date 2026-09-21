/**
 * Rebuild a 2025-era MCP session under a previously issued id.
 *
 * The SDK transport is in-memory and has no public resume hook: `initialize`
 * is what sets `_initialized` and `sessionId` on the inner web transport.
 * After a restart those objects are gone but the ticket is not, so we construct
 * a fresh transport, stamp it as already initialized, and bind a new MCP
 * server. Never-issued ids still 404. An explicit HTTP DELETE drops the ticket.
 */
import { randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { host } from "../host/host.js";
import { createMcp, sharedEventStore } from "./mcp-endpoint.js";
import { loadTodoStore } from "./todo-store.js";
import { makeRoomForSession, pruneSessions } from "./session-table.js";
import {
  flushSessionTickets,
  forgetSessionTicket,
  hasLiveSessionTicket,
  rememberSessionTicket,
  sessionTicket,
  touchSessionTicket,
} from "./session-store.js";
import { state, type SessionState } from "./state.js";

type InnerTransport = {
  sessionId?: string;
  _initialized?: boolean;
};

export function markTransportInitialized(
  transport: StreamableHTTPServerTransport,
  sessionId: string,
): void {
  const inner = (transport as unknown as { _webStandardTransport?: InnerTransport })._webStandardTransport;
  if (!inner) {
    throw new Error("Streamable HTTP transport has no inner web transport to resume");
  }
  inner.sessionId = sessionId;
  inner._initialized = true;
}

export function mintSessionId(): string {
  return randomBytes(16).toString("hex");
}

function bindTransportLifecycle(transport: StreamableHTTPServerTransport): void {
  transport.onclose = () => {
    const id = transport.sessionId;
    if (!id) return;
    state.sessions.delete(id);
    host().ui.update();
  };
}

function newSessionState(transport: StreamableHTTPServerTransport, client?: string): SessionState {
  const persisted = loadTodoStore();
  const persistedTodos = Array.isArray(persisted.todos)
    ? persisted.todos.map(t => (t !== null && typeof t === "object" ? { ...t as object } : t))
    : [];
  return {
    transport,
    lastUsed: Date.now(),
    connectedAt: Date.now(),
    calls: 0,
    client,
    todos: persistedTodos,
    activeRequests: 0,
  };
}

function attachMcp(session: SessionState): Promise<void> {
  const mcpServer = createMcp(session);
  session.mcp = mcpServer as unknown as NonNullable<SessionState["mcp"]>;
  return mcpServer.connect(session.transport);
}

export async function openLegacySession(input: {
  allowedHosts: string[];
  clientLabel?: string;
  resumeId?: string;
}): Promise<SessionState | undefined> {
  const resumeId = input.resumeId;
  if (resumeId) {
    if (!hasLiveSessionTicket(resumeId)) return undefined;
    const existing = state.sessions.get(resumeId);
    if (existing) return existing;
  }
  if (!makeRoomForSession()) return undefined;

  const slot: { session?: SessionState } = {};
  const sessionIdGenerator = resumeId ? () => resumeId : mintSessionId;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator,
    enableDnsRebindingProtection: true,
    allowedHosts: input.allowedHosts,
    eventStore: sharedEventStore,
    keepAliveMs: 15_000,
    retryInterval: 2_000,
    onsessioninitialized: async id => {
      state.sessions.set(id, slot.session!);
      rememberSessionTicket(id, input.clientLabel);
      await flushSessionTickets();
      pruneSessions();
      host().ui.update();
    },
    onsessionclosed: id => {
      state.sessions.delete(id);
      forgetSessionTicket(id);
      host().ui.update();
    },
  });
  bindTransportLifecycle(transport);
  const session = newSessionState(transport, input.clientLabel ?? (resumeId ? sessionTicket(resumeId)?.client : undefined));
  slot.session = session;
  if (resumeId) {
    markTransportInitialized(transport, resumeId);
    state.sessions.set(resumeId, session);
    rememberSessionTicket(resumeId, session.client);
    await flushSessionTickets();
  }
  await attachMcp(session);
  return session;
}

export async function resumeLegacySession(sessionId: string, allowedHosts: string[]): Promise<SessionState | undefined> {
  const ticket = sessionTicket(sessionId);
  const session = await openLegacySession({
    allowedHosts,
    clientLabel: ticket?.client,
    resumeId: sessionId,
  });
  if (session) touchSessionTicket(sessionId);
  return session;
}
