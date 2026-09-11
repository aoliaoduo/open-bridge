import { host } from "../host/host.js";
/**
 * Persistent, named shell sessions.
 *
 * Each session is one long-lived login shell kept alive by reading commands
 * from stdin. Because the same shell process runs every command, working
 * directory (`cd`), exported variables, and activated virtualenvs persist
 * across calls — unlike run_command, which spawns a fresh shell per call.
 *
 * Completion is detected with a per-command sentinel line printed after the
 * command finishes, carrying the exit code (`__OB_DONE__<id>=<code>`). We poll
 * the existing ProcessOutputBuffer until the marker appears (or the shell
 * dies), then return everything emitted since the command started.
 */
import { randomBytes } from "node:crypto";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { record, state, type CommandState } from "./state.js";
import { workspacePath } from "./paths.js";
import { shellSpec } from "./processes.js";
import { ProcessOutputBuffer, type ProcessOutputRead } from "../process/output-buffer.js";
import { MAX_CAPTURED_OUTPUT } from "./state.js";
import { windowsHideForChild } from "./child-console.js";
import { createMarker, scanMarkerExitCode, stripMarkerLines } from "../shell/session-marker.js";
import { availableHint } from "./error-hints.js";
import { maybeStripAnsi } from "../process/ansi.js";
import { waitForSpawnSettled, clampMs } from "./process-tools.js";
import type { JsonArgs } from "./json-args.js";

type Args = JsonArgs;

const execFileAsync = promisify(execFile);

/**
 * Bytes of merged output scanned for a completion marker per poll/self-heal
 * pass. Completion detection scans FORWARD from a per-session cursor instead of
 * only the trailing 64 KiB: a marker pushed out of the tail by a burst of
 * background output used to make a finished command look running forever and
 * wedge the session (pendingMarker could never be cleared).
 */
const MARKER_SCAN_CHUNK_BYTES = 1024 * 1024;
/** Bytes of the previous scan chunk re-examined by the next one (a marker line is ~50 chars). */
const MARKER_SCAN_OVERLAP_BYTES = 256;

interface ShellSession {
  name: string;
  commandId: string;
  cwd: string;
  output: ProcessOutputBuffer;
  startedAt: number;
  lastCommandAt: number;
  /** Marker of a command that timed out but may still be running; blocks the next send until it completes. */
  pendingMarker: string | null;
  /** Absolute merged-output offset up to which completion markers have been scanned. */
  scannedOffset: number;
}

export const shellSessions = new Map<string, ShellSession>();

/**
 * Per-session FIFO so two concurrent send_to_shell calls on the same shell can
 * never interleave their writes/output reads. A single interactive shell is
 * physically single-threaded: without this lock, concurrent calls both passed
 * the pendingMarker guard, captured their own start offsets, wrote command +
 * sentinel back-to-back, and then each poll read a window containing the OTHER
 * command's output and raw sentinel line.
 */
const sendTails = new Map<string, Promise<unknown>>();

function enqueueSend(name: string, op: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const tail = (sendTails.get(name) ?? Promise.resolve()).then(op, op);
  sendTails.set(name, tail.then(() => undefined, () => undefined));
  return tail;
}

/** True when the configured shell is a POSIX-style shell (bash/sh) we drive with sentinels. */
function isBashLike(file: string): boolean {
  const n = file.toLowerCase().replace(/\\/g, "/");
  return n.includes("bash") || n.endsWith("/sh") || n.endsWith("/sh.exe") || n.includes("/bin/sh");
}

/** Spawn a login shell that reads commands from stdin and keep it registered like a managed command. */
function spawnSessionShell(name: string, cwd: string): { id: string; child: ChildProcessWithoutNullStreams; output: ProcessOutputBuffer } {
  const spec = shellSpec();
  if (!isBashLike(spec.file)) {
    throw new Error(
      `Persistent shell sessions currently require a bash/sh shell (configured: ${spec.file}). ` +
      "Use run_command for one-off commands, or set shellPath to Git Bash "
      + "(console settings page, or open-bridge config set shellPath).",
    );
  }
  const id = "shell-" + randomBytes(6).toString("hex");
  // "-l" login shell (loads profile, like the one-shot "-lc"), "-s" read commands from stdin.
  // Same console rule as services: an open shell must not survive the window.
  const child = spawn(spec.file, ["-l", "-s"], {
    cwd,
    windowsHide: windowsHideForChild(),
    env: { ...process.env, OPEN_BRIDGE_SHELL: name },
  });
  const output = new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT);
  const stdoutOutput = new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT);
  const stderrOutput = new ProcessOutputBuffer(MAX_CAPTURED_OUTPUT);
  const append = (stream: "stdout" | "stderr") => (d: Buffer | string): void => {
    const chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
    output.append(chunk);
    (stream === "stdout" ? stdoutOutput : stderrOutput).append(chunk);
  };
  child.stdout.on("data", append("stdout"));
  child.stderr.on("data", append("stderr"));
  const registered: CommandState = {
    id,
    child,
    output,
    stdoutOutput,
    stderrOutput,
    done: false,
    exitCode: null,
    command: `[shell:${name}]`,
    cwd,
    env: {},
    startedAt: Date.now(),
    restartCount: 0,
    autoRestart: false,
    maxRestarts: 0,
    restartDelayMs: 0,
    lastEvent: "shell_open",
  };
  // Spawn failures emit 'error' and may never emit 'close': mark the session
  // finished so open/send cannot address a shell that never started.
  child.on("error", error => {
    if (registered.done) return;
    registered.spawnError = error.message;
    registered.done = true;
    registered.exitCode = null;
    registered.endedAt = Date.now();
    registered.lastEvent = "spawn_error";
  });
  // Same EPIPE guard as spawnManaged: the shell can die while we are writing.
  child.stdin.on("error", () => { /* surfaced via isAlive and the next send_to_shell */ });
  // A session shell that exits on its own (crash, external kill, or `exit`
  // sent via send_to_shell — the sentinel echo never runs in that case) must
  // reach the done state: without a close listener the session looked alive
  // forever, send_to_shell polled until the full timeout, pendingMarker wedged
  // the session, and the command entry never became prunable.
  child.on("close", code => {
    if (registered.done) return;
    registered.done = true;
    registered.exitCode = code;
    registered.endedAt = Date.now();
    registered.lastEvent = registered.requestedStop ?? "exited";
    record("process", "completed", `${id} shell closed with code ${String(code)}`);
    host().ui.update();
  });
  // Register under state.commands so the panel / process tools see it as a live managed process.
  state.commands.set(id, registered);
  return { id, child, output };
}

function sessionOrThrow(name: string): ShellSession {
  const s = shellSessions.get(name);
  if (!s) throw new Error(`No open shell named "${name}".${availableHint("Open shells", shellSessions.keys())} Open one with open_shell first.`);
  return s;
}

function isAlive(s: ShellSession): boolean {
  const cmd = state.commands.get(s.commandId);
  return Boolean(cmd && !cmd.done && !cmd.child.killed);
}

export async function openShell(args: Args): Promise<Record<string, unknown>> {
  const name = String(args.name ?? "default").trim() || "default";
  if (shellSessions.has(name)) {
    const existing = shellSessions.get(name)!;
    if (isAlive(existing)) {
      return { name, command_id: existing.commandId, cwd: existing.cwd, already_open: true };
    }
    shellSessions.delete(name);
  }
  const cwd = workspacePath(args.cwd);
  const { id, child } = spawnSessionShell(name, cwd);
  const session: ShellSession = {
    name, commandId: id, cwd, output: state.commands.get(id)!.output,
    startedAt: Date.now(), lastCommandAt: Date.now(), pendingMarker: null, scannedOffset: 0,
  };
  shellSessions.set(name, session);
  // Let the spawn settle first: a bad shellPath used to surface only on the
  // first send_to_shell (as a confusing "stdin closed" / timeout), long after
  // open_shell had already reported success.
  await waitForSpawnSettled(child);
  const cmd = state.commands.get(id)!;
  if (cmd.spawnError) {
    shellSessions.delete(name);
    throw new Error(
      `Shell failed to start: ${cmd.spawnError}. ` +
      "Check shellPath (persistent sessions require a bash/sh shell).",
    );
  }
  host().ui.update();
  return { name, command_id: id, cwd, status: "open", shell: "bash (login, persistent)" , pid: child.pid };
}

export function listShells(): unknown {
  return [...shellSessions.values()].map(s => ({
    name: s.name,
    command_id: s.commandId,
    cwd: s.cwd,
    alive: isAlive(s),
    started_at: new Date(s.startedAt).toISOString(),
  }));
}

export function sendToShell(args: Args): Promise<Record<string, unknown>> {
  const name = String(args.name ?? "default").trim() || "default";
  return enqueueSend(name, () => sendToShellInner(args));
}

async function sendToShellInner(args: Args): Promise<Record<string, unknown>> {
  const name = String(args.name ?? "default").trim() || "default";
  const s = sessionOrThrow(name);
  const cmd = state.commands.get(s.commandId)!;
  if (!isAlive(s)) throw new Error(`Shell "${name}" has exited. Reopen it with open_shell.`);
  const input = String(args.command ?? "");
  if (!input.trim()) throw new Error("command is required. (expected 'command': string)");

  // Scan a chunk of merged output from the session's forward cursor for a
  // completion marker, advancing the cursor past whatever was examined. A
  // cursor (instead of a fixed 64 KiB tail window) is what keeps a marker from
  // being permanently missed after a burst of background output.
  const scanForMarker = (marker: string): number | null => {
    const stateNow = cmd.output.state();
    let from = Math.max(s.scannedOffset, stateNow.bufferStartOffset);
    // Each chunk re-examines a tail of the previous one: a marker (or its
    // "=<code>" digits) straddling the chunk boundary used to be missed
    // entirely — wedging the session on pendingMarker — or, worse, matched
    // with TRUNCATED digits, silently reporting a wrong exit code.
    let carry: Buffer = Buffer.alloc(0);
    while (from < stateNow.totalBytes) {
      const read = cmd.output.read(from, Math.min(MARKER_SCAN_CHUNK_BYTES, stateNow.totalBytes - from));
      if (read.data.length === 0) break;
      s.scannedOffset = Math.max(s.scannedOffset, read.endOffset);
      const combined = carry.length > 0 ? Buffer.concat([carry, read.data]) : read.data;
      carry = combined.subarray(Math.max(0, combined.length - MARKER_SCAN_OVERLAP_BYTES));
      const code = scanMarkerExitCode(combined.toString("utf8"), marker);
      if (code !== null) return code;
      from = read.endOffset;
    }
    // When nothing new has arrived, re-scan the retained tail once so a marker
    // that landed before the cursor ever advanced is still caught.
    if (s.scannedOffset <= stateNow.bufferStartOffset) {
      const tail = cmd.output.tail(MARKER_SCAN_CHUNK_BYTES).data.toString("utf8");
      const code = scanMarkerExitCode(tail, marker);
      if (code !== null) s.scannedOffset = stateNow.totalBytes;
      return code;
    }
    return null;
  };

  // Concurrency guard: a second command while the previous one is still running
  // would interleave output and completion markers. A timed-out command may have
  // finished since the last call, so give its pending marker a forward scan
  // (self-heal) before refusing.
  if (s.pendingMarker) {
    if (cmd.done || scanForMarker(s.pendingMarker) !== null) {
      s.pendingMarker = null;
    } else {
      throw new Error(
        `Shell "${name}" is still running the previous command. ` +
        `Wait and retry, or follow its output with read_process_output (command_id: ${s.commandId}).`,
      );
    }
  }

  const marker = createMarker();
  const startOffset = cmd.output.state().totalBytes;
  const startStdoutOffset = cmd.stdoutOutput.state().totalBytes;
  const startStderrOffset = cmd.stderrOutput.state().totalBytes;
  // stdin can close between isAlive and here (racy exit) — fail with an
  // actionable error instead of an EPIPE escaping as an uncaught exception.
  const stdin = cmd.child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    throw new Error(`Shell "${name}" can no longer accept input (stdin closed). Reopen it with open_shell.`);
  }
  // Append the sentinel: bash prints the marker with the previous command's exit code.
  // A trap-free, profile-safe approach using `;` so it runs even if the command backgrounds/fails.
  const wrapped = `${input}\necho "${marker}=$?"\n`;
  try {
    stdin.write(wrapped);
  } catch (error) {
    throw new Error(`Failed to write to shell "${name}": ${error instanceof Error ? error.message : String(error)}`);
  }
  s.lastCommandAt = Date.now();

  // clampMs, not a raw Math.max(Number(...)): a garbage timeout ("30s", null)
  // produced NaN, the poll loop never ran (Date.now() < NaN is false), and the
  // command was reported timed_out before it had any chance to finish —
  // wedging the session behind a pendingMarker until the next call self-healed.
  const timeout = clampMs(args.timeout_ms, 120_000);
  const pollInterval = 60;
  const deadline = Date.now() + timeout;
  let exitCode: number | null = null;
  let done = false;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));
    // Forward scan from the cursor: catches a marker anywhere in the retained
    // output, not only in the trailing window (the old tail-only scan wedged
    // the session when background output pushed the marker out of the window).
    const code = scanForMarker(marker);
    if (code !== null) { exitCode = code; done = true; break; }
    if (cmd.done) { done = false; break; }
  }

  // Read everything emitted since the command started. A single command can
  // emit more than the 32 MiB retention window, dropping bytes before our
  // start offset; read() rejects such offsets, so clamp to the retained start
  // and report the loss instead of failing the whole call.
  const fromStart = (buffer: ProcessOutputBuffer, start: number): ProcessOutputRead =>
    buffer.read(Math.max(start, buffer.state().bufferStartOffset), MAX_CAPTURED_OUTPUT);
  const read = fromStart(cmd.output, startOffset);
  const outputDropped = read.offset > startOffset;
  let raw = read.data.toString("utf8");
  // Strip the sentinel line(s) from the returned output.
  raw = stripMarkerLines(raw, marker);
  const stripArg = args.strip_ansi;
  const stdoutText = maybeStripAnsi(
    stripMarkerLines(fromStart(cmd.stdoutOutput, startStdoutOffset).data.toString("utf8"), marker),
    stripArg,
  );
  const stderrText = maybeStripAnsi(
    fromStart(cmd.stderrOutput, startStderrOffset).data.toString("utf8"),
    stripArg,
  );
  raw = maybeStripAnsi(raw, stripArg);
  const timedOut = !done && !cmd.done;
  // On timeout the command keeps running: remember its marker so the next call
  // can detect late completion instead of interleaving a second command.
  s.pendingMarker = timedOut ? marker : null;
  return {
    name,
    command_id: s.commandId,
    output: raw,
    stdout: stdoutText,
    stderr: stderrText,
    exit_code: cmd.done ? cmd.exitCode : exitCode,
    timed_out: timedOut,
    status: cmd.done ? "shell_exited" : timedOut ? "running" : "completed",
    shell_alive: !cmd.done && !cmd.child.killed,
    cwd: s.cwd,
    ...(outputDropped ? { output_dropped: true } : {}),
    note: timedOut
      ? `Command did not finish before timeout; the shell stays open and keeps running it — follow the output with read_process_output (command_id: ${s.commandId}), or retry send_to_shell once it completes.`
      : undefined,
  };
}

export async function closeShell(args: Args): Promise<Record<string, unknown>> {
  const name = String(args.name ?? "default").trim() || "default";
  const s = shellSessions.get(name);
  if (!s) return { name, closed: false, reason: "not_open" };
  const cmd = state.commands.get(s.commandId);
  shellSessions.delete(name);
  if (cmd && !cmd.done) {
    try { cmd.child.stdin.write("exit\n"); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 150));
    if (!cmd.done) {
      // Terminate the whole process tree (taskkill /T) like terminateProcess:
      // a bare single-PID kill on Windows would leave children of the session
      // shell (dev servers, background jobs) running as unstoppable orphans.
      const pid = cmd.child.pid;
      try {
        if (process.platform === "win32" && pid) {
          await execFileAsync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            timeout: 3000,
          });
        } else {
          cmd.child.kill();
        }
      } catch {
        try { cmd.child.kill(); } catch { /* ignore */ }
      }
      if (!cmd.done) {
        cmd.done = true;
        cmd.exitCode = cmd.exitCode ?? 0;
        cmd.lastEvent = "shell_closed";
      }
    }
  }
  host().ui.update();
  return { name, closed: true };
}
