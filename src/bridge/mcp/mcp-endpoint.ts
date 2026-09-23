/**
 * The MCP endpoint: the instructions a client is handed, the per-session MCP
 * server, and the 2026-07-28-era handler — the protocol surface itself, knowing
 * nothing about sockets, tunnels or session tokens.
 *
 * Both protocol eras are built here from one tool surface (runToolCall), which is
 * what keeps the catalog, usage counters, audit lines and structuredContent rules
 * from drifting apart between the two.
 */
import { host } from "../../host/host.js";
import { randomBytes } from "node:crypto";
import { type EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, Server as SpecServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { TOOL_DEFINITIONS } from "../../mcp/tool-definitions.js";
import { listToolDefinitions } from "../tools/tool-catalog.js";
import { serverInstructions } from "./instruction-prefix.js";
import { asStructuredContent, createActivityId, record, state, text, type SessionState } from "../state.js";
import { invoke } from "../dispatcher.js";
import { normalizeToolCall } from "../tools/tool-call-shape.js";
import { describeToolError } from "../tools/tool-error.js";
import { buildStaleness, staleBuildAdvice } from "../lifecycle/build-staleness.js";
import { persistUsageStats } from "../usage-store.js";
import { failureLine } from "../failure-line.js";

/**
 * The typed payload for one tool result: `asStructuredContent`, minus the
 * legacy-name note.
 *
 * `deprecated` is a hint for a caller still speaking the old vocabulary, so it
 * belongs in the text block where it costs nothing — not in the object clients
 * validate against the tool's declared outputSchema, which does not describe it.
 * The note is top-level and added by the dispatcher (`annotateLegacyResult`).
 */
function structuredPayload(result: unknown): Record<string, unknown> {
  const payload = asStructuredContent(result);
  if (!Object.prototype.hasOwnProperty.call(payload, "deprecated")) return payload;
  const typed = { ...payload };
  delete typed.deprecated;
  return typed;
}

/** SSE events retained for stream resumption (Last-Event-ID replay). */
const SESSION_EVENT_STORE_LIMIT = 512;

/**
 * Bounded in-memory event store enabling MCP stream resumability: when a
 * client's SSE connection drops mid-response, its reconnect replays everything
 * after the last event it saw instead of losing the response. One store is
 * shared by all sessions — replay filters by streamId — and the FIFO is
 * capped so memory stays bounded.
 */
class BoundedInMemoryEventStore implements EventStore {
  private readonly events = new Map<string, { streamId: string; message: unknown }>();
  private readonly order: string[] = [];
  private sequence = 0;

  async storeEvent(streamId: string, message: unknown): Promise<string> {
    const eventId = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${randomBytes(8).toString("hex")}`;
    this.events.set(eventId, { streamId, message });
    this.order.push(eventId);
    while (this.order.length > SESSION_EVENT_STORE_LIMIT) {
      const oldest = this.order.shift();
      if (oldest) this.events.delete(oldest);
    }
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: unknown) => Promise<void> },
  ): Promise<string> {
    const previous = this.events.get(lastEventId);
    if (!previous) return "";
    let found = false;
    for (const eventId of this.order) {
      if (eventId === lastEventId) {
        found = true;
        continue;
      }
      if (!found) continue;
      const event = this.events.get(eventId);
      if (event?.streamId === previous.streamId) {
        await send(eventId, event.message);
      }
    }
    return previous.streamId;
  }
}

export const sharedEventStore = new BoundedInMemoryEventStore();

export function createMcp(session: SessionState): Server {
  const serverVersion = host().version();
  const mcp = new Server(
    { name: "open-bridge", version: serverVersion },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: serverInstructions(),
    },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listToolDefinitions() }));
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    // Both protocol eras receive the same CallToolResult, including a typed
    // companion for failures. The prose block remains the compatibility path.
    const outcome = await runToolCall(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
      session,
    );
    return outcome.result;
  });
  return mcp;
}

/**
 * The 2026-07-28-era handler: one shared instance serving every modern request.
 *
 * `legacy: "reject"` is deliberate. The Bridge already has a stateful 2025-era
 * session path with `eventStore` resumability and SSE keep-alive, so legacy
 * traffic keeps going there; letting v2 also serve it statelessly would mean two
 * behaviours for the same client depending on which one won the race. The
 * classifier below decides the era, and each era has exactly one owner.
 *
 * Built lazily because `createSpecMcp` reads the host config (tool profile) and
 * the host is not available at module-evaluation time.
 */
let modernHandlerCache: { toNode: ReturnType<typeof toNodeHandler> } | undefined;

export function modernNodeHandlerOf(): ReturnType<typeof toNodeHandler> {
  modernHandlerCache ??= {
    toNode: toNodeHandler(
      createMcpHandler(createSpecMcp, {
        legacy: "reject",
        onerror: error => record("bridge", "error", `Modern MCP handler error: ${error.message}`),
      }),
      { onerror: error => record("bridge", "error", `Modern MCP adapter error: ${error.message}`) },
    ),
  };
  return modernHandlerCache.toNode;
}

/** First value of a Node header, which may arrive as an array. */
export function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * The tool surface, shared verbatim by both protocol paths.
 *
 * `tools/list` is identical in both eras. `tools/call` also returns the same
 * CallToolResult shape for a handled failure: `isError`, its readable text, and
 * an optional typed `structuredContent.error` companion. Both are wired from
 * this one function so the catalog, usage counters, audit lines and
 * structuredContent rules can never drift between eras.
 */
type ToolCallPayload = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: true;
};

type ToolCallOutcome = { ok: boolean; result: ToolCallPayload };

function toolErrorPayload(name: string, message: string): ToolCallPayload {
  const tool = normalizeToolCall(name).tool;
  const error = describeToolError(tool, message);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    ...(error ? { structuredContent: { error } } : {}),
  };
}

async function runToolCall(
  name: string,
  args: Record<string, unknown>,
  session: SessionState | undefined,
): Promise<ToolCallOutcome> {
  const startedAt = Date.now();
  const invocationId = createActivityId();
  try {
    if (session) session.lastUsed = Date.now();
    const result = await invoke(name, args, session, { invocationId });
    state.usage.successes += 1;
    state.runtimeUsage.successes += 1;
    persistUsageStats();
    // apply_patch results carry per-file changes: surface them in the
    // activity message and as structured data for the panel's diff badge.
    const changeList = (result as { changes?: Array<{ path?: unknown; additions?: unknown; deletions?: unknown }> } | null)?.changes;
    const activityChanges = Array.isArray(changeList)
      ? changeList
          .filter(c => c && typeof c === "object")
          .map(c => ({
            path: String((c as { path?: unknown }).path ?? ""),
            additions: Number((c as { additions?: unknown }).additions) || 0,
            deletions: Number((c as { deletions?: unknown }).deletions) || 0,
          }))
          .filter(c => c.path)
      : undefined;
    let message = `Completed in ${Date.now() - startedAt} ms.`;
    if (activityChanges?.length) {
      const summary = activityChanges.map(c => `${c.path} +${c.additions}/−${c.deletions}`).join(", ");
      message = `Completed in ${Date.now() - startedAt} ms · ${summary}`;
    }
    record(name, "completed", message, undefined, {
      ...(activityChanges ? { changes: activityChanges } : {}),
      invocationId,
    });
    // Tools declaring an outputSchema also return structuredContent so clients
    // can consume typed data directly; the text block stays for compatibility.
    // The lookup follows the canonical name, so a caller that used a legacy
    // name still gets the same typed payload instead of only text.
    const definition = (TOOL_DEFINITIONS as ReadonlyArray<{ name: string; outputSchema?: unknown }>)
      .find(tool => tool.name === normalizeToolCall(name).tool);
    const payload: ToolCallPayload = definition?.outputSchema
      ? { ...text(result), structuredContent: structuredPayload(result) }
      : text(result);
    // The one note that is not about this call: the process is running older code
    // than the tree on disk. Once per process — it is a fact about the process,
    // not about the call — and outside the `session` branch on purpose: a
    // modern-era caller has no session, and it is exactly the caller least likely
    // to have asked `bridge_status` before trusting what it just observed.
    if (!state.notedStaleBuild) {
      const advice = staleBuildAdvice(buildStaleness()?.stale);
      if (advice) {
        state.notedStaleBuild = true;
        payload.content = [...payload.content, { type: "text", text: advice }];
      }
    }
    return { ok: true, result: payload };
  } catch (e) {
    state.usage.failures += 1;
    state.runtimeUsage.failures += 1;
    persistUsageStats();
    // The reason, not just the duration. This line is the ONLY trace a failed
    // call leaves behind — the console's activity pane, `activity_log` search
    // and the audit file all read it — and it used to say nothing but how long
    // the failure took, which is the least useful fact available about it. The
    // message was already in hand on the very next line, on its way back to the
    // caller. Anyone debugging from the log alone saw "edit_block failed" and
    // had to reproduce the call to find out why.
    //
    // record() redacts and caps at 500 chars, so the raw text is safe to pass:
    // this is the same treatment every other audit line gets.
    const reason = e instanceof Error ? e.message : String(e);
    record(name, "error", failureLine(startedAt, reason), undefined, { invocationId });
    return { ok: false, result: toolErrorPayload(name, reason) };
  }
}

/**
 * Build a 2026-07-28-era server for ONE request.
 *
 * Modern MCP is request-oriented: there is no session and no session id, so the
 * v2 handler calls this factory per request. Everything that used to hang off
 * `SessionState` is process-global anyway (shells, the command table, saved
 * services, resource locks, usage counters, the audit log), so the only thing
 * the modern path loses is the per-session todo list — `report_progress` falls
 * back to the instance's most recent session, and `set_todos` anchors per
 * conversation instead (see tool-catalog). The tool definitions, the usage
 * counters and the audit trail are the same code as the legacy path.
 */
function createSpecMcp(): InstanceType<typeof SpecServer> {
  const server = new SpecServer(
    { name: "open-bridge", version: host().version() },
    {
      capabilities: { tools: {}, logging: {} },
      instructions: serverInstructions(),
    },
  );
  // `TOOL_DEFINITIONS` is `as const`, so its schemas carry `readonly` tuples
  // (e.g. `enum: readonly [1, 2, 3]`) that the spec's mutable JSON-Schema type
  // rejects structurally. v2 validates the emitted schema with AJV at runtime,
  // so the literal types do not affect the wire form: this is a type-level
  // adaptation only, and the JSON a client receives is byte-identical to the
  // legacy path's.
  server.setRequestHandler("tools/list", async () => ({
    tools: listToolDefinitions(),
  }) as unknown as { tools: Array<{ name: string; inputSchema: { type: "object" } }> });
  server.setRequestHandler("tools/call", async req => {
    // `notifications/message` is the 2025-era logging channel; the modern path
    // reaches the client rather than the instance's last session.
    const outcome = await runToolCall(
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
      state.latestSession,
    );
    return outcome.result;
  });
  return server;
}
