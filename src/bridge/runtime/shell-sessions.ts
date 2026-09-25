import { host } from "../../host/host.js";
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
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { record, state, type CommandState } from "../state.js";
import { workspacePath } from "../paths.js";
import { killWindowsProcessFamily, shellSpec, wireSpawnedChild } from "./processes.js";
import { isBashLikeShell } from "../../process/tee-capture.js";
import { ProcessOutputBuffer, type ProcessOutputRead } from "../../process/output-buffer.js";
import { MAX_CAPTURED_OUTPUT } from "../state.js";
import { windowsHideForChild } from "../../process/child-console.js";
import { createMarker, stripMarkerLines } from "../../shell/session-marker.js";
import {
  createMarkerScanState, resetMarkerScanCarry, scanForMarker,
  type MarkerScanState,
} from "../../shell/marker-scan.js";
import { availableHint } from "../tools/error-hints.js";
import { maybeStripAnsi } from "../../process/ansi.js";
import { waitForSpawnSettled, clampMs, DEFAULT_TOOL_TIMEOUT_MS } from "../tools/process-tools.js";
import type { JsonArgs } from "../tools/json-args.js";

type Args = JsonArgs;

/**
 * Bytes of merged output scanned for a completion marker per poll/self-heal
 * pass. Completion detection scans FORWARD from a per-session cursor instead of
 * only the trailing 64 KiB: a marker pushed out of the tail by a burst of
 * background output used to make a finished command look running forever and
 * wedge the session (pendingMarker could never be cleared).
 */

interface ShellSession {
  name: string;
  commandId: string;
  cwd: string;
  output: ProcessOutputBuffer;
  startedAt: number;
  lastCommandAt: number;
  /** Marker of a command that timed out but may still be running; blocks the next send until it completes. */
  pendingMarker: string | null;
  /**
   * Forward cursor + carry for completion-marker scanning. The carry must live
   * here, not inside one scan: the 60 ms poll interval splits sentinel lines
   * just as chunk boundaries do, and only state that survives the call can
   * rejoin the halves. See ../shell/marker-scan.ts.
   */
  scan: MarkerScanState;
}

const shellSessions = new Map<string, ShellSession>();

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

/** Spawn a login shell that reads commands from stdin and keep it registered like a managed command. */
function spawnSessionShell(name: string, cwd: string): { id: string; child: ChildProcessWithoutNullStreams; output: ProcessOutputBuffer } {
  const spec = shellSpec();
  if (!isBashLikeShell(spec.file)) {
    throw new Error(
      `Persistent shell sessions currently require a bash/sh shell (configured: ${spec.file}). `
      + "Use run_command for one-off commands, or pick a bash on the console settings page "
      + "(设置 → Shell — it lists the shells found on this machine).",
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
  // The spawn wiring (capture buffers, EPIPE guard, spawn-error and close state
  // machines) is shared with spawnManaged. The close listener is what keeps the
  // session honest: a shell that exits on its own (crash, external kill, or
  // `exit` sent via send_to_shell — the sentinel echo never runs in that case)
  // must reach the done state, otherwise the session looked alive forever,
  // send_to_shell polled until the full timeout, pendingMarker wedged the
  // session, and the command entry never became prunable.
  const registered = wireSpawnedChild(
    child,
    {
      id,
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
    },
    {
      onClose: (finalState, code) => {
        record("process", "completed", `${finalState.id} shell closed with code ${String(code)}`);
        host().ui.update();
      },
    },
  );
  // Register under state.commands so the panel / process tools see it as a live managed process.
  state.commands.set(id, registered);
  return { id, child, output: registered.output };
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
    startedAt: Date.now(), lastCommandAt: Date.now(), pendingMarker: null, scan: createMarkerScanState(),
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
      `Shell failed to start: ${cmd.spawnError}. `
      + "Pick a different shell on the console settings page (设置 → Shell); persistent "
      + "sessions require a bash/sh shell.",
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

  // Forward scan from the session's cursor, carrying the examined tail across
  // calls (see ../shell/marker-scan.ts): the sentinel can be split by the poll
  // interval as easily as by a chunk boundary.
  const scan = (marker: string): number | null => scanForMarker(cmd.output, s.scan, marker);

  // Concurrency guard: a second command while the previous one is still running
  // would interleave output and completion markers. A timed-out command may have
  // finished since the last call, so give its pending marker a forward scan
  // (self-heal) before refusing.
  if (s.pendingMarker) {
    if (cmd.done || scan(s.pendingMarker) !== null) {
      s.pendingMarker = null;
    } else {
      throw new Error(
        `Shell "${name}" is still running the previous command. ` +
        `Wait and retry, or follow its output with read_process_output (command_id: ${s.commandId}).`,
      );
    }
  }

  const marker = createMarker();
  // Drop the previous command's trailing bytes: they can only ever produce a
  // spurious match against this command's marker.
  resetMarkerScanCarry(s.scan);
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
  // Newline-separated, NOT `;`-joined: a trailing `# comment` or a backgrounded
  // `cmd &` would swallow or break a `;`-appended echo, so the sentinel would
  // never print and the caller would burn the whole timeout.
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
  const timeout = clampMs(args.timeout_ms, DEFAULT_TOOL_TIMEOUT_MS);
  const pollInterval = 60;
  const deadline = Date.now() + timeout;
  let exitCode: number | null = null;
  let done = false;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));
    // Forward scan from the cursor: catches a marker anywhere in the retained
    // output, not only in the trailing window (the old tail-only scan wedged
    // the session when background output pushed the marker out of the window).
    const code = scan(marker);
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
    const pid = cmd.child.pid;
    if (process.platform === "win32" && pid && isBashLikeShell(shellSpec().file)) {
      // Straight to the family kill — no graceful "exit\n" first. Bash does
      // NOT take background jobs with it when it exits, and once the executor
      // dies, its MSYS process-group row — the only way to find those orphans
      // (see killWindowsProcessFamily) — dies with it: a session closed
      // "cleanly" leaked every `job &` as an unstoppable stray while still
      // answering closed:true. Kill while the family is discoverable.
      try {
        await killWindowsProcessFamily(pid, shellSpec().file);
      } catch {
        try { cmd.child.kill(); } catch { /* ignore */ }
      }
    } else {
      try { cmd.child.stdin.write("exit\n"); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 150));
      if (!cmd.done) {
        // Terminate the whole process tree like terminateProcess: a bare
        // single-PID kill on Windows would leave children of the session
        // shell (dev servers, background jobs) running as unstoppable orphans.
        try {
          if (process.platform === "win32" && pid) {
            await killWindowsProcessFamily(pid, shellSpec().file);
          } else {
            cmd.child.kill();
          }
        } catch {
          try { cmd.child.kill(); } catch { /* ignore */ }
        }
      }
    }
    if (!cmd.done) markSessionShellClosed(cmd);
  }
  host().ui.update();
  return { name, closed: true };
}

/**
 * Final-state marking for a session shell closeShell had to close itself: the
 * shell never reported its own exit, so nobody knows the exit code — null,
 * never a fabricated 0 that reads as "closed cleanly" in every consumer
 * (get_process_snapshot, wait, the console) that checks it. endedAt is stamped
 * HERE, not left to the real 'close' event: that event early-returns on done
 * (wireSpawnedChild), so this is the last chance — without it the finished
 * shell had no end time and its uptime_ms grew on every snapshot poll.
 */
export function markSessionShellClosed(cmd: CommandState): void {
  cmd.done = true;
  cmd.exitCode = cmd.exitCode ?? null;
  cmd.lastEvent = "shell_closed";
  cmd.endedAt = Date.now();
}
