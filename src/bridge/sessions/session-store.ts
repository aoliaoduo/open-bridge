/**
 * Durable tickets for 2025-era MCP sessions.
 *
 * The SDK transport is in-memory: a restart, a capacity eviction or a closed
 * socket drops the live object. The ticket is the claim "this Bridge issued
 * that id" so the next request can rebuild the transport under the same id
 * instead of 404-ing a client that did nothing wrong. Never-issued ids still
 * 404. Idle tickets expire on the same clock as the in-memory table.
 *
 * Tickets survive process shutdown (transport.onclose) and do not survive an
 * explicit HTTP DELETE (onsessionclosed) or the idle sweep.
 */
import { host } from "../../host/host.js";
import { state } from "../state.js";

/** Idle MCP sessions (memory and tickets) expire after this long without activity. */
export const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

const TICKETS_PREFIX = "openBridge.sessions.";

export type SessionTicket = {
  id: string;
  client?: string;
  createdAt: number;
  lastUsed: number;
};

type TicketDoc = { tickets: SessionTicket[] };

let cache: Map<string, SessionTicket> | undefined;
let persistTail: Promise<void> = Promise.resolve();

function docKey(): string {
  return `${TICKETS_PREFIX}${state.activeWorkspaceRoot || "unbound"}`;
}

function hydrate(): Map<string, SessionTicket> {
  if (cache) return cache;
  const next = new Map<string, SessionTicket>();
  const raw = host().state.get<TicketDoc | undefined>(docKey(), undefined);
  const list = Array.isArray(raw?.tickets) ? raw.tickets : [];
  const cutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;
    const lastUsed = typeof item.lastUsed === "number" ? item.lastUsed : 0;
    if (lastUsed < cutoff) continue;
    next.set(id, {
      id,
      ...(typeof item.client === "string" && item.client ? { client: item.client } : {}),
      createdAt: typeof item.createdAt === "number" ? item.createdAt : lastUsed,
      lastUsed,
    });
  }
  cache = next;
  return next;
}

function enqueuePersist(): void {
  const snapshot: TicketDoc = { tickets: [...hydrate().values()] };
  const key = docKey();
  persistTail = persistTail
    .then(() => host().state.update(key, snapshot))
    .catch(() => undefined);
}

/**
 * lastUsed stamps are loss-tolerant bookkeeping: they coalesce into one
 * trailing write instead of a full state.json rewrite per request. Unref'd so
 * a pending flush never delays shutdown.
 */
const TOUCH_FLUSH_MS = 5_000;
let touchFlushTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleTouchFlush(): void {
  if (touchFlushTimer) return;
  touchFlushTimer = setTimeout(() => {
    touchFlushTimer = undefined;
    enqueuePersist();
  }, TOUCH_FLUSH_MS);
  touchFlushTimer.unref?.();
}

/** Wait until queued ticket writes have hit the host store. */
export function flushSessionTickets(): Promise<void> {
  if (touchFlushTimer) {
    clearTimeout(touchFlushTimer);
    touchFlushTimer = undefined;
    enqueuePersist();
  }
  return persistTail;
}

/** Drop the in-memory cache (tests). The next read hydrates from the host again. */
export function resetSessionTicketCache(): void {
  cache = undefined;
}

export function rememberSessionTicket(id: string, client?: string, now = Date.now()): void {
  if (!id) return;
  const tickets = hydrate();
  const prev = tickets.get(id);
  tickets.set(id, {
    id,
    ...(client || prev?.client ? { client: client || prev?.client } : {}),
    createdAt: prev?.createdAt ?? now,
    lastUsed: now,
  });
  enqueuePersist();
}

export function touchSessionTicket(id: string, now = Date.now()): void {
  const tickets = hydrate();
  const prev = tickets.get(id);
  if (!prev) return;
  prev.lastUsed = now;
  scheduleTouchFlush();
}

export function forgetSessionTicket(id: string): void {
  const tickets = hydrate();
  if (!tickets.delete(id)) return;
  enqueuePersist();
}

export function sessionTicket(id: string): SessionTicket | undefined {
  if (!id) return undefined;
  return hydrate().get(id);
}

export function hasLiveSessionTicket(id: string, now = Date.now()): boolean {
  const ticket = sessionTicket(id);
  if (!ticket) return false;
  return now - ticket.lastUsed < SESSION_IDLE_TIMEOUT_MS;
}

/** Drop idle tickets. Returns how many were removed. */
export function pruneSessionTickets(now = Date.now()): number {
  const tickets = hydrate();
  const cutoff = now - SESSION_IDLE_TIMEOUT_MS;
  let removed = 0;
  for (const [id, ticket] of tickets) {
    if (ticket.lastUsed < cutoff) {
      tickets.delete(id);
      removed += 1;
    }
  }
  // Removals change behavior across restarts and persist immediately. The old
  // unconditional else-branch (flush lastUsed stamps) wrote the whole state
  // document on EVERY /mcp request; touch schedules its own debounced flush,
  // so a prune that removed nothing has nothing of its own to save.
  if (removed > 0) enqueuePersist();
  return removed;
}
