/**
 * The MCP endpoint: the instructions a client is handed, the per-session MCP
 * server, and the 2026-07-28-era handler — the protocol surface itself, knowing
 * nothing about sockets, tunnels or session tokens.
 *
 * Both protocol eras are built here from one tool surface (runToolCall), which is
 * what keeps the catalog, usage counters, audit lines and structuredContent rules
 * from drifting apart between the two.
 */
import { host } from "../host/host.js";
import * as fsSync from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { type EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler, Server as SpecServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { TOOL_DEFINITIONS } from "../mcp/tool-definitions.js";
import { listToolDefinitions } from "./tool-catalog.js";
import { asStructuredContent, record, state, text, type SessionState } from "./state.js";
import { root } from "./paths.js";
import { discoverWorkspaceSkills, skillsIndexSuffix } from "./skills.js";
import { invoke } from "./dispatcher.js";
import { normalizeToolCall } from "./tool-call-shape.js";
import { persistUsageStats } from "./usage-store.js";

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

// The advertised catalog (toolProfile + host-capability filters) lives in
// tool-catalog.ts so tools/list and the status surface's tool_count agree.

/**
 * Project instruction files (AGENTS.md / CLAUDE.md — DevSpace two-layer model,
 * root layer only): injected into server instructions so every session sees
 * the project's conventions. Bounded; absent files are simply skipped.
 */
/**
 * The instructions every protocol era hands to a client: the base text, the
 * workspace's own instructions, and whatever skills were discovered. Held as
 * ONE literal because `createMcp` (stateful era) and `createSpecMcp`
 * (2026-07-28 era) both hand their client the same guidance — two copies of a
 * long prompt is how the two eras drift apart without anyone noticing.
 */
function serverInstructions(): string {
  return SERVER_INSTRUCTIONS_BASE + projectInstructionSuffix() + skillsSuffix();
}

const SERVER_INSTRUCTIONS_BASE =
  "You are connected to a local project workspace through the standalone Open Bridge. Relative paths, default command cwd, and project services always use that workspace. Other directories can be accessed only with explicit absolute paths; never let them change the workspace anchor. When starting work on an unfamiliar project, call workspace_brief once for orientation instead of exploring blindly. Use file tools for project management, run_command/start_process for commands, and wait/interact_with_process/process_control/set_process_policy for supervised long-running services. Use connectivity for readiness and save_service/service/service_status for reusable project orchestration. Related single-purpose tools are grouped behind an action parameter: service{action}, file_op{op}, process_control{action}, bridge_status{section}, activity_log{action}, connectivity{target}; the older per-action names still work and are reported as deprecated. Use set_todos for multi-step work and report_progress for transient updates. Use batch to combine multiple tool calls in a single roundtrip. When a task needs several related calls or a tool result is large, prefer run_script: compose the calls in one JavaScript program and return only what you need. After finishing a batch of related edits, call review_changes so the user can see the full cumulative change set. Tool results are JSON objects with a fixed field set per tool: absent facts are explicit nulls or empty strings, so parse by field name and never by line presence; command tools return merged `output` plus separate `stdout`/`stderr`, and a non-zero exit code is not a call failure. Per-tool detail - limits, edge cases, and which sibling tool to prefer - is in docs/tools.md; read it when a description is not enough.";

function projectInstructionSuffix(): string {
  const parts: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const raw = fsSync.readFileSync(path.join(root(), name), "utf8");
      if (!raw.trim()) continue;
      parts.push(`### ${name}\n${raw.slice(0, 8_000)}${raw.length > 8_000 ? "\n…[truncated]" : ""}`);
    } catch {
      // Missing or unreadable file: nothing to inject.
    }
  }
  return parts.length ? `\n\n# Project instructions\n${parts.join("\n\n")}` : "";
}

/**
 * The skills index for the server instructions (see skills.ts). Read once per
 * server construction — each protocol era builds its own — so a skill added
 * later is picked up by `list_skills` rather than by a reconnect. A discovery
 * failure must never keep a session from starting.
 */
function skillsSuffix(): string {
  try {
    return skillsIndexSuffix(discoverWorkspaceSkills().skills);
  } catch {
    return "";
  }
}

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
    const name = req.params.name;
    const startedAt = Date.now();
    try {
      session.lastUsed = Date.now();
      const result = await invoke(name, (req.params.arguments ?? {}) as Record<string, unknown>, session);
      state.usage.successes += 1;
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
      record(name, "completed", message, undefined, activityChanges ? { changes: activityChanges } : undefined);
      // Tools declaring an outputSchema also return structuredContent so clients
      // can consume typed data directly; the text block stays for compatibility.
      // The lookup follows the canonical name, so a caller that used a legacy
      // name still gets the same typed payload instead of only text.
      const definition = (TOOL_DEFINITIONS as ReadonlyArray<{ name: string; outputSchema?: unknown }>)
        .find(tool => tool.name === normalizeToolCall(name).tool);
      if (definition?.outputSchema) return { ...text(result), structuredContent: asStructuredContent(result) };
      return text(result);
    } catch (e) {
      state.usage.failures += 1;
      persistUsageStats();
      record(name, "error", `Failed in ${Date.now() - startedAt} ms.`);
      return {
        isError: true,
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
      };
    }
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
 * `tools/list` is identical in both eras. For `tools/call` the only difference
 * is error reporting: the 2025-era transport serialized `{ isError: true }` into
 * a successful JSON-RPC result, while the 2026-07-28 era expects the handler to
 * throw and lets the protocol layer build the error result. Both are wired from
 * this one function so the catalog, usage counters, audit lines and
 * structuredContent rules can never drift between eras.
 */
type ToolCallOutcome = { ok: true; result: unknown } | { ok: false; message: string };

async function runToolCall(
  name: string,
  args: Record<string, unknown>,
  session: SessionState | undefined,
): Promise<ToolCallOutcome> {
  const startedAt = Date.now();
  try {
    if (session) session.lastUsed = Date.now();
    const result = await invoke(name, args, session);
    state.usage.successes += 1;
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
    record(name, "completed", message, undefined, activityChanges ? { changes: activityChanges } : undefined);
    // Tools declaring an outputSchema also return structuredContent so clients
    // can consume typed data directly; the text block stays for compatibility.
    const definition = (TOOL_DEFINITIONS as ReadonlyArray<{ name: string; outputSchema?: unknown }>)
      .find(tool => tool.name === normalizeToolCall(name).tool);
    const payload = definition?.outputSchema
      ? { ...text(result), structuredContent: asStructuredContent(result) }
      : text(result);
    return { ok: true, result: payload };
  } catch (e) {
    state.usage.failures += 1;
    persistUsageStats();
    record(name, "error", `Failed in ${Date.now() - startedAt} ms.`);
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
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
    if (!outcome.ok) throw new Error(outcome.message);
    return outcome.result as { content: Array<{ type: "text"; text: string }>; structuredContent?: unknown };
  });
  return server;
}
