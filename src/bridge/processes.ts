import { host } from "../host/host.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import type { ProcessOutputRead } from "../process/output-buffer.js";
import { ProcessOutputBuffer } from "../process/output-buffer.js";
import { resolveShell, type ShellSpec } from "../shell/shell-provider.js";
import { maybeStripAnsi } from "../process/ansi.js";
import { isBashLikeShell, visibleCapturePath, wrapWithTee, wrapWithTeeAppend } from "../process/tee-capture.js";
import { showVisibleTerminal } from "./visible-terminal.js";
import { windowsHideForChild } from "./child-console.js";
import { reassertServeConsoleTitle } from "./console-title.js";
import * as fsSync from "node:fs";
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
} from "./state.js";
import { workspacePath, workspaceStateSuffix } from "./paths.js";
import { prepareServiceLog, serviceLogFilePath } from "./service-log.js";

const execFileAsync = promisify(execFile);

export const shellSpec = (): ShellSpec => resolveShell();

/** Drop command records that finished more than the retention window ago. */
export function pruneCommands(): void {
  const cutoff = Date.now() - COMMAND_RETENTION_MS;
  for (const [id, command] of state.commands) {
    if (command.done && (command.endedAt ?? command.startedAt) < cutoff) {
      // Safety net: a retained command must not keep its resource locks.
      command.releaseResourceLocks?.();
      state.commands.delete(id);
      try { fsSync.unlinkSync(visibleCapturePath(id)); } catch { /* no capture file */ }
    }
  }
}

export function spawnManaged(
  commandText: string,
  cwd: string,
  env: Record<string, string>,
  id: string,
  restartCount = 0,
  policy?: Partial<CommandState>,
  options?: { visible?: boolean; teeLogPath?: string },
): CommandState {
  const spec = shellSpec();
  const visible = options?.visible === true;
  // Visible mode: the hidden managed child tees merged output into a capture
  // file that a user-visible `tail -f` terminal follows; lifecycle control
  // (kill/stdin/exit code) stays with us. Service mode appends merged output
  // to the persisted service log (tee -a) instead.
  // Tee wrapping needs bash syntax (pipe + PIPESTATUS). On a non-bash shell
  // (PowerShell/cmd) skip the mirror instead of spawning a broken command.
  const canTee = isBashLikeShell(spec.file);
  if ((options?.teeLogPath || visible) && !canTee) {
    record(
      "process",
      "progress",
      `Output mirror (visible terminal / service log) requires a bash-like shell (configured: ${spec.file}); spawning without it.`,
    );
  }
  const spawnText = options?.teeLogPath && canTee
    ? wrapWithTeeAppend(commandText, options.teeLogPath)
    : visible && canTee
      ? wrapWithTee(commandText, visibleCapturePath(id))
      : commandText;
  const child = spawn(spec.file, [...spec.args, spawnText], {
    cwd,
    // A service that outlives the terminal that started it is an orphan
    // holding a port; share our console so closing the window takes it along.
    windowsHide: windowsHideForChild(),
    env: { ...process.env, ...env, OPEN_BRIDGE_COMMAND_ID: id },
  });
  // A child that exits (or closes its stdin) mid-write makes stdin emit
  // 'error'; without a listener that surfaces as an uncaught exception in the
  // extension host instead of a normal process-exit path.
  child.stdin.on("error", () => { /* the child is gone; the close handler reports it */ });
  const commandState: CommandState = {
    id,
    child,
    output: new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT),
    stdoutOutput: new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT),
    stderrOutput: new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT),
    visibleTerminal: visible || undefined,
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
  };
  record("process", "running", `Started ${id}: ${redactSensitiveText(commandText)} (cwd: ${cwd})`);
  if (visible && canTee) {
    try { showVisibleTerminal(id, cwd); } catch { /* terminal is a best-effort mirror */ }
  }
  const append = (stream: "stdout" | "stderr") => (d: Buffer | string): void => {
    const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
    commandState.output.append(chunk);
    (stream === "stdout" ? commandState.stdoutOutput : commandState.stderrOutput).append(chunk);
  };
  child.stdout.on("data", append("stdout"));
  child.stderr.on("data", append("stderr"));
  child.on("close", code => {
    // Node (v24 observed; ≥18.2 in general) emits BOTH 'error' and 'close'
    // after a failed spawn. The 'error' handler below already marked the
    // command done with lastEvent "spawn_error"; the trailing 'close' carries
    // a meaningless UV errno (e.g. -4058 on Windows) that must not overwrite
    // that state — doing so reported an invented "exit code", and the
    // autoRestart branch then scheduled futile restarts for a process that can
    // never start (missing shell/binary/cwd).
    if (commandState.lastEvent === "spawn_error") return;
    commandState.done = true;
    commandState.exitCode = code;
    commandState.endedAt = Date.now();
    commandState.lastEvent = commandState.requestedStop ?? (code === 0 ? "exited" : "crashed");
    record("process", "completed", `${id} ${commandState.lastEvent} with code ${String(code)}`);
    // The child had this console and wrote its own title into it (cmd.exe puts its
    // image path there, npm writes "npm …"): take the window back.
    reassertServeConsoleTitle();
    // P1-1: best-effort push so a connected client hears about the exit without
    // polling; only non-zero, unrequested exits notify as errors.
    notifyLatestLogging(
      commandState.requestedStop || code === 0 ? "info" : "error",
      exitNotification(commandState),
    );
    if (
      commandState.autoRestart &&
      !commandState.requestedStop &&
      code !== 0 &&
      commandState.restartCount < commandState.maxRestarts &&
      !state.stopping
    ) {
      commandState.lastEvent = "restart_scheduled";
      notifyLatestLogging(
        "warning",
        `${exitNotification(commandState)} — restart scheduled (attempt ${commandState.restartCount + 1}/${commandState.maxRestarts}, in ${commandState.restartDelayMs} ms)`,
      );
      commandState.restartTimer = setTimeout(() => {
        commandState.restartTimer = undefined;
        // A stop/terminate that lands during the delay window must win over
        // the scheduled restart (terminateProcess marks requestedStop).
        if (state.stopping || commandState.requestedStop) return;
        if (state.commands.get(commandState.id) !== commandState) return;
        const replacement = spawnManaged(
          commandState.command,
          commandState.cwd,
          env,
          commandState.id,
          commandState.restartCount + 1,
          commandState,
          { visible: commandState.visibleTerminal === true, teeLogPath: commandState.teeLogPath },
        );
        // The resource stays claimed across a restart: hand the lock handle to
        // the replacement so its own exit still releases it.
        replacement.releaseResourceLocks = commandState.releaseResourceLocks;
        commandState.releaseResourceLocks = undefined;
        state.commands.set(commandState.id, replacement);
      }, commandState.restartDelayMs);
    }
    // Resource locks are held for the process's lifetime. A scheduled restart
    // keeps them (the resource is still claimed); releaseResourceLocks is
    // idempotent, so the hold-timeout backstop cannot double-release.
    if (!commandState.restartTimer) commandState.releaseResourceLocks?.();
  });
  child.on("error", error => {
    record("process", "error", `${id}: ${error.message}`);
    commandState.spawnError = error.message;
    // Spawn failures (ENOENT/EACCES) emit 'error' and may never emit 'close':
    // mark the command finished so foreground callers cannot wait out the full
    // timeout on a process that never started (ghost-running bug).
    if (!commandState.done) {
      commandState.done = true;
      commandState.exitCode = null;
      commandState.endedAt = Date.now();
      commandState.lastEvent = commandState.requestedStop ?? "spawn_error";
      commandState.releaseResourceLocks?.();
    }
  });
  return commandState;
}

/** P1-1 notification text for a finished command (redacted command preview, bounded). */
function exitNotification(commandState: CommandState): string {
  const preview = redactSensitiveText(commandState.command).slice(0, 200);
  return `[ob-exit] ${commandState.id.slice(0, 8)} ${preview} exited code=${String(commandState.exitCode)} (${commandState.lastEvent}) — full output: read_process_output command_id=${commandState.id}`;
}

/** Resolve the persisted log file for a service (explicit log_file wins; else the globalStorage default). */
function serviceLogPathFor(service: ServiceDefinition, serviceName: string): string | undefined {
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
export function cancelPendingRestarts(commandText: string): void {
  for (const command of state.commands.values()) {
    if (
      command.done &&
      command.lastEvent === "restart_scheduled" &&
      command.restartTimer &&
      command.command === commandText
    ) {
      clearTimeout(command.restartTimer);
      command.restartTimer = undefined;
      command.requestedStop = "stopped";
      command.autoRestart = false;
      command.lastEvent = "restart_cancelled";
      record("process", "progress", `${command.id} pending auto-restart cancelled (fresh instance starting).`);
    }
  }
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
    clearTimeout(command.restartTimer);
    command.restartTimer = undefined;
    if (!command.requestedStop) command.requestedStop = "stopped";
    if (command.lastEvent === "restart_scheduled") {
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

/** Enumerate a process tree on Windows so the whole shell job can be killed. */
async function descendantPids(rootPid: number): Promise<number[]> {
  if (process.platform !== "win32" || !rootPid) return [rootPid];
  try {
    const script =
      "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $rows | ConvertTo-Json -Compress";
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 5000 },
    );
    const rows = JSON.parse(result.stdout || "[]") as Array<{
      ProcessId?: number;
      ParentProcessId?: number;
    }>;
    const children = new Map<number, number[]>();
    for (const row of rows) {
      const pid = Number(row.ProcessId);
      const parent = Number(row.ParentProcessId);
      if (pid && parent) children.set(parent, [...(children.get(parent) ?? []), pid]);
    }
    const resultPids: number[] = [];
    const visit = (pid: number): void => {
      for (const child of children.get(pid) ?? []) {
        visit(child);
        resultPids.push(child);
      }
    };
    visit(rootPid);
    resultPids.push(rootPid);
    return [...new Set(resultPids)];
  } catch {
    return [rootPid];
  }
}

/** Kill the shell and every child it launched. Git Bash otherwise leaves jobs running on Windows. */
export async function terminateProcess(
  commandState: CommandState,
  reason: NonNullable<CommandState["requestedStop"]>,
): Promise<boolean> {
  // Mark first, even when the process already exited: a scheduled auto-restart
  // must never survive a stop/restart/delete request (it would resurrect the
  // process after the early return below).
  commandState.autoRestart = false;
  commandState.requestedStop = reason;
  if (commandState.restartTimer) {
    clearTimeout(commandState.restartTimer);
    commandState.restartTimer = undefined;
  }
  if (commandState.done) return true;
  const pid = commandState.child.pid;
  try {
    if (process.platform === "win32" && pid) {
      const pids = await descendantPids(pid);
      for (const targetPid of pids) {
        try {
          await execFileAsync("taskkill.exe", ["/pid", String(targetPid), "/f"], {
            windowsHide: true,
            timeout: 3000,
          });
        } catch { /* taskkill refuses an already-dead pid; kill() follows */ }
      }
    } else {
      commandState.child.kill();
    }
  } catch {
    if (!commandState.child.killed) commandState.child.kill();
  }
  return await waitForProcessClose(commandState);
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
    visible_terminal: s.visibleTerminal === true ? true : undefined,
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
  if (!["merged", "stdout", "stderr"].includes(stream)) {
    throw new Error('stream must be one of: merged, stdout, stderr.');
  }
  const buffer = stream === "stdout" ? s.stdoutOutput : stream === "stderr" ? s.stderrOutput : s.output;
  const offset = offsetValue === undefined ? buffer.state().bufferStartOffset : Number(offsetValue);
  const requested = maxBytesValue === undefined ? MAX_INLINE_OUTPUT : Number(maxBytesValue);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer.");
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
