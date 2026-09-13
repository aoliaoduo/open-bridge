import { host } from "../host/host.js";
import { randomBytes } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { testReadyPattern, validateReadyPattern } from "../mcp/regex-worker.js";
import { persistTodos } from "./todo-store.js";
import {
  MAX_INLINE_OUTPUT,
  READY_PATTERN_WINDOW_BYTES,
  READY_PATTERN_TEST_TIMEOUT_MS,
  state,
  type CommandState,
  type SessionState,
} from "./state.js";

/** Bytes of the previous ready-scan window re-examined by the next one (boundary split protection). */
const READY_PATTERN_OVERLAP_BYTES = 4 * 1024;
import { workspacePath } from "./paths.js";
import { availableHint } from "./error-hints.js";
import { maybeStripAnsi } from "../process/ansi.js";
import {
  pruneCommands,
  spawnManaged,
  terminateProcess,
  processSnapshot,
  processResult,
  outputRead,
  shellSpec,
  requireRestartKnob,
} from "./processes.js";
import type { JsonArgs } from "./json-args.js";

type Args = JsonArgs;

/**
 * Look up the command a process tool was pointed at.
 *
 * `command_id` is required by every process tool, and `String(undefined)` is the
 * literal text "undefined": a client that dropped the field used to be told
 * `Unknown command id: "undefined"` — a misdiagnosis that sends it hunting for a
 * stale id when the call was merely incomplete. Absence is now named, the way the
 * file tools name a missing path. An id that IS present but unknown still lists
 * the live ones: that is a different mistake with a different fix, and the hint
 * is what lets a client recover a command_id it lost track of.
 */
function commandStateOrThrow(args: Args): CommandState {
  const id = args.command_id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new Error(
      'Missing "command_id": pass the id returned by run_command or start_process.'
      + availableHint("Active command ids", state.commands.keys()),
    );
  }
  const found = state.commands.get(id);
  if (!found) {
    throw new Error(`Unknown command id: "${id}".${availableHint("Active command ids", state.commands.keys())}`);
  }
  return found;
}

/**
 * Resolve once the child has either started ('spawn') or failed to start
 * ('error'). Node emits these asynchronously after spawn() returns, so a call
 * that reads process state synchronously can otherwise report "running" for a
 * process that never started. Exported for shell-sessions' open_shell, which
 * reports a bad shellPath at open time instead of on the first send.
 */
export function waitForSpawnSettled(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      child.off("spawn", finish);
      child.off("error", finish);
      resolve();
    };
    child.once("spawn", finish);
    child.once("error", finish);
  });
}

/** Surface a spawn failure (bad cwd, missing shell, EACCES, ...) as a real tool error. */
function throwIfSpawnFailed(commandState: { spawnError?: string }): void {
  if (commandState.spawnError) {
    throw new Error(`Command failed to start: ${commandState.spawnError}`);
  }
}

/**
 * Clamp a caller-supplied millisecond duration, treating garbage as the
 * fallback. A raw `Math.max(Number(x), 0)` passes NaN straight through, and
 * `setTimeout(cb, NaN)` fires at ~0 ms — the bug that once instantly "timed
 * out" running commands in run_command. MCP arguments are LLM-generated, so a
 * "30s" string or a null lands here more often than anyone would like.
 */
export function clampMs(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function stringEnv(args: Args): Record<string, string> {
  return args.env && typeof args.env === "object" && !Array.isArray(args.env)
    ? (Object.fromEntries(Object.entries(args.env).filter(([, value]) => typeof value === "string")) as Record<string, string>)
    : {};
}

export async function runOrStartProcess(args: Args, name: string): Promise<unknown> {
  const commandText = typeof args.command === "string" ? args.command.trim() : "";
  if (!commandText) throw new Error("command is required and must be a non-empty string. (expected 'command': string)");
  const patternText = typeof args.ready_pattern === "string" && args.ready_pattern ? args.ready_pattern : undefined;
  if (patternText) await validateReadyPattern(patternText);
  pruneCommands();
  const cwd = workspacePath(args.cwd);
  const id = randomBytes(8).toString("hex");
  const customEnv = stringEnv(args);
  const commandState = spawnManaged(commandText, cwd, customEnv, id, 0, undefined, { visible: args.visible === true });
  state.commands.set(id, commandState);
  // Give the spawn a beat to succeed or fail so a missing shell / bad cwd is
  // reported right away instead of as a phantom "running" process.
  await waitForSpawnSettled(commandState.child);
  throwIfSpawnFailed(commandState);
  const stripArg = args.strip_ansi;
  const streamText = (buffer: typeof commandState.output): string =>
    maybeStripAnsi(buffer.tail(MAX_INLINE_OUTPUT).data.toString("utf8"), stripArg);

  if (name === "start_process" || args.background) {
    if (patternText) {
      const readyTimeout = clampMs(args.ready_timeout_ms, 10_000);
      const until = Date.now() + readyTimeout;
      let ready = false;
      let inspectedOffset = commandState.output.state().bufferStartOffset;
      while (!commandState.done && Date.now() < until && !ready) {
        const current = commandState.output.state();
        // Scan FORWARD from wherever the previous poll stopped (never only the
        // trailing 64 KiB): clamping to the tail let an early ready line that
        // was pushed out of the window by a >= 64 KiB burst between polls go
        // untested forever, falsely timing out a healthy process.
        // Each new window re-examines a small tail of the previous one: a
        // ready line split across the window boundary would otherwise be
        // tested against a truncated half in window N and be absent from
        // window N+1 (already advanced), and a healthy server would be
        // reported ready_timeout. A ready line is short; 4 KiB of overlap is
        // orders of magnitude beyond one.
        const start = Math.max(inspectedOffset - READY_PATTERN_OVERLAP_BYTES, current.bufferStartOffset);
        const window = commandState.output.read(start, READY_PATTERN_WINDOW_BYTES);
        ready = await testReadyPattern(patternText, window.data.toString("utf8"), READY_PATTERN_TEST_TIMEOUT_MS);
        // Advance by the bytes actually scanned so a poll that only read part
        // of a large burst does not skip the rest.
        inspectedOffset = Math.max(inspectedOffset, window.endOffset);
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready && !commandState.done) commandState.lastEvent = "ready_timeout";
      const snapshot = commandState.output.tail(MAX_INLINE_OUTPUT);
      return {
        command_id: id, shell: shellSpec().file, cwd,
        status: commandState.done ? "completed" : "running", ready,
        restart_count: commandState.restartCount,
        output: streamText(commandState.output), stdout: streamText(commandState.stdoutOutput), stderr: streamText(commandState.stderrOutput), output_bytes: snapshot.totalBytes,
        dropped_bytes: snapshot.droppedBytes, truncated: snapshot.truncated,
      };
    }
    const snapshot = commandState.output.tail(MAX_INLINE_OUTPUT);
    return {
      command_id: id, shell: shellSpec().file, cwd,
      status: commandState.done ? "completed" : "running",
      ready: commandState.done || !patternText, restart_count: commandState.restartCount,
      output: streamText(commandState.output), stdout: streamText(commandState.stdoutOutput), stderr: streamText(commandState.stderrOutput), output_bytes: snapshot.totalBytes,
      dropped_bytes: snapshot.droppedBytes, truncated: snapshot.truncated,
    };
  }

  // Foreground run_command: wait for exit or timeout. On timeout the process is
  // NOT killed - it keeps running under supervision; the caller can poll
  // read_process_output / wait_process or force_terminate using command_id.
  // Clamp like the wait/ready paths: an invalid (NaN) timeout_ms used to make
  // setTimeout fire at ~0 ms, instantly "timing out" a running command.
  const rawTimeout = Number(args.timeout_ms ?? 120000);
  const timeout = Number.isFinite(rawTimeout) && rawTimeout >= 0 ? rawTimeout : 120000;
  // The timeout result flows out through the promise instead of a captured
  // mutable flag. With `let timedOut = false` assigned inside the timer
  // callback, TypeScript narrows the variable to the literal `false` at the
  // `if` below — it does not track assignments made by nested functions — and
  // so reports the whole "your command is still running" branch as dead code,
  // which invites a future reader to delete it. It is not dead: it is the
  // answer every agent gets when it starts a dev server in the foreground.
  // Pinned by test/process-timeout-integration.test.mjs.
  const timedOut = await new Promise<boolean>(resolve => {
    const finish = (timed: boolean): void => {
      commandState.child.off("close", onExit);
      clearTimeout(raceTimer);
      resolve(timed);
    };
    const onExit = (): void => finish(false);
    commandState.child.once("close", onExit);
    const raceTimer = setTimeout(() => finish(true), timeout);
  });
  const snapshot = commandState.output.tail(MAX_INLINE_OUTPUT);
  if (timedOut && !commandState.done) {
    return {
      command_id: id,
      shell: shellSpec().file,
      cwd,
      status: "running",
      ready: false,
      timed_out: true,
      message: `Command is still running after ${timeout} ms; it was left alive under supervision. Poll with read_process_output/wait_process or stop with force_terminate.`,
      output: streamText(commandState.output), stdout: streamText(commandState.stdoutOutput), stderr: streamText(commandState.stderrOutput),
      output_bytes: snapshot.totalBytes,
      dropped_bytes: snapshot.droppedBytes,
      truncated: snapshot.truncated,
      restart_count: commandState.restartCount,
    };
  }
  return {
    command_id: id,
    output: streamText(commandState.output), stdout: streamText(commandState.stdoutOutput), stderr: streamText(commandState.stderrOutput),
    output_bytes: snapshot.totalBytes,
    dropped_bytes: snapshot.droppedBytes,
    truncated: snapshot.truncated,
    exit_code: commandState.exitCode,
    timed_out: timedOut,
    status: commandState.done ? "completed" : "running",
  };
}

export async function readProcessOutput(args: Args): Promise<Record<string, unknown>> {
  const s = commandStateOrThrow(args);
  const stream = args.stream === undefined ? "merged" : String(args.stream);
  if (!["merged", "stdout", "stderr"].includes(stream)) {
    throw new Error('stream must be one of: merged, stdout, stderr.');
  }
  // Optional long-poll: block until NEW output arrives (event-driven — the next
  // stdout/stderr chunk or process exit), instead of the agent busy-polling.
  const waitMs = Math.max(0, Math.min(Number(args.wait_ms ?? 0) || 0, 60_000));
  if (waitMs > 0 && !s.done) {
    const buffer = stream === "stdout" ? s.stdoutOutput : stream === "stderr" ? s.stderrOutput : s.output;
    if (buffer.state().availableBytes === 0) {
      await new Promise<void>(resolve => {
        const finish = (): void => {
          s.child.stdout.off("data", onData);
          s.child.stderr.off("data", onData);
          s.child.off("close", onClose);
          clearTimeout(timer);
          resolve();
        };
        const onData = (): void => finish();
        const onClose = (): void => finish();
        const timer = setTimeout(finish, waitMs);
        s.child.stdout.on("data", onData);
        s.child.stderr.on("data", onData);
        s.child.once("close", onClose);
      });
    }
  }
  return outputRead(s, args.offset, args.max_bytes, args.stream, args.strip_ansi);
}


export async function interactWithProcess(args: Args): Promise<Record<string, unknown>> {
  const s = commandStateOrThrow(args);
  if (s.done) throw new Error(`Process ${s.id} has exited (code ${String(s.exitCode)}). Read its output with read_process_output.`);
  // stdin can close between the liveness check and the write (racy exit, or
  // the process closed its own stdin); fail with an actionable error instead
  // of an EPIPE surfacing as an uncaught exception.
  if (s.child.stdin.destroyed || !s.child.stdin.writable) {
    throw new Error(`Process ${s.id} can no longer accept input (stdin closed). Restart it with restart_process.`);
  }
  // Snapshot pre-write offsets: when the caller omits offset, only output
  // produced AFTER this input is returned — no cursor bookkeeping on the
  // agent side. Explicit offsets still read absolute positions.
  const preOffsets: Record<string, number> = {
    merged: s.output.state().totalBytes,
    stdout: s.stdoutOutput.state().totalBytes,
    stderr: s.stderrOutput.state().totalBytes,
  };
  // `input` is required by the schema, and `String(undefined)` is the literal
  // text "undefined": a client that dropped the field used to get a success back
  // while the process received `undefined\n` on its stdin. Absence is refused;
  // an empty string is still a real input (a bare newline).
  if (args.input === undefined || args.input === null) {
    throw new Error(
      "Missing \"input\": interact_with_process needs the text to send. "
      + "Use read_process_output to read a process without writing to it.",
    );
  }
  const stream = args.stream === undefined ? "merged" : String(args.stream);
  try {
    s.child.stdin.write(String(args.input) + (args.append_newline === false ? "" : "\n"));
  } catch (error) {
    throw new Error(`Failed to write to process ${s.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const waitMs = clampMs(args.wait_ms, 250);
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  const effectiveOffset = args.offset !== undefined ? Number(args.offset) : preOffsets[stream] ?? preOffsets.merged;
  return outputRead(s, effectiveOffset, args.max_bytes, args.stream, args.strip_ansi);
}


export async function forceTerminate(args: Args): Promise<Record<string, unknown>> {
  const s = commandStateOrThrow(args);
  // Always run the record through terminateProcess — even when it already
  // exited — because that is what cancels a pending auto-restart timer. A
  // crashed command with autoRestart waiting out restartDelayMs used to be
  // reported as "not running" and then respawn behind the caller's back.
  const alreadyDone = s.done;
  const stopped = await terminateProcess(s, "terminated");
  return processResult(s, {
    terminated: stopped,
    ...(alreadyDone ? { already_exited: true } : {}),
  });
}

export async function restartProcess(args: Args): Promise<Record<string, unknown>> {
  const s = commandStateOrThrow(args);
  // Capture the policy BEFORE termination: terminateProcess flips autoRestart
  // off and marks requestedStop, neither of which may leak into the fresh spawn.
  const policy = { autoRestart: s.autoRestart, maxRestarts: s.maxRestarts, restartDelayMs: s.restartDelayMs };
  // Always run the record through terminateProcess — even when it already
  // exited — because that is what cancels a pending auto-restart timer. A
  // crashed command with autoRestart waiting out restartDelayMs would
  // otherwise respawn a duplicate (orphan) instance while we spawn ours.
  await terminateProcess(s, "stopped");
  const delay = clampMs(args.delay_ms, 0);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  const replacement = spawnManaged(s.command, s.cwd, s.env, s.id, s.restartCount + 1, policy, { visible: s.visibleTerminal === true });
  state.commands.set(s.id, replacement);
  return {
    command_id: s.id, restarted: true,
    restart_count: replacement.restartCount, auto_restart: replacement.autoRestart,
  };
}

export async function waitProcess(args: Args): Promise<Record<string, unknown>> {
  const s = commandStateOrThrow(args);
  const timeout = clampMs(args.timeout_ms, 120_000);
  if (!s.done) {
    await new Promise<void>(resolve => {
      // Listen for 'error' as well as 'close': on some runtimes a failed
      // spawn emits only 'error', and without this the wait would burn the
      // full timeout on a process that never started.
      const settle = (): void => {
        s.child.off("close", settle);
        s.child.off("error", settle);
        clearTimeout(timer);
        resolve();
      };
      s.child.once("close", settle);
      s.child.once("error", settle);
      const timer = setTimeout(settle, timeout);
    });
  }
  const stripArg = args.strip_ansi;
  const snapshot = s.output.tail(MAX_INLINE_OUTPUT);
  return processResult(s, {
    output: maybeStripAnsi(snapshot.data.toString("utf8"), stripArg),
    stdout: maybeStripAnsi(s.stdoutOutput.tail(MAX_INLINE_OUTPUT).data.toString("utf8"), stripArg),
    stderr: maybeStripAnsi(s.stderrOutput.tail(MAX_INLINE_OUTPUT).data.toString("utf8"), stripArg),
    output_bytes: snapshot.totalBytes,
    dropped_bytes: snapshot.droppedBytes,
    truncated: snapshot.truncated,
  });
}

export async function waitTool(args: Args): Promise<unknown> {
  const ms = Number(args.ms);
  if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("ms must be a non-negative safe integer.");
  await new Promise(resolve => setTimeout(resolve, ms));
  return { waited_ms: ms };
}

export function setProcessPolicy(args: Args): Record<string, unknown> {
  const s = commandStateOrThrow(args);
  if (args.auto_restart !== undefined) {
    s.autoRestart = Boolean(args.auto_restart);
    // Turning auto-restart off must also drop an ALREADY scheduled restart:
    // the timer callback never re-read the policy, so a crashed command still
    // came back once after the caller had disabled restarts.
    if (!s.autoRestart && s.restartTimer) {
      clearTimeout(s.restartTimer);
      s.restartTimer = undefined;
    }
  }
  // The same two knobs save_service validates, written here straight onto a LIVE
  // process. `Math.max(0, Number("abc"))` is NaN, not 0 — it does not clamp — and
  // NaN then disabled auto-restart (`restartCount < NaN` is always false) or fired
  // `setTimeout(NaN)` at ~0 ms, turning one crash into a crash-loop.
  if (args.max_restarts !== undefined) s.maxRestarts = requireRestartKnob(args.max_restarts, "max_restarts");
  if (args.restart_delay_ms !== undefined) {
    s.restartDelayMs = requireRestartKnob(args.restart_delay_ms, "restart_delay_ms");
  }
  return {
    command_id: s.id, auto_restart: s.autoRestart,
    max_restarts: s.maxRestarts, restart_delay_ms: s.restartDelayMs,
  };
}

export function getProcessSnapshot(args: Args): unknown {
  const id = typeof args.command_id === "string" ? args.command_id : "";
  // command_id is OPTIONAL here (omitted = every command), so the shared lookup
  // only runs when one was actually supplied.
  if (id) return processSnapshot(commandStateOrThrow(args));
  pruneCommands();
  return [...state.commands.values()].map(processSnapshot);
}

export function listSessions(): unknown {
  return [...state.sessions.entries()].map(([id, s]) => ({
    session_id: id,
    connected_at: new Date(s.connectedAt ?? s.lastUsed).toISOString(),
    last_used: new Date(s.lastUsed).toISOString(),
    calls: s.calls ?? 0,
    todo_count: s.todos.length,
  }));
}

/** Todos live on the MCP session that set them. */
export function setTodos(args: Args, session?: SessionState): unknown[] {
  const next = validateTodos(args.todos);
  if (session) {
    session.todos = next;
    state.latestSession = session;
  }
  persistTodos(next);
  host().ui.update();
  return next;
}

/**
 * Strict todo validation for the set_todos write path: malformed input is
 * rejected with a message the caller can fix. Reads are deliberately lenient
 * instead — a malformed stored entry is dropped, not the whole list.
 */
function validateTodos(value: unknown): Array<{ id: string; title: string; status: string }> {
  if (!Array.isArray(value)) throw new Error("todos must be an array. (expected 'todos': object[])");
  const seen = new Set<string>();
  const todos = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Todo ${index + 1} must be an object.`);
    const todo = item as Record<string, unknown>;
    const id = String(todo.id ?? "").trim();
    const title = String(todo.title ?? "").trim();
    const status = String(todo.status ?? "");
    if (!id || !title || !["pending", "in_progress", "completed"].includes(status)) {
      throw new Error(`Todo ${index + 1} requires id, title, and a valid status. (expected 'todos[i]': object)`);
    }
    if (seen.has(id)) throw new Error(`Duplicate todo id: ${id}`);
    seen.add(id);
    return { id, title, status };
  });
  return todos;
}
