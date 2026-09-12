import { host } from "../host/host.js";
import * as fsSync from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { StreamableHTTPServerTransport, type EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { classifyInboundRequest, createMcpHandler, Server as SpecServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { TOOL_DEFINITIONS } from "../mcp/tool-definitions.js";
import { listToolDefinitions } from "./tool-catalog.js";
import {
  bridgeTokenFromPath, findPeerIn, healthCheckUrl, peerRegistryCandidates,
  probePublicBridge, proxyToPeer, publishPeerTo, withdrawPeerFrom,
} from "../http/peers.js";
import { bridgeAllowedHosts, isAllowedBridgeHost, validateNgrokDomain } from "../http/request-policy.js";
import { authorizeRequest, authEnabled } from "../http/auth.js";
import { isDeterministicNetworkFailure } from "../network/net-failure.js";
import { isEndpointTakenError, isFatalNgrokError, ngrokFailureSummary } from "../network/ngrok-failure.js";
import { windowsHideForChild } from "./child-console.js";
import {
  MAX_SESSIONS, RECONNECT_DELAYS_MS, ROUTE_TOKEN_KEY,
  asStructuredContent, clientMcpUrl, record, state, text, redactedPublicUrl,
  type SessionState,
} from "./state.js";
import { buildWebAiPrompt } from "./onboarding.js";
import { exchangeLine, isNoteworthy, traceId, tracedFormat, tracedMethod, type TracedEra } from "./request-trace.js";
import { root, workspaceStateSuffix } from "./paths.js";
import { discoverWorkspaceSkills, skillsIndexSuffix } from "./skills.js";
import { nextFreeRounds, shouldClaimDomain, watchIntervalMs } from "./tunnel-watch.js";
import { buildServeTitle, clearServeConsoleTitle, installServeConsoleTitle } from "./console-title.js";
import { invoke } from "./dispatcher.js";
import { loadTodoStore } from "./todo-store.js";
import { persistUsageStats } from "./usage-store.js";
import { cancelAllPendingRestarts, pruneCommands, terminateProcess } from "./processes.js";

/**
 * Extra route handler hook for the app shell: /api and /console live outside
 * the core (they are the standalone host's surfaces, not the Bridge's). The
 * handler returns true when it answered the request.
 */
export type ExtraRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => Promise<boolean>;

let extraRouteHandler: ExtraRouteHandler | undefined;

export function setExtraRouteHandler(handler: ExtraRouteHandler | undefined): void {
  extraRouteHandler = handler;
}

let localServerReadyHook: (() => void) | undefined;

/**
 * Called the moment the local listener is bound — before the tunnel, before
 * start() resolves. The CLI uses it to publish runtime.json, which is how
 * `status` / `url` / `stop` find this instance: writing that file only after
 * start() returned left the CLI blind for as long as the tunnel took (seconds),
 * or forever when the tunnel could not come up at all, even though the console
 * was already serving.
 */
export function setLocalServerReadyHook(hook: (() => void) | undefined): void {
  localServerReadyHook = hook;
}

/** Serialize bridge lifecycle transitions so start/stop/rotate cannot overlap. */
export function enqueueLifecycle(task: () => Promise<void>): Promise<void> {
  const next = state.lifecycleTail.then(task, task);
  state.lifecycleTail = next.catch(() => undefined);
  return next;
}

// --- Lifecycle constants (ShunCode-derived hardening values) ---
/** Hard cap on a single MCP request body; larger uploads are destroyed mid-stream. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** Idle MCP sessions are reclaimed after this long without activity. */
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** How often the idle-session reclamation sweep runs. */
const SESSION_PRUNE_INTERVAL_MS = 60_000;
/** Consecutive deterministic (DNS/refused/TLS) health failures before aborting startup early. */
const PUBLIC_HEALTH_DETERMINISTIC_FAILURE_LIMIT = 3;
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

const sharedEventStore = new BoundedInMemoryEventStore();

/**
 * Read (and size-cap) a POST body before handing the parsed JSON to the MCP
 * transport: without this, one runaway upload would be buffered without bound.
 * On overflow the stream keeps draining (so the socket can answer 400) but no
 * further bytes are retained.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      if (overflowed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BYTES) {
        overflowed = true;
        chunks.length = 0;
        reject(new Error(`MCP request body exceeds ${MAX_REQUEST_BYTES} bytes.`));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (overflowed) return;
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("MCP request body is not valid JSON."));
      }
    });
    req.on("error", reject);
    // A client that disconnects mid-upload does not always emit 'error'; on
    // several Node paths only 'aborted'/'close' fire. Without these listeners
    // the promise would never settle and the request handler would leak.
    req.on("aborted", () => reject(new Error("MCP request was aborted by the client.")));
    req.on("close", () => {
      if (!req.complete) reject(new Error("MCP request connection closed before the body was received."));
    });
  });
}

/** Kill the tunnel and everything it spawned; a bare kill() leaves orphans holding the domain on Windows. */
function killTunnelTree(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 3_000,
        windowsHide: true,
      });
      return;
    } catch {
      // taskkill can refuse on an already-dead pid; fall through to kill().
    }
  }
  try { child.kill(); } catch { /* the process was already gone */ }
}

/** A ngrok startup failure (spawn error), distinct from a health-check timeout. */
class NgrokSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NgrokSpawnError";
  }
}

/**
 * Wait for the tunnel's public health endpoint while racing ngrok's own spawn
 * 'error': when the executable is missing or not runnable the failure is known
 * in milliseconds, but the health check against ngrok's edge would otherwise
 * burn the whole 20 s budget first and then report a misleading "health check
 * failed" instead of the real cause.
 */
async function waitForTunnelReady(healthUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const controller = new AbortController();
  let rejectSpawn: ((error: Error) => void) | undefined;
  const spawnError = new Promise<never>((_, reject) => { rejectSpawn = reject; });
  const onSpawnError = (error: Error): void => {
    rejectSpawn?.(new NgrokSpawnError(error.message));
  };
  // Mark both racers as handled so the loser can never surface as an
  // unhandled rejection after the winner settles.
  void spawnError.catch(() => undefined);
  child.once("error", onSpawnError);

  // ngrok can also start and then die within a second — a rejected --url, a bad
  // authtoken, a refused proxy. Without this racer those attempts sat out the
  // whole public-health budget (20 s by default) and then reported a generic
  // timeout, which the scheduler classified as transient and retried forever:
  // an endless spawn loop that republished a dead https URL on every pass.
  const tail: string[] = [];
  const collect = (chunk: Buffer): void => {
    tail.push(chunk.toString());
    if (tail.length > 40) tail.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exited = new Promise<never>((_, reject) => {
    // 'close', not 'exit': 'exit' can fire before the process's output has been
    // drained, and an empty buffer classifies ERR_NGROK_313 as a transient blip —
    // which is precisely the endless-retry bug this racer exists to end.
    child.once("close", (code, signal) => {
      const output = tail.join("");
      const how = `code ${code}${signal ? `, signal ${signal}` : ""}`;
      reject(isFatalNgrokError(output)
        ? new NgrokSpawnError(`ngrok 拒绝了这次隧道启动（${how}）：${ngrokFailureSummary(output)}`)
        : new Error(`ngrok exited before the tunnel was ready (${how}).`));
    });
  });
  void exited.catch(() => undefined);

  const health = waitForPublicHealth(healthUrl, controller.signal);
  void health.catch(() => undefined);
  try {
    await Promise.race([health, spawnError, exited]);
  } finally {
    controller.abort();
    child.off("error", onSpawnError);
    child.stdout.off("data", collect);
    child.stderr.off("data", collect);
  }
}

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
  "You are connected to a local project workspace through the standalone Open Bridge. Relative paths, default command cwd, and project services always use that workspace. Other directories can be accessed only with explicit absolute paths; never let them change the workspace anchor. When starting work on an unfamiliar project, call workspace_brief once for orientation instead of exploring blindly. Use file tools for project management, run_command/start_process for commands, and wait_process/interact_with_process/restart_process/set_process_policy for supervised long-running services. Use check_port/check_http for readiness and save_service/list_services/start_service/stop_service/restart_service/delete_service/start_all_services/stop_all_services/service_status for reusable project orchestration. Use set_todos for multi-step work and report_progress for transient updates. Use batch to combine multiple tool calls in a single roundtrip. When a task needs several related calls or a tool result is large, prefer run_script: compose the calls in one JavaScript program and return only what you need. After finishing a batch of related edits, call review_changes so the user can see the full cumulative change set.";

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

function createMcp(session: SessionState): Server {
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
      const definition = (TOOL_DEFINITIONS as ReadonlyArray<{ name: string; outputSchema?: unknown }>)
        .find(tool => tool.name === name);
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

function modernNodeHandlerOf(): ReturnType<typeof toNodeHandler> {
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
function headerValue(raw: string | string[] | undefined): string | undefined {
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
      .find(tool => tool.name === name);
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

async function waitForPublicHealth(url: string, abort?: AbortSignal): Promise<void> {
  const timeoutMs = host().config.get<number>("publicHealthTimeoutMs", 20_000);
  const until = Date.now() + timeoutMs;
  let last = "No response";
  let deterministicFailures = 0;
  while (Date.now() < until) {
    if (abort?.aborted) throw new Error("Startup aborted before the public health check completed.");
    // Combine the per-attempt cap with the caller's cancellation where the
    // runtime supports it (AbortSignal.any needs Node >= 20.3); on older hosts
    // the loop-top abort check above is the fallback.
    const attemptSignal = abort && typeof AbortSignal.any === "function" ? AbortSignal.any([AbortSignal.timeout(4_000), abort]) : AbortSignal.timeout(4_000);
    try {
      const response = await fetch(url, {
        headers: { "ngrok-skip-browser-warning": "true" },
        signal: attemptSignal,
      });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
      deterministicFailures = 0;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      // DNS/refused/TLS failures cannot heal by waiting; abort early instead of
      // burning the whole budget (the full timeout stays for flaky networks).
      if (isDeterministicNetworkFailure(e)) {
        deterministicFailures += 1;
        if (deterministicFailures >= PUBLIC_HEALTH_DETERMINISTIC_FAILURE_LIMIT) {
          throw new Error(
            `Public health check aborted early: the network failure is deterministic (${last}). ` +
            "If this machine reaches the internet through a proxy, ngrok must be able to connect directly "
            + "(the free plan rejects proxies; set ngrokUseHttpProxy off in the console settings page).",
          );
        }
      } else {
        deterministicFailures = 0;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error(`Public health check failed after ${timeoutMs} ms: ${last}`);
}

function pruneSessions(): void {
  // Idle reclamation: a client that walked away keeps its transport (and todo
  // state) alive forever otherwise. Busy sessions are never reclaimed.
  const idleCutoff = Date.now() - SESSION_IDLE_TIMEOUT_MS;
  let prunedAny = false;
  for (const [id, session] of state.sessions) {
    if (session.activeRequests === 0 && session.lastUsed < idleCutoff) {
      state.sessions.delete(id);
      void session.transport.close();
      prunedAny = true;
    }
  }
  // Capacity: evict the least-recently-used idle sessions beyond MAX_SESSIONS.
  while (state.sessions.size > MAX_SESSIONS) {
    const evictable = [...state.sessions.entries()]
      .filter(([, session]) => session.activeRequests === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!evictable) break; // every session is mid-request; leave them alone
    state.sessions.delete(evictable[0]);
    void evictable[1].transport.close();
    prunedAny = true;
  }
  if (prunedAny) host().ui.update();
}

/** Ensure one slot is free before creating a session; false when all are busy. */
/**
 * clientInfo from the initialize request that is about to create a session.
 *
 * The session object is built inside `onsessioninitialized`, which never sees
 * the parsed body, so the label travels through this variable. Single-threaded
 * request handling makes that safe: it is written and consumed within one
 * handleRequest() call.
 */
let pendingClientLabel: string | undefined;

function clientLabelFrom(body: unknown): string | undefined {
  const info = (body as { params?: { clientInfo?: { name?: unknown; version?: unknown } } } | undefined)
    ?.params?.clientInfo;
  if (!info || typeof info.name !== "string" || !info.name) return undefined;
  return typeof info.version === "string" && info.version ? `${info.name}/${info.version}` : info.name;
}

function makeRoomForSession(): boolean {
  if (state.sessions.size < MAX_SESSIONS) return true;
  const evictable = [...state.sessions.entries()]
    .filter(([, session]) => session.activeRequests === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
  if (!evictable) return false;
  state.sessions.delete(evictable[0]);
  void evictable[1].transport.close();
  return true;
}

function startSessionPruneLoop(): void {
  if (state.sessionPruneTimer) return;
  state.sessionPruneTimer = setInterval(() => {
    try { pruneSessions(); } catch { /* best-effort sweep */ }
    // Retire finished commands on the same 60 s sweep: pruneCommands used to
    // run only when a NEW run_command/get_process_snapshot came in, so a
    // long-idle Bridge kept every finished command's buffers (3 x 32 MiB)
    // and its %TEMP% capture file alive indefinitely.
    try { pruneCommands(); } catch { /* best-effort sweep */ }
  }, SESSION_PRUNE_INTERVAL_MS);
}

function stopSessionPruneLoop(): void {
  if (state.sessionPruneTimer) clearInterval(state.sessionPruneTimer);
  state.sessionPruneTimer = undefined;
}

/**
 * Reconnect the tunnel WITHOUT tearing down the local server: all MCP sessions,
 * todo state and managed processes survive a tunnel crash. A generation guard
 * invalidates timers left behind by a stop/restart that happened in between.
 */
/** Cancels a pending reconnect: the last failure was not one retrying can heal. */
function stopReconnectChain(): void {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = undefined;
  state.reconnectAttempt = 0;
}

function scheduleReconnect(domain: string, generation: number): void {
  if (state.stopping || generation !== state.tunnelGeneration) return;
  if (!state.server) return; // local side is gone; a reconnect has nothing to attach to
  if (state.tunnelRole === "blocked") return; // another window owns the domain; watcher handles it
  if (!host().config.get<boolean>("autoReconnect", true)) {
    record("ngrok", "progress", "Tunnel exited; autoReconnect is off — the Bridge stays local-only.");
    // With no reconnect the published https URL is dead; clear it so copy and
    // status fall back to the live loopback URL instead of a vanished tunnel.
    state.tunnelRole = "none";
    state.tunnelUrl = "";
    host().ui.refresh();
    return;
  }
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 60_000;
  state.reconnectAttempt += 1;
  record("ngrok", "progress", `Tunnel exited; local Bridge stays up for live sessions. Reconnecting in ${Math.round(delay / 1000)} s.`);
  state.reconnectTimer = setTimeout(() => {
    // Clear the handle when the timer fires: a stale (already-fired) handle
    // made "is a reconnect pending?" unanswerable for startInternal's retry
    // path below.
    state.reconnectTimer = undefined;
    void enqueueLifecycle(async () => {
      if (generation !== state.tunnelGeneration || !state.server) return;
      await startTunnelInternal(generation);
    }).catch(e => {
      const message = e instanceof Error ? e.message : String(e);
      record("ngrok", "error", message);
      // A missing domain, an unusable binary or a configuration ngrok refuses
      // is deterministic — retrying cannot heal it. Stay local-only, say why
      // once, and stop arming reconnects that can never succeed.
      if (message.includes("ngrokDomain") || e instanceof NgrokSpawnError) {
        stopReconnectChain();
        host().notify("error", `隧道无法建立，已停止自动重试：${message}`);
        return;
      }
      scheduleReconnect(domain, generation);
    });
  }, delay);
}

// Windows share one public tunnel: each instance advertises its token and loopback port,
// and whichever owns ngrok forwards requests addressed to a peer token.
function peersFile(): string {
  const storage = host().storageDir();
  return storage ? path.join(storage, "bridge-peers.json") : "";
}

/**
 * Every registry this instance advertises itself in.
 *
 * Its own comes first; the rest are the ones another Open Bridge build on this
 * machine already keeps (the VS Code extension uses the editor's globalStorage).
 * Without them the two products cannot see each other, so the app can neither
 * serve requests that arrive through an existing tunnel nor borrow it — see
 * peerRegistryCandidates. `sharedPeerRegistry` replaces the discovery with one
 * explicit path for setups the guess does not cover.
 */
function sharedPeerFiles(): string[] {
  const own = peersFile();
  if (!own) return [];
  const override = host().config.get<string>("sharedPeerRegistry", "").trim();
  if (override) return [override];
  return peerRegistryCandidates(own, {
    appData: process.platform === "win32" ? process.env.APPDATA : undefined,
    configHome: process.platform === "linux"
      ? process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, ".config") : undefined)
      : undefined,
    libraryHome: process.platform === "darwin" && process.env.HOME
      ? path.join(process.env.HOME, "Library", "Application Support")
      : undefined,
  }, file => fsSync.existsSync(file)).slice(1);
}

/** Registries to READ peers from: ours, plus any the machine already has. */
function readablePeerFiles(): string[] {
  const own = peersFile();
  return own ? [own, ...sharedPeerFiles()] : [];
}

/**
 * Registries to ADVERTISE ourselves in.
 *
 * Advertising in someone else's registry is what makes their tunnel route our
 * token to us — it publishes this instance. So it happens only while a tunnel is
 * actually in play: `--no-tunnel` (tunnelProvider none) or an empty domain means
 * local-only, and local-only must not become reachable from the internet through
 * a tunnel this machine merely happens to run for something else.
 */
function publishablePeerFiles(): string[] {
  const own = peersFile();
  if (!own) return [];
  const wantsTunnel = host().config.get<string>("tunnelProvider", "ngrok") === "ngrok"
    && Boolean(host().config.get<string>("ngrokDomain", "").trim());
  return wantsTunnel ? [own, ...sharedPeerFiles()] : [own];
}

async function publishSelf(): Promise<void> {
  const files = publishablePeerFiles();
  if (!files.length || !state.routeToken || !state.port) return;
  const results = await publishPeerTo(files, {
    token: state.routeToken,
    port: state.port,
    pid: process.pid,
    root: state.activeWorkspaceRoot,
    at: Date.now(),
  });
  state.peersRegistered = results.some(result => result.ok);
  for (const failed of results.filter(result => !result.ok)) {
    record("bridge", "error", `Peer registry write failed (${failed.file}): ${failed.error}`);
  }
}

async function withdrawSelf(): Promise<void> {
  // Withdraw from every registry we might have advertised in: a row left behind
  // in the tunnel owner's file would keep routing traffic to a dead port.
  const files = readablePeerFiles();
  if (!files.length || !state.routeToken || !state.peersRegistered) return;
  state.peersRegistered = false;
  // Best-effort by nature: a stale row must never block a shutdown, and the
  // readers drop rows whose pid is gone anyway. A failure is still recorded,
  // because a registry we cannot write is worth knowing about.
  for (const failed of (await withdrawPeerFrom(files, state.routeToken)).filter(result => !result.ok)) {
    record("bridge", "error", `Peer registry cleanup failed (${failed.file}): ${failed.error}`);
  }
}

async function adoptSharedTunnel(domain: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await healthCheckUrl(`https://${domain}/healthz/${state.routeToken}`, 1_000)) {
      await watchPublicDomain(domain);
      return true;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
  return false;
}

function stopPublicWatch(): void {
  // clearTimeout works on either kind of handle, and the watch re-arms itself,
  // so a single cleared handle is enough to end the chain.
  if (state.publicWatchTimer) clearTimeout(state.publicWatchTimer);
  state.publicWatchTimer = undefined;
}

function stopRepublishLoop(): void {
  if (state.rePublishTimer) clearInterval(state.rePublishTimer);
  state.rePublishTimer = undefined;
}

/**
 * Re-assert our peer registry entry periodically. The shared file is a plain
 * read-merge-write JSON blob: two windows publishing concurrently can lose a
 * row (last writer wins), which would leave the loser unreachable through the
 * shared tunnel until it republishes. A 30 s re-publish heals that quickly.
 */
function startRepublishLoop(): void {
  stopRepublishLoop();
  state.rePublishTimer = setInterval(() => { void publishSelf(); }, 30_000);
}

/**
 * Watch the shared domain. The cadence follows the last probe: a borrowed tunnel
 * that answers is checked lazily, one that stopped answering is checked quickly —
 * measured downtime on a real holder exit was ~2 minutes under the old fixed
 * 10 s interval, most of it spent waiting for the next round (see tunnel-watch.ts).
 */
function startPublicWatch(domain: string): void {
  stopPublicWatch();
  let healthy = true;
  const schedule = (): void => {
    state.publicWatchTimer = setTimeout(() => {
      void watchPublicDomain(domain)
        .then(wasHealthy => { healthy = wasHealthy; })
        .catch(error => { record("ngrok", "error", String(error)); })
        .finally(() => { if (state.publicWatchTimer !== undefined) schedule(); });
    }, watchIntervalMs(healthy));
  };
  schedule();
}

/** One watch round. Returns whether the public endpoint is serving us. */
async function watchPublicDomain(domain: string): Promise<boolean> {
  if (await healthCheckUrl(`https://${domain}/healthz/${state.routeToken}`, 4_000)) {
    state.missingPublicRounds = 0;
    if (state.tunnelRole === "follower") return true;
    state.tunnelRole = "follower";
    // Routed through a peer tunnel again: a future tunnel exit should start
    // reconnecting at the fast end of the backoff curve, not at the 60 s cap
    // left over from the failed attempts that led here.
    state.reconnectAttempt = 0;
    state.tunnelUrl = `https://${domain}/mcp/${state.routeToken}`;
    record("bridge", "completed", `Published through a peer tunnel: ${redactedPublicUrl(state.tunnelUrl)}`);
    host().ui.refresh();
    return true;
  }
  // Only ngrok's own "no endpoint here" answer is evidence that nobody holds the
  // domain. A timeout or a 5xx while the holder reconnects is NOT evidence, and
  // a round that is merely inconclusive resets the counter — the claim below
  // spawns a tunnel, so it must not be triggered by someone else's bad minute.
  const verdict = await probePublicBridge(domain, state.routeToken);
  // A busy instance is the other claimant (a reconnect is armed, or a tunnel
  // child exists): never count towards a claim while it works. Resetting rather
  // than merely skipping keeps the rule the docs promise — *two consecutive*
  // free verdicts — so a claim can never be assembled across someone else's
  // reconnect attempt.
  const busy = Boolean(state.reconnectTimer || state.tunnel);
  state.missingPublicRounds = busy ? 0 : nextFreeRounds(state.missingPublicRounds, verdict);
  if (!shouldClaimDomain(state.missingPublicRounds, busy)) return false;
  state.missingPublicRounds = 0;
  stopPublicWatch();
  record("ngrok", "progress", "Public domain is free again; this window will claim it.");
  await enqueueLifecycle(async () => {
    await stopInternal(false);
    await startInternal();
  });
  return true;
}

/** Close the loopback listener and clear its pointers (used by failure paths and stop). */
async function stopLocalServer(): Promise<void> {
  const activeServer = state.server;
  state.server = undefined;
  if (!activeServer) return;
  record("bridge", "progress", "Shutdown started: closing the MCP listener.");
  clearServeConsoleTitle();
  try {
    // Drop idle keep-alive connections immediately so stop()/reload does not
    // wait on Node's keepAliveTimeout; in-flight requests still drain.
    activeServer.closeIdleConnections();
  } catch {
    // best-effort: very old runtimes without closeIdleConnections still close below
  }
  const inflight = state.sessions.size;
  await new Promise<void>(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
    // stop() must never hang: server.close() waits for every ACTIVE connection,
    // and a proxied peer SSE stream (peers.ts) is not tracked in state.sessions,
    // so it would keep stop() pending forever and wedge the lifecycle queue.
    // Force-destroy stragglers after a short grace period, then resolve.
    timer = setTimeout(() => {
      // Named, not silent: an operator seeing this line knows a client was cut
      // off rather than that shutdown was slow for no reason.
      record("bridge", "warning", "Shutdown: grace period elapsed, closing connections that had not drained.");
      try { activeServer.closeAllConnections?.(); } catch { /* very old runtimes lack it */ }
      // In the worst case (close still not signalled) resolve shortly after.
      timer = setTimeout(() => { record("bridge", "progress", "Shutdown completed: stragglers closed."); finish(); }, 250);
    }, 1_500);
    timer.unref?.();
    // Announce the wait only when there is something to wait for, so an idle
    // stop stays one line instead of three.
    if (inflight > 0) {
      record("bridge", "progress", `Shutdown: draining ${inflight} open session(s) before exit.`);
    }
    try {
      activeServer.close(() => {
        record("bridge", "progress", inflight > 0 ? "Shutdown: all sessions drained." : "Shutdown completed: listener closed.");
        finish();
      });
    } catch {
      finish();
    }
  });
}

async function startInternal(): Promise<void> {
  if (state.server) {
    // The local server is up: Start is normally a no-op. But after the tunnel
    // gave up (a deterministic spawn failure stops the reconnect chain for
    // good), a Start click should RETRY the tunnel instead of answering
    // "already running" while the public URL stays dead and unreachable —
    // previously the only recovery was Stop + Start.
    const wantsTunnel = host().config.get<string>("tunnelProvider", "ngrok") === "ngrok";
    if (wantsTunnel && state.tunnelRole === "none" && !state.tunnel && !state.reconnectTimer) {
      state.tunnelGeneration += 1; // invalidate anything stale from the failed chain
      await startTunnelInternal(state.tunnelGeneration);
      host().ui.refresh();
      return;
    }
    host().notify("info", "Open Bridge is already running.");
    return;
  }
  await loadRouteToken();
  try {
    await startHttpInternal();
  } catch (error) {
    // Nothing is listening: a half-started server would make every retry
    // answer "already running", so tear the local side fully down.
    const message = error instanceof Error ? error.message : String(error);
    await stopInternal(false);
    record("bridge", "error", `Start failed: ${message}`);
    throw error;
  }
  // A tunnel failure must NOT take the healthy local server down with it —
  // that is exactly what the reconnect path already does (keep the server and
  // live MCP sessions, drop only the tunnel). startTunnelInternal clears
  // tunnelUrl on every failure path, the panel falls back to the loopback
  // URL, and the Start-retry branch above re-arms the tunnel once the cause is
  // fixed (bad ngrok path, network down at boot, domain still held by a stale
  // ngrok, ...). Only a failure of the local server itself is fatal.
  let tunnelError: string | undefined;
  try {
    await startTunnelInternal(state.tunnelGeneration);
  } catch (error) {
    tunnelError = error instanceof Error ? error.message : String(error);
    record("bridge", "error", `Tunnel failed; local Bridge stays up: ${tunnelError}`);
  }
  record("bridge", "completed", `Started: ${redactedPublicUrl(clientMcpUrl())}`);
  host().ui.refresh();
  if (tunnelError) {
    host().notify("warn", 
      `Open Bridge 已在本地启动，但隧道发布失败：${tunnelError} 本地 URL 仍可用；修复后点 Start 即可重试隧道。`,
    );
    return;
  }
  host().notify("info", "Open Bridge 已启动。请从控制面板复制 MCP URL。");
  host().notify("warn", "Treat this URL as a secret: it grants workspace access.");
}

/** Bind loopback, wire request handling (CORS, caps, sessions) and self-verify. */
/**
 * Reply to a request the bearer gate refused, and record it.
 *
 * Extracted from the request handler: the rejection path is the security
 * boundary, and it is easier to audit on its own than nested three levels
 * deep in the transport setup.
 */
function rejectUnauthorized(
  res: ServerResponse,
  gate: { status: number; reason: string; retryAfterMs?: number; challenge?: string },
  securityHeaders: Record<string, string>,
): void {
  record("bridge", "error", `Unauthenticated request rejected (${gate.reason}).`);
  const headers: Record<string, string> = {
    ...securityHeaders,
    "content-type": "application/json",
    // An OAuth client finds the authorization server through this header, so the
    // gate supplies the spec-shaped challenge (with resource_metadata) when it
    // rejected for OAuth reasons, and the plain bearer challenge otherwise.
    "www-authenticate": gate.challenge ?? 'Bearer realm="open-bridge", error="invalid_token"',
  };
  if (gate.retryAfterMs) headers["retry-after"] = String(Math.ceil(gate.retryAfterMs / 1000));
  if (!res.headersSent) res.writeHead(gate.status, headers);
  res.end(JSON.stringify({
    error: gate.status === 429 ? "Too many failed attempts. Retry later." : "Unauthorized.",
  }));
}

async function startHttpInternal(): Promise<void> {
  const configuredPort = host().config.get<number>("port", 0);
  // An ephemeral bind must not move on a rebind: the console was loaded from
  // this origin, `runtime.json` advertises this port to the CLI, and the tunnel
  // forwards to it. Port 0 means "any free port", which is fine for the first
  // bind and wrong for the second, so the port we already chose wins.
  const listenPort = configuredPort === 0 && state.boundPort ? state.boundPort : configuredPort;
  state.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Outermost safety net for the WHOLE handler body: an async handler that
    // rejects surfaces as an unhandled rejection, and Node's default for that
    // kills the process — one malformed request line was enough (WHATWG URL
    // throws on targets Node's own HTTP parser accepted: absolute-form with an
    // out-of-range port). The body keeps its original indentation so this diff
    // stays surgical; its inner try/catches are unchanged and still fire first.
    try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const securityHeaders = {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    // CORS is safe here because the route token IS the credential: browser-hosted
    // MCP clients could otherwise never call the endpoint cross-origin.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id, authorization");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    const reject = (status: number, message = "Not found"): void => {
      if (!res.headersSent) res.writeHead(status, { ...securityHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    };
    const reqHost = req.headers.host;
    const configuredDomain = String(host().config.get<string>("ngrokDomain", ""))
      .trim()
      .toLowerCase();
    const allowedHosts = bridgeAllowedHosts(state.port, configuredDomain);
    if (!isAllowedBridgeHost(reqHost, state.port, configuredDomain)) {
      reject(403, "Host is not allowed.");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === `/healthz/${state.routeToken}`) {
      res.writeHead(200, { ...securityHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const wanted = bridgeTokenFromPath(url.pathname);
    if (wanted && wanted.token !== state.routeToken) {
      const peer = await findPeerIn(readablePeerFiles(), wanted.token);
      if (peer) {
        await proxyToPeer(
          peer,
          req,
          res,
          wanted.kind === "mcp" ? `/mcp/${wanted.token}${url.search}` : `/healthz/${wanted.token}`,
        );
        return;
      }
    }
    if (url.pathname !== `/mcp/${state.routeToken}`) {
      // App-shell surfaces (/api, /console) get a chance before the 404.
      if (extraRouteHandler && await extraRouteHandler(req, res, url)) return;
      reject(404);
      return;
    }
    // Optional bearer gate, disabled by default. It runs before the MCP
    // transport so an unauthenticated request never reaches the session table,
    // the event store, or a tool handler. /healthz stays exempt: the tunnel
    // readiness probe and the public-bridge ownership probe both hit it, and it
    // returns nothing but { ok: true }.
    const gate = await authorizeRequest(req, url);
    if (!gate.ok) {
      rejectUnauthorized(res, gate, securityHeaders);
      return;
    }
    // Trace this MCP exchange. `close` fires even when the client disconnects
    // mid-response, which is the case worth recording and the one an
    // `end`-based hook would miss. Everything written is allow-listed or hashed
    // (see request-trace.ts) — the method string comes from a closed set, the
    // session and tool are hashes, and the error is a fingerprint plus a bounded
    // one-liner.
    const exchangeStartedAt = Date.now();
    const headerEra: TracedEra = headerValue(req.headers["mcp-protocol-version"]) ? "modern" : "legacy";
    const methodHint = headerValue(req.headers["mcp-method"]);
    // The modern era names its target in a header; the legacy era names it in
    // `params.name`. Seed from the header and let the body fill the gap below.
    let toolNameHint = headerValue(req.headers["mcp-name"]);
    res.once("close", () => {
      const outcome = {
        method: tracedMethod(methodHint),
        era: headerEra,
        httpStatus: res.statusCode,
        durationMs: Date.now() - exchangeStartedAt,
        // writableFinished is false when the response never completed, which is
        // what a walked-away client looks like from here.
        aborted: !res.writableFinished,
        format: tracedFormat(res.getHeader("content-type")),
        sessionHash: traceId(req.headers["mcp-session-id"]),
        toolHash: traceId(toolNameHint),
      };
      if (!isNoteworthy(outcome)) return;
      record("mcp", outcome.aborted ? "warning" : "progress", exchangeLine(outcome));
    });
    try {
      pruneSessions();
      const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      let session = sessionId ? state.sessions.get(sessionId) : undefined;
      // Size-cap POST bodies before the transport buffers them.
      let parsedBody: unknown;
      if (req.method === "POST") {
        try {
          parsedBody = await readJsonBody(req);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // The client may already be gone (aborted upload): do not write on a
          // destroyed response.
          if (!res.headersSent && !res.writableEnded && !res.destroyed) {
            res.writeHead(400, { ...securityHeaders, "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message } }));
          }
          return;
        }
      }
      // Trace the legacy tool name too, so both eras report the same field.
      // Read defensively from an unvalidated body: this is logging, and a
      // malformed shape must not turn into a thrown error on the request path.
      if (!toolNameHint) {
        const body = parsedBody as { method?: unknown; params?: { name?: unknown } } | undefined;
        if (body && typeof body === "object" && body.method === "tools/call" && typeof body.params?.name === "string") {
          toolNameHint = body.params.name;
        }
      }
      // Two protocol eras share this one endpoint, and the request itself
      // decides which one serves it — a client never has to be told, and no
      // configuration selects a "mode".
      //
      //  - 2026-07-28 (modern): a per-request envelope in `params._meta` plus
      //    `MCP-Protocol-Version` / `MCP-Method` headers. Stateless: no session
      //    id is minted or required. Served by the v2 handler.
      //  - 2025-era (legacy): an `initialize` handshake and a stateful session.
      //    Served by the session path below, unchanged.
      //
      // The classifier is the v2 SDK's own, so the boundary between eras is
      // whatever the spec says it is rather than our guess at it. Anything that
      // is neither (a malformed modern envelope) is handed to the v2 handler so
      // the client receives the spec's own error, with its `data.envelope`.
      let era: "modern" | "legacy" = "legacy";
      const classification = classifyInboundRequest({
        httpMethod: req.method ?? "GET",
        protocolVersionHeader: headerValue(req.headers["mcp-protocol-version"]),
        mcpMethodHeader: headerValue(req.headers["mcp-method"]),
        mcpNameHeader: headerValue(req.headers["mcp-name"]),
        body: parsedBody,
      });
      if (classification.kind !== "legacy") era = "modern";

      if (era === "modern") {
        try {
          await modernNodeHandlerOf()(req, res, parsedBody);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          record("bridge", "error", `Modern MCP handler failed: ${message}`);
          if (!res.headersSent) res.writeHead(500, { ...securityHeaders, "content-type": "application/json" });
          if (!res.writableEnded) res.end(JSON.stringify({ error: message }));
        }
        return;
      }

      if (!session) {
        if (!makeRoomForSession()) {
          if (!res.headersSent) res.writeHead(503, { ...securityHeaders, "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Bridge session capacity reached. Close an existing MCP session and retry." }));
          return;
        }
        // Only an initialize mints a session, and only then is there a client
        // name to show: the console prints "cursor/0.42 · 空闲 2 分钟" instead of
        // a bare count. onsessioninitialized below never sees the parsed body,
        // so the label is handed over here — same call, same tick.
        pendingClientLabel = clientLabelFrom(parsedBody);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomBytes(16).toString("hex"),
          enableDnsRebindingProtection: true,
          allowedHosts,
          eventStore: sharedEventStore,
          // SSE keep-alive comment frames every 15 s so proxies (ngrok edge
          // included) do not reap idle streams; retryInterval hints clients to
          // reconnect after 2 s (ShunCode parity).
          keepAliveMs: 15_000,
          retryInterval: 2_000,
          onsessioninitialized: id => {
            state.sessions.set(id, newSession);
            pruneSessions();
            // Keep the panel's session count live instead of ≤30 s stale.
            host().ui.update();
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            state.sessions.delete(transport.sessionId);
            host().ui.update();
          }
        };
        const persisted = loadTodoStore();
        const persistedTodos = Array.isArray(persisted.todos) ? persisted.todos.map(t => (t !== null && typeof t === "object" ? { ...t as object } : t)) : [];
        const newSession: SessionState = { transport, lastUsed: Date.now(), connectedAt: Date.now(), calls: 0, client: pendingClientLabel, todos: persistedTodos, activeRequests: 0 };
        session = newSession;
        const mcpServer = createMcp(newSession);
        newSession.mcp = mcpServer as unknown as NonNullable<SessionState["mcp"]>;
        await mcpServer.connect(transport);
      }
      session.lastUsed = Date.now();
      state.latestSession = session;
      session.activeRequests += 1;
      try {
        await session.transport.handleRequest(req, res, parsedBody);
      } finally {
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        session.lastUsed = Date.now();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) res.writeHead(500, { ...securityHeaders, "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    } catch (error) {
      // See the try above: turns "process dies on a stray request" into a 400.
      const message = error instanceof Error ? error.message : String(error);
      record("bridge", "error", `Request handler failed: ${message}`);
      try {
        if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
        if (!res.writableEnded) res.end(JSON.stringify({ error: message }));
      } catch { /* the socket is already gone */ }
    }
  });
  // Do not race the client's keep-alive timer. Node destroys an idle connection
  // once keepAliveTimeout elapses (5 s by default), and a browser or pool that
  // reuses that socket at the same instant sees ECONNRESET while writing the
  // request — which is how a rotation failed on the busier CI runner while
  // passing locally. The client, which decides for itself when to drop an idle
  // socket, should always be the one to close it; leftovers are closed
  // explicitly by stopLocalServer(). Node requires headersTimeout to exceed
  // keepAliveTimeout.
  state.server.keepAliveTimeout = 60_000;
  state.server.headersTimeout = 66_000;
  await new Promise<void>((resolve, reject) => {
    state.server!.once("error", reject);
    state.server!.listen(listenPort, "127.0.0.1", () => resolve());
  });
  state.port = (state.server.address() as { port: number }).port;
  state.boundPort = state.port;
  // Name this window after the instance it is running. Children share the console
  // (that is how closing the window stops the tunnel too), and cmd.exe/npm write
  // their own titles into it — see console-title.ts. cosmetic, but it is the
  // operator's only clue about which workspace this window is serving.
  installServeConsoleTitle(buildServeTitle(path.basename(root()), state.port));
  try {
    localServerReadyHook?.();
  } catch {
    // A host hook must never take the listener down with it.
  }
  // Post-listen backstop: without these, a runtime failure (or unexpected
  // close) used to be swallowed after the one-shot listen error handler was
  // consumed, leaving the panel "running" on a dead port.
  const listeningServer = state.server;
  listeningServer.on("error", (error: Error) => {
    if (state.server !== listeningServer) return;
    record("bridge", "error", `HTTP server error: ${error.message}`);
  });
  listeningServer.on("close", () => {
    if (state.server !== listeningServer) return; // deliberate stop cleaned up already
    state.server = undefined;
    state.port = 0;
    record("bridge", "error", "HTTP server closed unexpectedly; the Bridge is offline. Start it again from the panel.");
    host().ui.refresh();
  });
  startSessionPruneLoop();
  await publishSelf();
  if (state.peersRegistered) startRepublishLoop();
  // Self-verify before publishing any tunnel: fail fast on a broken listener
  // instead of after the tunnel is up.
  const health = await fetch(`http://127.0.0.1:${state.port}/healthz/${state.routeToken}`, { signal: AbortSignal.timeout(3_000) })
    .then(async response => {
      if (!response.ok) return `HTTP ${response.status}`;
      const payload = await response.json().catch(() => undefined) as { ok?: unknown } | undefined;
      return payload?.ok === true ? undefined : "healthz did not confirm readiness";
    })
    .catch(error => error instanceof Error ? error.message : String(error));
  if (health) throw new Error(`Local Bridge health check failed: ${health}`);
}

/**
 * Drop the optimistic https URL and surface the live loopback URL instead.
 * Failure paths that keep the local server alive must never leave the panel
 * advertising a dead public endpoint.
 */
function revertToLocalUrl(): void {
  state.tunnelUrl = "";
  host().ui.refresh();
}

/**
 * Owns everything tunnel-shaped. Runs on every start AND on in-place
 * reconnects; the generation guard makes stale invocations no-ops.
 */
async function startTunnelInternal(generation: number): Promise<void> {
  if (generation !== state.tunnelGeneration || !state.server) return;
  const provider = host().config.get<string>("tunnelProvider", "ngrok");
  state.tunnelUrl = "";
  if (provider !== "ngrok") {
    state.tunnelRole = "none";
    return;
  }
  const configuredDomain = host().config.get<string>("ngrokDomain", "");
  if (!configuredDomain?.trim()) {
    // A plain `serve` with no domain configured never asked for a tunnel, so
    // this is a state, not a failure: stay local-only and say so once. The old
    // throw landed in startInternal's catch as "Tunnel failed; local Bridge
    // stays up" — an ERROR line in the activity log and the audit trail on
    // EVERY out-of-box start, burying real failures under a message the
    // operator had done nothing to earn. The Start-retry branch in
    // startInternal (tunnelRole "none", no reconnect armed) still picks the
    // tunnel up the moment a domain is saved.
    state.tunnelRole = "none";
    record("bridge", "progress", "未配置隧道域名：仅本机可用。要开公网隧道，在控制台「设置」页填写 ngrokDomain，或运行 open-bridge config set ngrokDomain <你的域名>。");
    return;
  }
  const domain = validateNgrokDomain(configuredDomain);
  if ((await probePublicBridge(domain, state.routeToken)) !== "free") {
    state.tunnelRole = "blocked";
    startPublicWatch(domain);
    // The domain is held by another instance — on this machine that is usually
    // the VS Code extension. Advertise ourselves FIRST: the adopt probe below
    // can only succeed once the holder has a row to look our token up in, and
    // without this publish it always timed out into local-only even though the
    // running tunnel could have routed us the whole time.
    await publishSelf();
    const adopted = await adoptSharedTunnel(domain);
    record(
      "ngrok",
      "completed",
      adopted && state.tunnelUrl
        ? `Public domain belongs to another instance; serving through its tunnel: ${redactedPublicUrl(state.tunnelUrl)}`
        : "Public domain belongs to another window; this Bridge stays local until that tunnel routes it.",
    );
    return;
  }
  state.tunnelRole = "owner";
  const tunnelChild = spawnTunnel(domain, generation);
  // Published only once the tunnel answers. Setting it here advertised an https
  // endpoint for every attempt — including the ones that were about to fail —
  // so `status` and the console handed out a URL that answered nothing, which is
  // the exact lie the tunnelUrl/public_url split was introduced to end. A peer
  // tunnel sets it after its own health check for the same reason.
  const publishedUrl = `https://${domain}/mcp/${state.routeToken}`;
  try {
    await waitForTunnelReady(`https://${domain}/healthz/${state.routeToken}`, tunnelChild);
    state.reconnectAttempt = 0;
    state.tunnelUrl = publishedUrl;
    host().ui.refresh();
  } catch (error) {
    if (error instanceof NgrokSpawnError) {
      if (isEndpointTakenError(error.message)) {
        // The endpoint came online in the gap between the pre-check and the
        // spawn — the holder was mid-reconnect, or it just claimed the domain.
        // Nothing here is a configuration mistake: stay local, keep watching and
        // adopt that tunnel as soon as it routes us. (This used to throw a
        // "won't retry" error and park the instance local-only for good, while
        // the working tunnel sat right next to it.)
        state.tunnelRole = "blocked";
        killTunnelTree(state.tunnel);
        state.tunnel = undefined;
        revertToLocalUrl();
        stopReconnectChain();
        startPublicWatch(domain);
        record("ngrok", "progress", "The domain went online under another instance mid-start; staying local and watching for a route.");
        await publishSelf();
        await adoptSharedTunnel(domain);
        return;
      }
      // ngrok never bound the domain (missing executable, EACCES, ...). This is
      // deterministic: surface the real cause right away instead of after the
      // public-health budget, and stay local-only. The error type is preserved
      // (NOT wrapped into a plain Error) so scheduleReconnect's instanceof
      // guard can recognize it and stop arming reconnects that can never
      // succeed — the old wrap turned that guard into dead code and produced
      // an endless 60 s spawn-retry loop.
      state.tunnelRole = "none";
      killTunnelTree(state.tunnel);
      state.tunnel = undefined;
      revertToLocalUrl();
      // The process exit that produced this error also arms a reconnect (the exit
      // handler cannot know why it died). Cancel it: a deterministic failure must
      // not spawn ngrok again, and a pending timer would do exactly that.
      stopReconnectChain();
      throw new NgrokSpawnError(
        `${error.message} · 检查 ngrokExecutable（未安装或路径不对请在控制台「设置」页修正后重试；`
        + "ERR_NGROK_9009 需关闭 ngrokUseHttpProxy）。"
        + " 这类错误与配置有关，不会自动重试：修好后点 Start，或重新运行 open-bridge serve。",
      );
    }
    if ((await probePublicBridge(domain, state.routeToken)) !== "free") {
      state.tunnelRole = "blocked";
      startPublicWatch(domain);
      revertToLocalUrl();
      record("ngrok", "progress", "Domain was claimed mid-start; staying local and watching for a route.");
    } else {
      state.tunnelRole = "none";
      killTunnelTree(state.tunnel);
      state.tunnel = undefined;
      // Revert the optimistic https URL (the panel must not advertise an
      // endpoint no tunnel answers) and DO NOT bump tunnelGeneration: the old
      // bump invalidated every future reconnect armed with the current
      // generation, so one transient failure (e.g. DNS still down right after
      // waking from sleep) permanently stopped all self-healing. The exit
      // handler is already neutralized by clearing state.tunnel above.
      revertToLocalUrl();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} · 若域名被上一会话遗留的 ngrok 占用，请在终端执行 taskkill /IM ngrok.exe /F 后重新 Start。`,
      );
    }
  }
}

/**
 * ngrok Free rejects agents that connect through an HTTP(S) proxy
 * (ERR_NGROK_9009). Inheriting the environment is the long-standing behaviour
 * and keeps working setups untouched; opt-out strips proxy variables so ngrok
 * connects directly.
 */
function ngrokProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const useProxy = host().config.get<boolean>("ngrokUseHttpProxy", true);
  if (!useProxy) {
    for (const key of Object.keys(env)) {
      if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key];
    }
  }
  return env;
}

function spawnTunnel(domain: string, generation: number): ChildProcessWithoutNullStreams {
  // An empty stored value (the page allows clearing it back to "auto") must
  // fall back to the PATH binary instead of spawning "".
  const exe = String(host().config.get<string>("ngrokExecutable", "ngrok") ?? "").trim() || "ngrok";
  const child: ChildProcessWithoutNullStreams = state.tunnel = spawn(
    exe,
    ["http", String(state.port), "--url", `https://${domain}`, "--log", "stdout"],
    // Share our console when we have one, so closing the terminal window takes
    // the agent with it (src/bridge/child-console.ts records the measurement).
    { windowsHide: windowsHideForChild(), env: ngrokProcessEnvironment() },
  );
  child.stdout.on("data", d => {
    try {
      host().log(`[ngrok] ${d.toString().trim()}`);
    } catch { /* a log write must never take the tunnel down */ }
  });
  child.stderr.on("data", d => {
    try {
      host().log(`[ngrok] ${d.toString().trim()}`);
    } catch { /* a log write must never take the tunnel down */ }
  });
  child.once("error", e => {
    if (state.tunnel !== child) return;
    state.tunnel = undefined;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      record(
        "ngrok",
        "error",
        `ngrok executable not found (${exe}). Set ngrokExecutable in the console settings page `
        + "(open-bridge config set ngrokExecutable <path>).",
      );
    } else {
      record("ngrok", "error", `ngrok failed: ${e.message}`);
    }
    host().notify("error", `ngrok failed: ${e.message}`);
    // Every spawn failure (missing executable, EACCES, EINVAL, ...) is
    // deterministic: retrying cannot heal it. Revert the optimistic public
    // URL/role so the panel does not advertise a dead https endpoint, and do
    // NOT arm a reconnect here — scheduleReconnect's catch recognizes the
    // NgrokSpawnError thrown by waitForTunnelReady and stops the chain. The
    // old fallback call to scheduleReconnect bypassed that guard and produced
    // an endless spawn-retry loop.
    state.tunnelRole = "none";
    state.tunnelUrl = "";
    host().ui.refresh();
  });
  child.once("exit", () => {
    if (state.tunnel !== child) return;
    state.tunnel = undefined;
    // The process carrying this URL is gone, so the endpoint is dead. Clearing
    // it keeps `public_url` honest while the reconnect runs; a peer tunnel
    // republishes after its own health check, and a successful reconnect
    // republishes from startTunnelInternal.
    if (state.tunnelRole !== "follower") {
      state.tunnelRole = "none";
      revertToLocalUrl();
    }
    scheduleReconnect(domain, generation);
  });
  return child;
}

async function stopInternal(notify = true): Promise<void> {
  state.stopping = true;
  state.tunnelGeneration += 1; // invalidate any pending in-place reconnect timers
  stopPublicWatch();
  stopRepublishLoop();
  stopSessionPruneLoop();
  state.tunnelRole = "none";
  state.missingPublicRounds = 0;
  // Reset the backoff too: it used to survive a stop, so the next start began
  // reconnecting at the 60 s ceiling left over from the previous session
  // instead of at the fast end of the curve.
  state.reconnectAttempt = 0;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = undefined;
  const activeTunnel = state.tunnel;
  state.tunnel = undefined;
  // The tunnel must die before any await: the hosting process can be killed
  // without warning (Ctrl-C, an IDE shutting down, a crash) and an
  // un-terminated ngrok keeps holding the domain.
  killTunnelTree(activeTunnel);
  // A crashed command with autoRestart may still hold a pending restart timer;
  // clear every one of them (not only live commands) so a timer cannot fire
  // after `stopping` resets and resurrect a process on a stopped Bridge or
  // after a workspace switch.
  cancelAllPendingRestarts();
  // Await managed process teardown so restart/rotate is transactional.
  const processStops = [...state.commands.values()]
    .filter(commandState => !commandState.done)
    .map(commandState => terminateProcess(commandState, "stopped"));
  await Promise.allSettled(processStops);
  // Await the registry withdrawal: it read-merge-writes bridge-peers.json, and
  // a fire-and-forget withdraw landing after a subsequent start()'s publish
  // could delete that window's freshly published entry (until the 30 s
  // re-publish loop heals it). The tunnel tree is already dead at this point.
  await withdrawSelf();
  const transportCloses = [...state.sessions.values()].map(session => Promise.resolve(session.transport.close()));
  await Promise.allSettled(transportCloses);
  state.sessions.clear();
  state.latestSession = undefined;
  await stopLocalServer();
  state.tunnelUrl = "";
  state.port = 0;
  state.stopping = false;
  try {
    host().ui.refresh();
  } catch { /* a stopped Bridge cannot update a UI */ }
  record("bridge", "completed", "Stopped.");
  if (notify) host().notify("info", "Open Bridge stopped.");
}

export async function start(): Promise<void> {
  return enqueueLifecycle(() => startInternal());
}

/** True when a previous teardown already released everything a stop() would. */
function isStopped(): boolean {
  return !state.server
    && !state.tunnel
    && !state.reconnectTimer
    && state.sessions.size === 0
    && ![...state.commands.values()].some(command => !command.done);
}

export async function stop(notify = true): Promise<void> {
  // The host can run BOTH its dispose callback and deactivate() on shutdown,
  // which used to queue the full teardown twice (double "Stopped.", double
  // process-kill pass). Skip the redundant second pass.
  return enqueueLifecycle(async () => {
    if (isStopped()) return;
    await stopInternal(notify);
  });
}

// --- Route token management (persisted in the host secret store, per project) ---

async function loadRouteToken(): Promise<void> {
  const key = `${ROUTE_TOKEN_KEY}.${workspaceStateSuffix()}`;
  state.routeToken = (await host().secrets.get(key)) ?? "";
  if (!state.routeToken) {
    state.routeToken = randomBytes(16).toString("hex");
    await host().secrets.store(key, state.routeToken);
  }
}

export async function rotateRouteToken(): Promise<void> {
  state.routeToken = randomBytes(16).toString("hex");
  await host().secrets.store(
    `${ROUTE_TOKEN_KEY}.${workspaceStateSuffix()}`,
    state.routeToken,
  );
}

/**
 * Re-point the published surfaces at a freshly rotated token.
 *
 * Rotation is an in-process assignment and every route compares
 * `state.routeToken` per request, so the listener never has to move: closing it
 * — the old behaviour — bought nothing but a window in which the port accepted
 * no connections, and with a tunnel up it also tore the tunnel down and
 * re-published it (on ngrok Free's one-session-per-domain budget that is a real
 * outage risk). What does carry the token is the public URL this instance
 * advertises and the peer registry other instances read, so those are refreshed
 * here, without touching traffic.
 */
export async function republishAfterRotate(): Promise<void> {
  const prefix = state.tunnelUrl.split("/mcp/")[0];
  if (prefix.startsWith("https://")) state.tunnelUrl = `${prefix}/mcp/${state.routeToken}`;
  await publishSelf();
}

/**
 * The onboarding prompt for the current instance, with its locality stated.
 *
 * `state.tunnelUrl` is the signal: it is set only while a tunnel is actually
 * published (see the public_url semantics fixed earlier), so when it is empty
 * the prompt must admit that the URL it carries is loopback-only.
 */
export function webAiPrompt(): string {
  const url = clientMcpUrl();
  if (!url) throw new Error("Start Bridge before copying the web AI prompt.");
  return buildWebAiPrompt({ url, isPublic: Boolean(state.tunnelUrl), authEnabled: authEnabled() });
}

export interface HealthReport {
  ok: boolean;
  /** One line, for the console toast and the activity log. */
  summary: string;
  /** One line per probe, in the order they ran. */
  details: string[];
}

/**
 * End-to-end health check: prove the instance is what it claims to be.
 *
 * This existed since the VS Code port but had no caller in the standalone app,
 * so nothing inside the product could ever verify that the tunnel it advertises
 * answers, or that the bearer gate really refuses anonymous requests. A gate
 * that silently fails open is worse than no gate: the operator would believe
 * they are protected. It now returns a structured report (so the console can
 * show it) and still records + notifies, keeping the activity-log trail.
 */
export async function runHealthCheck(): Promise<HealthReport> {
  const probe = async (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: string }> =>
    fetch(url, init)
      .then(async response => ({ ok: response.ok, status: response.status, body: await response.text() }))
      .catch(error => ({ ok: false, status: 0, body: error instanceof Error ? error.message : String(error) }));
  if (!state.server) {
    const summary = "Bridge 未运行，无法体检。";
    record("health", "error", summary);
    host().notify("warn", summary);
    return { ok: false, summary, details: ["实例未运行"] };
  }
  const local = await probe(`http://127.0.0.1:${state.port}/healthz/${state.routeToken}`);
  const details = [`本地端点 ${local.ok ? "正常" : "失败"}（${local.status || local.body}）`];
  const publicCheck = state.tunnelUrl
    ? await probe(state.tunnelUrl.replace(`/mcp/${state.routeToken}`, `/healthz/${state.routeToken}`), {
        headers: { "ngrok-skip-browser-warning": "true" },
        // Bounded: a tunnel edge that accepts but never answers must not hang
        // the health check (and with it the console's 体检 action) forever.
        signal: AbortSignal.timeout(8_000),
      })
    : undefined;
  details.push(publicCheck
    ? `公网隧道 ${publicCheck.ok ? "正常" : "失败"}（${publicCheck.status || publicCheck.body}）`
    : "公网隧道 未开启（仅本机可用）");
  // Verify the bearer gate is actually closed. A gate that silently fails open
  // is worse than no gate: the operator would believe they are protected. An
  // anonymous initialize must come back 401 while auth is enabled.
  const gateStatus = authEnabled()
    ? (await probe(`http://127.0.0.1:${state.port}/mcp/${state.routeToken}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health", version: "1" } },
        }),
      })).status
    : undefined;
  const gateOk = gateStatus === undefined || gateStatus === 401;
  details.push(gateStatus === undefined
    ? "Bearer 鉴权 未启用"
    : (gateOk ? "Bearer 鉴权 已生效（匿名请求 401）" : `Bearer 鉴权 异常（匿名请求返回 ${gateStatus}，预期 401）`));
  const ok = local.ok && publicCheck?.ok !== false && gateOk;
  const summary = `健康检查：本地 ${local.ok ? "正常" : "失败"}`
    + (publicCheck ? ` · 公网 ${publicCheck.ok ? "正常" : "失败"}` : " · 公网未开启")
    + (gateStatus === undefined ? " · 鉴权未启用" : ` · 鉴权${gateOk ? "已生效" : "异常"}`);
  record(
    "health",
    ok ? "completed" : "error",
    `local=${local.status} public=${publicCheck?.status ?? "n/a"}${gateStatus === undefined ? "" : ` anonymous-mcp=${gateStatus}`}`,
  );
  await host().notify("info", summary);
  return { ok, summary, details };
}
