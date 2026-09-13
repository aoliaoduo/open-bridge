import { host } from "../host/host.js";
import { SERVICES_STATE_PREFIX, state } from "./state.js";
import { requireRestartKnob } from "./processes.js";

let servicePersistTail: Promise<void> = Promise.resolve();

/** Persist saved service definitions (without live command ids) to global state, per workspace. */
export function persistServices(): void {
  const snapshot = Object.fromEntries(
    [...state.services.entries()].map(([name, service]) => [name, { ...service, commandId: undefined }]),
  );
  const key = `${SERVICES_STATE_PREFIX}${state.activeWorkspaceRoot || "unbound"}`;
  servicePersistTail = servicePersistTail
    .then(() => host().globalState.update(key, snapshot))
    .catch(() => undefined);
}

/**
 * One stored restart knob: same acceptance as the two live entries
 * (save_service, set_process_policy) via requireRestartKnob, but a corrupt
 * stored value falls back to the default instead of throwing — loadServices
 * must never let one bad entry abort the whole load (see below).
 */
function storedKnob(raw: unknown, key: "max_restarts" | "restart_delay_ms", fallback: number): number {
  try {
    return requireRestartKnob(raw ?? fallback, key);
  } catch {
    return fallback;
  }
}

/**
 * Load saved service definitions for the active workspace. Defensive like
 * loadTodoStore/loadUsageStats: one malformed stored value (schema drift from
 * an older version, partial write, manual edit) must not crash activate() —
 * bad entries are skipped instead of taking down the whole extension.
 */
export function loadServices(): void {
  const key = `${SERVICES_STATE_PREFIX}${state.activeWorkspaceRoot || "unbound"}`;
  try {
    const stored = host().globalState.get<unknown>(key, {});
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    for (const [name, raw] of Object.entries(stored as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const service = raw as Record<string, unknown>;
      const command = typeof service.command === "string" ? service.command : "";
      if (!command) continue;
      state.services.set(name, {
        command,
        cwd: String(service.cwd ?? "."),
        env: service.env && typeof service.env === "object" && !Array.isArray(service.env)
          ? (service.env as Record<string, string>)
          : {},
        group: String(service.group ?? "default"),
        port: service.port === undefined ? undefined : Number(service.port),
        healthUrl: typeof service.healthUrl === "string" ? service.healthUrl : undefined,
        logFile: typeof service.logFile === "string" ? service.logFile : undefined,
        autoRestart: service.autoRestart === true,
        maxRestarts: storedKnob(service.maxRestarts, "max_restarts", 3),
        restartDelayMs: storedKnob(service.restartDelayMs, "restart_delay_ms", 1000),
      });
    }
  } catch {
    // Never let stored state break extension activation.
  }
}
