import { host } from "../host/host.js";
import { parseHttpProbeUrl, probeHttpHealth, probeTcpPort, type ProbeNetworkScope } from "../network/safe-probe.js";
import {
  MAX_INLINE_OUTPUT,
  SERVICE_HEALTH_TIMEOUT_MS,
  SERVICE_PORT_PROBE_TIMEOUT_MS,
  SERVICE_STATUS_DEFAULT_TIMEOUT_MS,
  state,
  type ServiceDefinition,
} from "./state.js";
import { terminateProcess, processSnapshot, spawnServiceProcess, requireRestartKnob } from "./processes.js";
import { persistServices } from "./services.js";
import { availableHint } from "./error-hints.js";
import { workspacePath, workspaceStateSuffix } from "./paths.js";
import { readServiceLogRange, serviceLogFilePath } from "./service-log.js";
import type { JsonArgs } from "./json-args.js";

type Args = JsonArgs;

function probeScope(value: unknown): ProbeNetworkScope {
  const allowed = new Set<string>(["any", "loopback", "public", "loopback-and-public"]);
  return typeof value === "string" && allowed.has(value) ? (value as ProbeNetworkScope) : "any";
}

export async function checkPortTool(args: Args): Promise<unknown> {
  const hostName = String(args.host ?? "127.0.0.1");
  // `Number(undefined)` is NaN, which normalizePort reported as "port must be an
  // integer between 1 and 65535" — accurate, but it never says the argument was
  // simply absent. Name it, the way the file tools name a missing path. A port
  // that IS present and invalid still reaches normalizePort's own message.
  if (args.port === undefined || args.port === null) {
    throw new Error('Missing "port": connectivity{target:"port"} needs the port to probe. (expected \'port\': number)');
  }
  const portNumber = Number(args.port);
  const result = await probeTcpPort(hostName, portNumber, {
    scope: probeScope(args.scope),
    timeoutMs: Number(args.timeout_ms ?? 2000),
  });
  return { ...result, host: hostName, port: portNumber };
}

export async function checkHttpTool(args: Args): Promise<unknown> {
  const redirects = Number.isFinite(Number(args.max_redirects)) && Number(args.max_redirects) >= 0
    ? Number(args.max_redirects)
    : 5;
  // Same shape as checkPortTool: absence is named here instead of reaching
  // parseHttpProbeUrl as the literal text "undefined" and coming back as a
  // generic INVALID_URL. A present-but-unparseable url still gets that message.
  if (args.url === undefined || args.url === null || String(args.url).trim() === "") {
    throw new Error('Missing "url": connectivity{target:"http"} needs the endpoint to probe. (expected \'url\': string)');
  }
  return probeHttpHealth(String(args.url), {
    scope: probeScope(args.scope),
    timeoutMs: Number(args.timeout_ms ?? 5000),
    maxRedirects: redirects,
  });
}

/** Clamp the service_status timeout_ms argument: default SERVICE_STATUS_DEFAULT_TIMEOUT_MS, capped at SERVICE_HEALTH_TIMEOUT_MS. */
function serviceStatusTimeoutMs(value: unknown): number {
  const requested = Number(value);
  const clamped = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : SERVICE_STATUS_DEFAULT_TIMEOUT_MS;
  return Math.min(clamped, SERVICE_HEALTH_TIMEOUT_MS);
}

/**
 * Race a probe against a hard timer so one wedged health check cannot stall
 * the whole service_status response (P1-2). The probe keeps running in the
 * background; only the response is cut off.
 */
async function probeWithTimeout<T>(
  probe: Promise<T>,
  timeoutMs: number,
  errorText: string,
): Promise<T | { ok: false; timed_out: true; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<{ ok: false; timed_out: true; error: string }>(resolve => {
        timer = setTimeout(() => resolve({ ok: false, timed_out: true, error: errorText }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Per-service operation chains: concurrent start/stop/restart on the same
 * service run exclusively, so the isServiceRunning check and the commandId
 * write-back cannot interleave (TOCTOU: two starts used to spawn two
 * processes, one of them orphaned because only the last id was remembered).
 */
const serviceOpTails = new Map<string, Promise<unknown>>();

function serializeServiceOp<T>(name: string, op: () => Promise<T>): Promise<T> {
  const tail = (serviceOpTails.get(name) ?? Promise.resolve()).then(op, op);
  serviceOpTails.set(name, tail.catch(() => undefined));
  void tail.catch(() => undefined);
  return tail;
}

export function saveService(args: Args): Promise<unknown> {
  return serializeServiceOp(String(args.name ?? ""), () => saveServiceInner(args));
}

async function saveServiceInner(args: Args): Promise<unknown> {
  const serviceName = String(args.name ?? "").trim();
  if (!serviceName) throw new Error("Service name is required. (expected 'name': string)");
  const command = typeof args.command === "string" && args.command.trim().length > 0 ? args.command : "";
  if (!command) throw new Error("Service command is required and must be a non-empty string. (expected 'command': string)");
  if (args.port !== undefined) {
    const portNumber = Number(args.port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      throw new Error("port must be an integer between 1 and 65535. (expected 'port': number)");
    }
  }
  // max_restarts / restart_delay_ms previously went through bare Number():
  // a string like "abc" produced NaN that silently persisted, disabling
  // autoRestart (restartCount < NaN is always false) or turning the restart
  // delay into an immediate crash-loop (setTimeout(NaN) fires at ~0 ms).
  // requireRestartKnob is now shared with set_process_policy, which writes the
  // same two fields onto a live process and used to let NaN through untouched.
  const maxRestarts = args.max_restarts === undefined
    ? undefined
    : requireRestartKnob(args.max_restarts, "max_restarts");
  const restartDelayMs = args.restart_delay_ms === undefined
    ? undefined
    : requireRestartKnob(args.restart_delay_ms, "restart_delay_ms");
  let healthUrl: string | undefined;
  if (typeof args.health_url === "string" && args.health_url.trim() !== "") {
    const candidate = args.health_url.trim();
    // Validate at save time: one malformed health_url used to fail the whole
    // service_status call later (probeHttpHealth rejects on unparseable URLs).
    try {
      parseHttpProbeUrl(candidate);
    } catch (error) {
      throw new Error(`health_url must be an absolute http(s) URL: ${error instanceof Error ? error.message : String(error)} (expected 'health_url': string)`);
    }
    healthUrl = candidate;
  }
  const env = args.env && typeof args.env === "object" && !Array.isArray(args.env)
    ? (Object.fromEntries(Object.entries(args.env).filter(([, value]) => typeof value === "string")) as Record<string, string>)
    : {};
  // Re-saving a running service replaces its definition and the new object has
  // no commandId: the old process kept running with no handle (unstoppable,
  // invisible to service_status) and a later start_service spawned a second
  // instance. Stop the stale process so the new definition owns the service.
  // terminateProcess runs UNCONDITIONALLY (not only while !done): a crashed
  // command whose auto-restart timer is still pending would otherwise
  // resurrect the OLD command after the re-save (terminateProcess clears
  // scheduled restarts even for an already-exited process).
  const existing = state.services.get(serviceName);
  if (existing?.commandId) {
    const proc = state.commands.get(existing.commandId);
    if (proc) await terminateProcess(proc, "stopped");
  }
  state.services.set(serviceName, {
    command,
    cwd: String(args.cwd ?? "."),
    env,
    group: String(args.group ?? "default"),
    port: args.port === undefined ? undefined : Number(args.port),
    healthUrl,
    logFile: typeof args.log_file === "string" && args.log_file.trim() !== "" ? String(args.log_file).trim() : undefined,
    autoRestart: args.auto_restart === true,
    maxRestarts: maxRestarts ?? 3,
    restartDelayMs: restartDelayMs ?? 1000,
  });
  persistServices();
  host().ui.refresh();
  return { name: serviceName, saved: true };
}

export function listServices(): unknown {
  return [...state.services.entries()].map(([name, service]) => ({
    name,
    command: service.command,
    cwd: service.cwd,
    group: service.group,
    port: service.port,
    health_url: service.healthUrl,
    log_file: service.logFile,
    command_id: service.commandId,
    auto_restart: service.autoRestart,
    max_restarts: service.maxRestarts,
    restart_delay_ms: service.restartDelayMs,
  }));
}

/**
 * Saved services for the console: definitions plus live process state, with
 * no health probes (unlike serviceStatus, which is bounded per service and
 * meant for on-demand checks). Keeps the panel a cheap 5 s poll.
 */
/** One saved service as the console reads it (no health probes; see serviceStatus). */
export interface ServiceView {
  name: string;
  group: string;
  command: string;
  cwd: string;
  port: number | null;
  health_url: string | null;
  log_file: string | null;
  running: boolean;
  command_id: string | null;
}

export function listServiceViews(): ServiceView[] {
  return [...state.services.entries()].map(([name, service]) => ({
    name,
    group: service.group ?? "",
    command: service.command,
    cwd: service.cwd,
    port: service.port ?? null,
    health_url: service.healthUrl ?? null,
    log_file: service.logFile ?? null,
    running: isServiceRunning(service),
    command_id: service.commandId ?? null,
  }));
}

function isServiceRunning(service: ServiceDefinition): boolean {
  return Boolean(service.commandId && state.commands.get(service.commandId) && !state.commands.get(service.commandId)!.done);
}

export function startService(args: Args): Promise<unknown> {
  return serializeServiceOp(String(args.name ?? ""), () => startServiceInner(args));
}

async function startServiceInner(args: Args): Promise<unknown> {
  const serviceName = String(args.name ?? "");
  const service = state.services.get(serviceName);
  if (!service) throw new Error(`Unknown service: "${serviceName}".${availableHint("Saved services", state.services.keys())}`);
  if (isServiceRunning(service)) {
    return { name: serviceName, command_id: service.commandId, status: "already_running" };
  }
  const id = await spawnServiceProcess(service, serviceName);
  service.commandId = id;
  return { name: serviceName, command_id: id, status: "running" };
}

export function stopService(args: Args): Promise<unknown> {
  return serializeServiceOp(String(args.name ?? ""), () => stopServiceInner(args));
}

async function stopServiceInner(args: Args): Promise<unknown> {
  const serviceName = String(args.name ?? "");
  const service = state.services.get(serviceName);
  if (!service) throw new Error(`Unknown service: "${serviceName}".${availableHint("Saved services", state.services.keys())}`);
  if (!service.commandId) return { name: serviceName, command_id: null, stopped: false, status: "stopped" };
  const commandId = service.commandId;
  const proc = state.commands.get(commandId);
  const stopped = proc ? await terminateProcess(proc, "stopped") : true;
  service.commandId = undefined;
  return { name: String(args.name), command_id: commandId, stopped, status: "stopped" };
}

export function restartService(args: Args): Promise<unknown> {
  return serializeServiceOp(String(args.name ?? ""), () => restartServiceInner(args));
}

async function restartServiceInner(args: Args): Promise<unknown> {
  const serviceName = String(args.name ?? "");
  const service = state.services.get(serviceName);
  if (!service) throw new Error(`Unknown service: "${serviceName}".${availableHint("Saved services", state.services.keys())}`);
  if (service.commandId) {
    const old = state.commands.get(service.commandId);
    // terminateProcess now clears a pending auto-restart even for an already
    // exited process, so a crashed service cannot resurrect alongside the
    // fresh instance spawned below.
    if (old) await terminateProcess(old, "stopped");
    service.commandId = undefined;
  }
  const id = await spawnServiceProcess(service, serviceName);
  service.commandId = id;
  return { name: serviceName, command_id: id, restarted: true };
}

export function deleteService(args: Args): Promise<unknown> {
  return serializeServiceOp(String(args.name ?? ""), () => deleteServiceInner(args));
}

async function deleteServiceInner(args: Args): Promise<unknown> {
  const serviceName = String(args.name ?? "");
  const service = state.services.get(serviceName);
  if (!service) throw new Error(`Unknown service: "${serviceName}".${availableHint("Saved services", state.services.keys())}`);
  const proc = service.commandId ? state.commands.get(service.commandId) : undefined;
  const stopped = proc ? await terminateProcess(proc, "stopped") : false;
  service.commandId = undefined;
  state.services.delete(serviceName);
  persistServices();
  host().ui.refresh();
  return { name: serviceName, deleted: true, stopped };
}

export async function serviceStatus(args: Args): Promise<unknown> {
  const nameFilter = typeof args.name === "string" ? args.name : "";
  const groupFilter = typeof args.group === "string" ? args.group : "";
  const timeoutMs = serviceStatusTimeoutMs(args.timeout_ms);
  return Promise.all(
    [...state.services.entries()]
      .filter(([name, service]) => (!nameFilter || name === nameFilter) && (!groupFilter || service.group === groupFilter))
      .map(async ([name, service]) => {
        const proc = service.commandId ? state.commands.get(service.commandId) : undefined;
        // P1-2: each health check races a per-service timer; a wedged check
        // reports timed_out for its own service instead of stalling the response.
        // A probe rejection (e.g. a malformed legacy health_url) is downgraded
        // to that service's health error instead of failing the whole call.
        const health = await (async (): Promise<unknown> => {
          try {
            if (service.healthUrl) {
              return await probeWithTimeout(
                probeHttpHealth(service.healthUrl, { scope: "any", timeoutMs: Math.min(timeoutMs + 250, SERVICE_HEALTH_TIMEOUT_MS), maxRedirects: 5 }),
                timeoutMs,
                `health check timed out after ${timeoutMs} ms`,
              );
            }
            if (service.port) {
              return await probeWithTimeout(
                // The legacy TCP probe cap (SERVICE_PORT_PROBE_TIMEOUT_MS) still bounds the probe itself.
                probeTcpPort("127.0.0.1", service.port, { scope: "any", timeoutMs: Math.min(timeoutMs + 250, SERVICE_PORT_PROBE_TIMEOUT_MS) }),
                timeoutMs,
                `port probe timed out after ${timeoutMs} ms`,
              );
            }
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          return undefined;
        })();
        return {
          name,
          group: service.group,
          command_id: service.commandId,
          status: proc ? (proc.done ? "completed" : "running") : "stopped",
          process: proc ? processSnapshot(proc) : undefined,
          port: service.port,
          health_url: service.healthUrl,
          health,
          checked_at: new Date().toISOString(),
        };
      }),
  );
}

export async function startAllServices(args: Args): Promise<unknown> {
  const group = typeof args.group === "string" ? args.group : "";
  const selected = [...state.services.entries()].filter(([, service]) => !group || service.group === group);
  // Route through startService so every per-service op chain (TOCTOU guard) applies.
  const startOne = ([name]: [string, ServiceDefinition]) => startService({ name });
  if (args.parallel === false) {
    return selected.reduce(async (promise, entry) => [...await promise, await startOne(entry)], Promise.resolve([] as unknown[]));
  }
  return Promise.all(selected.map(startOne));
}

export async function stopAllServices(args: Args): Promise<unknown> {
  const group = typeof args.group === "string" ? args.group : "";
  const stopped: unknown[] = [];
  for (const [name, service] of state.services) {
    if (group && service.group !== group) continue;
    stopped.push(await serializeServiceOp(name, async () => {
      const proc = service.commandId ? state.commands.get(service.commandId) : undefined;
      const result = proc ? await terminateProcess(proc, "stopped") : false;
      service.commandId = undefined;
      return { name, command_id: proc?.id ?? null, stopped: result };
    }));
  }
  return stopped;
}

export async function readServiceLogTool(args: Args): Promise<Record<string, unknown>> {
  const serviceName = String(args.name ?? "").trim();
  const service = state.services.get(serviceName);
  if (!service) throw new Error(`Unknown service: "${serviceName}".${availableHint("Saved services", state.services.keys())}`);
  const maxBytesValue = Number(args.max_bytes);
  const maxBytes = Number.isFinite(maxBytesValue) && maxBytesValue > 0 ? Math.floor(maxBytesValue) : MAX_INLINE_OUTPUT;
  let offset: number | undefined;
  if (args.offset !== undefined) {
    const value = Number(args.offset);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("offset must be a non-negative safe integer.");
    offset = value;
  }
  const storageDir = host().storageDir() ?? "";
  const logFile = storageDir || service.logFile
    ? serviceLogFilePath({ name: serviceName, logFile: service.logFile }, { storageDir, workspaceHash: workspaceStateSuffix(), resolvePath: workspacePath })
    : undefined;
  if (!logFile) throw new Error("No storage location is available for this service log.");
  const read = await readServiceLogRange(logFile, offset, maxBytes);
  return { name: serviceName, log_file: logFile, ...read };
}

/** Service control for the console 服务 tab and POST /api/services/action. */
export async function controlService(
  action: "start" | "stop" | "restart",
  name: string,
  onChanged?: () => void,
): Promise<unknown> {
  const service = state.services.get(name);
  if (!service) throw new Error(`Unknown service: "${name}".${availableHint("Saved services", state.services.keys())}`);
  let result: unknown;
  if (action === "start") result = await startService({ name });
  else if (action === "stop") result = await stopService({ name });
  else result = await restartService({ name });
  onChanged?.();
  return result;
}
