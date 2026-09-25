import { host } from "../../host/host.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ProcessOutputRead } from "../../process/output-buffer.js";
import { ProcessOutputBuffer } from "../../process/output-buffer.js";
import { resolveShell, type ShellSpec } from "../../shell/shell-provider.js";
import { killWindowsProcessFamily } from "../../process/win-family-kill.js";

// Re-exported for shell-sessions.ts and future callers: the family kill lives in
// ../process/win-family-kill.ts (host-free) so the CLI stop fallback can share it.
export { killWindowsProcessFamily } from "../../process/win-family-kill.js";
import { maybeStripAnsi } from "../../process/ansi.js";
import { isBashLikeShell, wrapWithTeeAppend } from "../../process/tee-capture.js";
import { requireValidOffset, requireValidStream } from "../../mcp/argument-checks.js";
import { windowsHideForChild } from "../../process/child-console.js";
import { reassertServeConsoleTitle } from "../lifecycle/console-title.js";
import {
  MAX_CAPTURED_OUTPUT,
  MAX_INLINE_OUTPUT,
  COMMAND_RETENTION_MS,
  notifyLatestLogging,
  record,
  redactSensitiveText,
  state,
  type CommandState,
  type ServiceDefinition,
} from "../state.js";
import { workspacePath, workspaceStateSuffix } from "../paths.js";
import { prepareServiceLog, serviceLogFilePath } from "./service-log.js";

export const shellSpec = (): ShellSpec => resolveShell();

/**
 * Validate one of the two auto-restart knobs and return it.
 *
 * `save_service` and `set_process_policy` both write `maxRestarts` /
 * `restartDelayMs`, and a bare `Number()` on a string like "abc" yields NaN that
 * silently persists: `restartCount < NaN` is always false, so auto-restart is
 * quietly disabled, and `setTimeout(NaN)` fires at ~0 ms, which turns one crash
 * into a crash-loop. One validator for both entry points so they cannot drift
 * apart again — save_service already refused this shape while set_process_policy
 * ran it through `Math.max(0, NaN)`, which is NaN, not 0.
 *
 * A negative value is an error rather than a clamp: the two entry points
 * disagreed about it, and "restart -5 times" is a caller bug worth naming.
 */
export function requireRestartKnob(value: unknown, key: "max_restarts" | "restart_delay_ms"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer. (expected '${key}': number)`);
  }
  return parsed;
}

/**
 * Collect an `env` argument as a string map, dropping non-string values.
 *
 * Shared by the process tools and save_service: both accept the same `env`
 * shape and each used to carry its own copy of this filter. Lives here because
 * both modules already import from this one.
 */
export function stringEnv(args: { env?: unknown }): Record<string, string> {
  return args.env && typeof args.env === "object" && !Array.isArray(args.env)
    ? (Object.fromEntries(Object.entries(args.env).filter(([, value]) => typeof value === "string")) as Record<string, string>)
    : {};
}

/** Drop command records that finished more than the retention window ago. */
export function pruneCommands(): void {
  const cutoff = Date.now() - COMMAND_RETENTION_MS;
  for (const [id, command] of state.commands) {
    if (command.done && (command.endedAt ?? command.startedAt) < cutoff) {
      // Safety net: a retained command must not keep its resource locks.
      command.releaseResourceLocks?.();
      state.commands.delete(id);
    }
  }
}

/**
 * Wire a freshly spawned child into a `CommandState`: create the three capture
 * buffers, attach the stdout/stderr append closures, guard stdin against EPIPE,
 * and run the spawn-error and close state machines both spawners share.
 *
 * spawnManaged (a fresh shell per command) and shell-sessions' spawnSessionShell
 * (one persistent login shell) used to hand-write this wiring in two copies and
 * had already drifted. One helper, parameterized by the few honest differences,
 * keeps the final-state machine single-sourced: both callers finalize a finished
 * command exactly once, whoever marked it done first.
 */
export function wireSpawnedChild(
  child: CommandState["child"],
  base: Omit<CommandState, "child" | "output" | "stdoutOutput" | "stderrOutput">,
  options: {
    /** Managed commands record the failure on the process event channel; session shells surface it to open_shell instead. */
    logSpawnError?: boolean;
    /** Managed commands name a non-zero self-exit "crashed"; session shells always report "exited". */
    crashOnNonZeroExit?: boolean;
    /** Caller-specific close handling (records, exit notify, auto-restart, UI refresh); runs after the shared finalize. */
    onClose?: (commandState: CommandState, code: number | null) => void;
  },
): CommandState {
  const commandState: CommandState = {
    ...base,
    child,
    output: new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT),
    stdoutOutput: new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT),
    stderrOutput: new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT),
  };
  const append = (stream: "stdout" | "stderr") => (d: Buffer | string): void => {
    const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
    commandState.output.append(chunk);
    (stream === "stdout" ? commandState.stdoutOutput : commandState.stderrOutput).append(chunk);
  };
  child.stdout.on("data", append("stdout"));
  child.stderr.on("data", append("stderr"));
  // A child that exits (or closes its stdin) mid-write makes stdin emit
  // 'error'; without a listener that surfaces as an uncaught exception in the
  // Bridge process instead of a normal process-exit path. Managed commands
  // report it through the close handler below; session shells through isAlive
  // and the next send_to_shell.
  child.stdin.on("error", () => { /* the child is gone; the callers' own surfaces report it */ });
  child.on("error", error => {
    if (options.logSpawnError) record("process", "error", `${commandState.id}: ${error.message}`);
    commandState.spawnError = error.message;
    // Spawn failures (ENOENT/EACCES) emit 'error' and may never emit 'close':
    // mark the command finished so foreground callers cannot wait out the full
    // timeout on a process that never started (ghost-running bug), and so
    // open_shell cannot address a shell that never started.
    if (!commandState.done) {
      commandState.done = true;
      commandState.exitCode = null;
      commandState.endedAt = Date.now();
      commandState.lastEvent = commandState.requestedStop ?? "spawn_error";
      commandState.releaseResourceLocks?.();
    }
  });
  child.on("close", code => {
    // The command may already be final when 'close' arrives:
    //  - Node (v24 observed; ≥18.2 in general) emits BOTH 'error' and 'close'
    //    after a failed spawn. The 'error' handler above already marked the
    //    command done with lastEvent "spawn_error"; the trailing 'close'
    //    carries a meaningless UV errno (e.g. -4058 on Windows) that must not
    //    overwrite that state — doing so reported an invented "exit code", and
    //    the autoRestart branch then scheduled futile restarts for a process
    //    that can never start (missing shell/binary/cwd).
    //  - closeShell marks an exiting session shell done itself (lastEvent
    //    "shell_closed") when the graceful path times out; the child's own
    //    later 'close' must not overwrite that record either.
    if (commandState.done) return;
    commandState.done = true;
    commandState.exitCode = code;
    commandState.endedAt = Date.now();
    commandState.lastEvent = commandState.requestedStop
      ?? (code === 0 || !options.crashOnNonZeroExit ? "exited" : "crashed");
    // The child had this console and wrote its own title into it (cmd.exe puts its
    // image path there, npm writes "npm …"): take the window back.
    reassertServeConsoleTitle();
    options.onClose?.(commandState, code);
  });
  return commandState;
}

export function spawnManaged(
  commandText: string,
  cwd: string,
  env: Record<string, string>,
  id: string,
  restartCount = 0,
  policy?: Partial<CommandState>,
  options?: { teeLogPath?: string },
): CommandState {
  const spec = shellSpec();
  // Service mode appends merged output to a persisted service log (tee -a) that
  // read_service_log reads back; lifecycle control (kill/stdin/exit code) stays
  // with us. Tee wrapping needs bash syntax (pipe + PIPESTATUS), so on a
  // non-bash shell (PowerShell/cmd) the mirror is skipped instead of spawning a
  // broken command.
  const canTee = isBashLikeShell(spec.file);
  if (options?.teeLogPath && !canTee) {
    record(
      "process",
      "progress",
      `Output mirror (visible terminal / service log) requires a bash-like shell (configured: ${spec.file}); spawning without it.`,
    );
  }
  const spawnText = options?.teeLogPath && canTee
    ? wrapWithTeeAppend(commandText, options.teeLogPath)
    : commandText;
  const child = spawn(spec.file, [...spec.args, spawnText], {
    cwd,
    // A service that outlives the terminal that started it is an orphan
    // holding a port; share our console so closing the window takes it along.
    windowsHide: windowsHideForChild(),
    env: { ...process.env, ...env, OPEN_BRIDGE_COMMAND_ID: id },
  });
  const commandState = wireSpawnedChild(
    child,
    {
      id,
      teeLogPath: options?.teeLogPath,
      done: false,
      exitCode: null,
      command: commandText,
      cwd,
      env,
      startedAt: Date.now(),
      restartCount,
      autoRestart: policy?.autoRestart ?? false,
      maxRestarts: policy?.maxRestarts ?? 3,
      restartDelayMs: policy?.restartDelayMs ?? 1000,
      lastEvent: "started",
    },
    {
      logSpawnError: true,
      crashOnNonZeroExit: true,
      onClose: (finalState, code) => {
        record("process", "completed", `${id} ${finalState.lastEvent} with code ${String(code)}`);
        // P1-1: best-effort push so a connected client hears about the exit
        // without polling; only non-zero, unrequested exits notify as errors.
        notifyLatestLogging(
          finalState.requestedStop || code === 0 ? "info" : "error",
          exitNotification(finalState),
        );
        if (
          finalState.autoRestart &&
          !finalState.requestedStop &&
          code !== 0 &&
          finalState.restartCount < finalState.maxRestarts &&
          !state.stopping
        ) {
          finalState.lastEvent = "restart_scheduled";
          notifyLatestLogging(
            "warning",
            `${exitNotification(finalState)} — restart scheduled (attempt ${finalState.restartCount + 1}/${finalState.maxRestarts}, in ${finalState.restartDelayMs} ms)`,
          );
          finalState.restartTimer = setTimeout(() => {
            finalState.restartTimer = undefined;
            // A stop/terminate that lands during the delay window must win over
            // the scheduled restart (terminateProcess marks requestedStop).
            if (state.stopping || finalState.requestedStop) return;
            if (state.commands.get(finalState.id) !== finalState) return;
            const replacement = spawnManaged(
              finalState.command,
              finalState.cwd,
              env,
              finalState.id,
              finalState.restartCount + 1,
              finalState,
              { teeLogPath: finalState.teeLogPath },
            );
            // The resource stays claimed across a restart: hand the lock handle to
            // the replacement so its own exit still releases it.
            replacement.releaseResourceLocks = finalState.releaseResourceLocks;
            finalState.releaseResourceLocks = undefined;
            state.commands.set(finalState.id, replacement);
          }, finalState.restartDelayMs);
        }
        // Resource locks are held for the process's lifetime. A scheduled restart
        // keeps them (the resource is still claimed); releaseResourceLocks is
        // idempotent, so the hold-timeout backstop cannot double-release.
        if (!finalState.restartTimer) finalState.releaseResourceLocks?.();
      },
    },
  );
  record("process", "running", `Started ${id}: ${redactSensitiveText(commandText)} (cwd: ${cwd})`);
  return commandState;
}

/** P1-1 notification text for a finished command (redacted command preview, bounded). */
function exitNotification(commandState: CommandState): string {
  const preview = redactSensitiveText(commandState.command).slice(0, 200);
  return `[ob-exit] ${commandState.id.slice(0, 8)} ${preview} exited code=${String(commandState.exitCode)} (${commandState.lastEvent}) — full output: read_process_output command_id=${commandState.id}`;
}

/** Resolve the persisted log file for a service (explicit log_file wins; else the globalStorage default). Shared by the spawner here and readServiceLogTool. */
export function serviceLogPathFor(service: ServiceDefinition, serviceName: string): string | undefined {
  const storageDir = host().storageDir() ?? "";
  if (!storageDir && !service.logFile) return undefined;
  return serviceLogFilePath({ name: serviceName, logFile: service.logFile }, {
    storageDir,
    workspaceHash: workspaceStateSuffix(),
    resolvePath: workspacePath,
  });
}

/**
 * Cancel any pending auto-restart for finished commands with the same command
 * text. Called before spawning a service instance: without this, a crash
 * followed by a manual start during the restart-delay window would resurrect
 * the old id and run two instances side by side.
 */
function cancelPendingRestarts(commandText: string): void {
  for (const command of state.commands.values()) {
    if (
      command.done &&
      command.lastEvent === "restart_scheduled" &&
      command.restartTimer &&
      command.command === commandText
    ) {
      cancelPendingRestart(command);
      command.autoRestart = false;
      command.lastEvent = "restart_cancelled";
      record("process", "progress", `${command.id} pending auto-restart cancelled (fresh instance starting).`);
    }
  }
}

/**
 * Cancel one pending auto-restart AND release the resource locks it was holding.
 *
 * The two must happen together. The close handler deliberately keeps a scheduled
 * restart's `releaseResourceLocks` alive (the resource is still claimed by the
 * process that is about to come back), and `dispatcher.handOffToProcess` has
 * already disarmed the hold-timeout backstop — so once the restart is cancelled,
 * nothing else ever calls that handle. The lock then outlives its process for
 * good: every later call declaring the same `resource_keys` waits out the full
 * `concurrency.waitTimeoutMs` and fails with "another tool call is still holding
 * it", while the console keeps showing a dead command as the holder. When
 * `restart_process` had already replaced the CommandState in `state.commands`,
 * the only reference to the handle was gone and even `pruneCommands`' safety
 * net could not free it.
 *
 * Idempotent via the release handle's own `released` flag, so a later close or
 * `terminateProcess` calling it again is a no-op.
 */
export function cancelPendingRestart(command: CommandState): void {
  if (command.restartTimer) {
    clearTimeout(command.restartTimer);
    command.restartTimer = undefined;
    if (!command.requestedStop) command.requestedStop = "stopped";
  }
  command.releaseResourceLocks?.();
}

/**
 * Cancel a scheduled auto-restart WITHOUT marking the command stopped — the
 * `set_process_policy {auto_restart: false}` shape. The command crashed and the
 * operator only declined to bring it back; stamping `requestedStop` here would
 * rewrite that crash into a requested stop in every snapshot (`exit_code` null,
 * `termination_reason: "stopped"`). The release half of `cancelPendingRestart`'s
 * contract still applies in full: the dispatcher's hand-off disarmed the
 * hold-timeout backstop, so cancelling the restart must release the resource
 * lease itself, or the lock outlives its process until the hourly prune.
 *
 * Guarded on `restartTimer` by the caller: a live process holding a hand-off
 * lease has no scheduled restart, and this must not release the lease of a
 * process that is still running.
 */
export function cancelScheduledRestart(command: CommandState): void {
  if (!command.restartTimer) return;
  clearTimeout(command.restartTimer);
  command.restartTimer = undefined;
  command.lastEvent = "restart_cancelled";
  command.releaseResourceLocks?.();
}

/**
 * Clear EVERY pending auto-restart timer, including commands that already
 * exited (`done === true`) with a scheduled restart. Bridge stop / workspace
 * switch only terminates live commands; without this sweep a crashed command's
 * timer could fire after `stopping` resets and spawn an orphan process on a
 * stopped Bridge.
 */
export function cancelAllPendingRestarts(): void {
  for (const command of state.commands.values()) {
    if (!command.restartTimer) continue;
    const wasScheduled = command.lastEvent === "restart_scheduled";
    cancelPendingRestart(command);
    if (wasScheduled) {
      command.lastEvent = "restart_cancelled";
      record("process", "progress", `${command.id} pending auto-restart cancelled (bridge stopped).`);
    }
  }
}

/** Spawn the shell command for a saved service definition and register it (P1-3: output tees into the service log). */
export async function spawnServiceProcess(service: ServiceDefinition, serviceName: string): Promise<string> {
  cancelPendingRestarts(service.command);
  const id = randomBytes(8).toString("hex");
  const logPath = serviceLogPathFor(service, serviceName);
  if (logPath) await prepareServiceLog(logPath);
  const commandState = spawnManaged(
    service.command,
    workspacePath(service.cwd),
    service.env,
    id,
    0,
    {
      autoRestart: service.autoRestart,
      maxRestarts: service.maxRestarts,
      restartDelayMs: service.restartDelayMs,
    },
    logPath ? { teeLogPath: logPath } : undefined,
  );
  state.commands.set(id, commandState);
  return id;
}

async function waitForProcessClose(commandState: CommandState, timeoutMs = 5000): Promise<boolean> {
  if (commandState.done) return true;
  return await new Promise(resolve => {
    const timer = setTimeout(() => {
      // Timeout wins: detach the listener so a later 'close' cannot leak it,
      // and report whether the child finished in the meantime.
      commandState.child.off("close", onClose);
      resolve(commandState.done);
    }, timeoutMs);
    // 'once' self-removes when it fires; only the timeout path must detach.
    const onClose = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    commandState.child.once("close", onClose);
  });
}

/** Kill the shell and every child it launched. Git Bash otherwise leaves jobs running on Windows. */
export async function terminateProcess(
  commandState: CommandState,
  reason: NonNullable<CommandState["requestedStop"]>,
  options: { closeTimeoutMs?: number } = {},
): Promise<boolean> {
  // Mark first, even when the process already exited: a scheduled auto-restart
  // must never survive a stop/restart/delete request (it would resurrect the
  // process after the early return below). The helper also releases the resource
  // locks the cancelled restart was holding — the early return below means a
  // dead-with-pending-restart command would otherwise never let them go.
  commandState.autoRestart = false;
  commandState.requestedStop = reason;
  // Cancel a scheduled restart WITHOUT releasing the lease here. Two cases
  // differ. An already-exited command with a restart pending: the close
  // handler kept the lease alive for the restart that is now cancelled, and
  // no second close will come, so the cancellation itself must release. A
  // LIVE process: the lease must survive the request — the process may
  // outlive this call (the close budget, or a kill that fails outright), and
  // its resource stays claimed until the close handler releases it, the same
  // rule restartProcess obeys by transferring the handle before terminating.
  if (commandState.restartTimer) {
    clearTimeout(commandState.restartTimer);
    commandState.restartTimer = undefined;
    commandState.releaseResourceLocks?.();
  }
  if (commandState.done) return true;
  const pid = commandState.child.pid;
  try {
    if (process.platform === "win32" && pid) {
      await killWindowsProcessFamily(pid, shellSpec().file);
    } else {
      commandState.child.kill();
    }
  } catch {
    if (!commandState.child.killed) commandState.child.kill();
  }
  return await waitForProcessClose(commandState, options.closeTimeoutMs);
}

export function processSnapshot(s: CommandState): Record<string, unknown> {
  const stopped = s.done || Boolean(s.requestedStop);
  const output = s.output.state();
  return {
    command_id: s.id,
    command: s.command,
    cwd: s.cwd,
    pid: s.child.pid,
    shell_alive: !stopped && !s.child.killed,
    status: s.done ? "completed" : "running",
    exit_code: s.requestedStop ? null : s.exitCode,
    termination_reason: s.requestedStop,
    started_at: new Date(s.startedAt).toISOString(),
    ended_at: s.endedAt ? new Date(s.endedAt).toISOString() : undefined,
    uptime_ms: (s.endedAt ?? Date.now()) - s.startedAt,
    restart_count: s.restartCount,
    auto_restart: s.autoRestart,
    max_restarts: s.maxRestarts,
    restart_delay_ms: s.restartDelayMs,
    last_event: s.lastEvent,
    ...(s.spawnError ? { spawn_error: s.spawnError } : {}),
    output_bytes: output.totalBytes,
    stdout_bytes: s.stdoutOutput.state().totalBytes,
    stderr_bytes: s.stderrOutput.state().totalBytes,
    output_buffer_start: output.bufferStartOffset,
    output_available_bytes: output.availableBytes,
    dropped_bytes: output.droppedBytes,
  };
}

export function processResult(
  s: CommandState,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...processSnapshot(s), ...extra };
}

export function outputRead(
  s: CommandState,
  offsetValue: unknown,
  maxBytesValue: unknown,
  streamValue?: unknown,
  stripAnsiValue?: unknown,
): Record<string, unknown> {
  const stream = streamValue === undefined ? "merged" : String(streamValue);
  requireValidStream(stream);
  const buffer = stream === "stdout" ? s.stdoutOutput : stream === "stderr" ? s.stderrOutput : s.output;
  const offset = offsetValue === undefined ? buffer.state().bufferStartOffset : Number(offsetValue);
  const requested = maxBytesValue === undefined ? MAX_INLINE_OUTPUT : Number(maxBytesValue);
  requireValidOffset(offset);
  if (!Number.isSafeInteger(requested) || requested < 0) throw new Error("max_bytes must be a non-negative safe integer.");
  const read: ProcessOutputRead = buffer.read(offset, Math.min(requested, MAX_CAPTURED_OUTPUT));
  return {
    command_id: s.id,
    stream,
    output: maybeStripAnsi(read.data.toString("utf8"), stripAnsiValue),
    offset: read.offset,
    next_offset: read.endOffset,
    status: s.done ? "completed" : "running",
    exit_code: s.requestedStop ? null : s.exitCode,
    termination_reason: s.requestedStop,
    output_bytes: read.totalBytes,
    output_available_bytes: read.availableBytes,
    dropped_bytes: read.droppedBytes,
    truncated: read.truncated,
  };
}
