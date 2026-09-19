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
import { hasUnreadOutput, resolveReadOffset } from "../process/output-cursor.js";
import {
  pruneCommands,
  spawnManaged,
  terminateProcess,
  processSnapshot,
  processResult,
  outputRead,
  shellSpec,
  requireRestartKnob,
  stringEnv,
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
 * An optional `max` caps the result further; `interact_with_process` passes
 * 60000 because its wait is a blind sleep (nothing wakes it early), unlike
 * the event-bounded waits elsewhere.
 *
 * The default ceiling is the 32-bit timer limit, and it is not optional. Past
 * 2147483647 setTimeout warns and substitutes 1ms, so `timeout_ms: 1e18` --
 * an unmistakable "wait essentially forever" -- returned after 38ms in a
 * measured run and reported a still-running process as finished. That is the
 * same inversion as the NaN case above, at the other end of the range, so it
 * gets the same treatment rather than being left to each caller to remember:
 * three of the five call sites passed no max, and there is no reason for a
 * fourth to have to think about it.
 *
 * Clamping rather than refusing is right *here* because this is the
 * millisecond helper for tool arguments, where an over-large number still has
 * an obvious intent ("as long as possible") and the ceiling is 24.8 days --
 * longer than any plausible wait. Config settings took the opposite route and
 * refuse, because a stored setting should never silently mean something other
 * than what it says.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export function clampMs(value: unknown, fallback: number, max = MAX_TIMER_MS): number {
  if (value === undefined || value === null) return Math.min(fallback, MAX_TIMER_MS);
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max, MAX_TIMER_MS) : Math.min(fallback, MAX_TIMER_MS);
}

/**
 * `timeout_ms` belongs to `run_command`; `start_process` has no such argument.
 *
 * It used to be accepted there and ignored. A caller that passed
 * `timeout_ms: 4000` alongside a `ready_pattern` believed it had widened the
 * wait, while the ready loop kept its own 10 s default — measured: the call
 * returned after 10.1 s. That is how a slow first build (vite/next) gets
 * reported as "not ready" by a caller that thinks it already allowed for it.
 *
 * So it is refused by name, and the refusal names the argument that does apply.
 * Nothing that works today is broken by this: the value was never read.
 */
function refuseRunCommandOnlyTimeout(args: Args, name: string): void {
  if (name !== "start_process" || args.timeout_ms === undefined) return;
  throw new Error(
    "start_process has no \"timeout_ms\"; a background process has no completion for it to bound"
    + " (the value was ignored, so a slow start looked like it had a longer budget than it did)."
    + " To wait longer for ready_pattern, raise ready_timeout_ms (default 10000, milliseconds)."
    + " Use run_command if you want a bounded foreground run.",
  );
}

export async function runOrStartProcess(args: Args, name: string): Promise<unknown> {
  refuseRunCommandOnlyTimeout(args, name);
  const commandText = typeof args.command === "string" ? args.command.trim() : "";
  if (!commandText) throw new Error("command is required and must be a non-empty string. (expected 'command': string)");
  const patternText = typeof args.ready_pattern === "string" && args.ready_pattern ? args.ready_pattern : undefined;
  if (patternText) await validateReadyPattern(patternText);
  pruneCommands();
  const cwd = workspacePath(args.cwd);
  const id = randomBytes(8).toString("hex");
  const customEnv = stringEnv(args);
  const commandState = spawnManaged(commandText, cwd, customEnv, id, 0, undefined);
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
        status: commandState.done ? "completed" : "running", ready, ready_checked: true,
        restart_count: commandState.restartCount,
        output: streamText(commandState.output), stdout: streamText(commandState.stdoutOutput), stderr: streamText(commandState.stderrOutput), output_bytes: snapshot.totalBytes,
        dropped_bytes: snapshot.droppedBytes, truncated: snapshot.truncated,
      };
    }
    const snapshot = commandState.output.tail(MAX_INLINE_OUTPUT);
    return {
      command_id: id, shell: shellSpec().file, cwd,
      status: commandState.done ? "completed" : "running",
      // `ready: true` remains the compatibility value when no pattern was
      // requested; ready_checked distinguishes that from an observed readiness signal.
      ready: commandState.done || !patternText, ready_checked: false,
      restart_count: commandState.restartCount,
      output: streamText(commandState.output), stdout: streamText(commandState.stdoutOutput), stderr: streamText(commandState.stderrOutput), output_bytes: snapshot.totalBytes,
      dropped_bytes: snapshot.droppedBytes, truncated: snapshot.truncated,
    };
  }

  // Foreground run_command: wait for exit or timeout. On timeout the process is
  // NOT killed - it keeps running under supervision; the caller can poll
  // read_process_output / wait_process or force_terminate using command_id.
  // Clamp like the wait/ready paths: an invalid (NaN) timeout_ms used to make
  // setTimeout fire at ~0 ms, instantly "timing out" a running command. And the
  // 32-bit ceiling is not optional either: a plain isFinite+>=0 check admits
  // 1e10, which setTimeout turns into a ~1 ms timer — the same inversion at the
  // other end of the range (a "wait essentially forever" timeout that fires
  // instantly). clampMs carries both guards.
  const timeout = clampMs(args.timeout_ms ?? 120_000, 120_000);
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
    // Whether THIS caller is caught up, not whether the buffer holds anything.
    // `availableBytes` is the retained byte count: permanently non-zero once
    // the process has printed a single line, so it skipped the wait for every
    // process worth following and turned the long-poll back into a busy-poll.
    const bufferState = buffer.state();
    if (!hasUnreadOutput(resolveReadOffset(args.offset, bufferState), bufferState)) {
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
  // Validate stream BEFORE writing to stdin: a typo'd `stream` would otherwise
  // let the input reach the process while the caller gets a "stream must be
  // one of..." error, so the agent sees a refused call whose side effect
  // already landed.
  const stream = args.stream === undefined ? "merged" : String(args.stream);
  if (!["merged", "stdout", "stderr"].includes(stream)) {
    throw new Error('stream must be one of: merged, stdout, stderr.');
  }
  // Same rule for `offset`. outputRead rejects a malformed one, but it runs
  // AFTER the write below, so a typo'd offset used to send the input and then
  // fail the call — a refusal the caller cannot undo. Validate it here, once,
  // against the same contract outputRead enforces.
  if (args.offset !== undefined) {
    const offset = Number(args.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("offset must be a non-negative safe integer.");
    }
  }
  try {
    s.child.stdin.write(String(args.input) + (args.append_newline === false ? "" : "\n"));
  } catch (error) {
    throw new Error(`Failed to write to process ${s.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Capped like read_process_output: unlike every other clampMs call site,
  // this wait is a blind sleep — no output or exit wakes it early — so an
  // uncapped value parks the caller for days instead of a minute.
  const waitMs = clampMs(args.wait_ms, 250, 60_000);
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  const effectiveOffset = args.offset !== undefined ? Number(args.offset) : preOffsets[stream];
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
  // Capture the resource lease for the same reason. terminateProcess releases it
  // (the process that owned it is gone), and `spawnManaged` returns a FRESH
  // CommandState with no handle, so without this transfer a restart silently
  // gives the reservation up: a second `start_process` declaring the same
  // `resource_keys` was granted immediately and two servers could bind the same
  // port — the exact double-claim the feature exists to prevent. The
  // auto-restart path already carries the handle across (see processes.ts).
  const carriedLocks = s.releaseResourceLocks;
  s.releaseResourceLocks = undefined;
  // Always run the record through terminateProcess — even when it already
  // exited — because that is what cancels a pending auto-restart timer. A
  // crashed command with autoRestart waiting out restartDelayMs would
  // otherwise respawn a duplicate (orphan) instance while we spawn ours.
  await terminateProcess(s, "stopped");
  const delay = clampMs(args.delay_ms, 0);
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  const replacement = spawnManaged(s.command, s.cwd, s.env, s.id, s.restartCount + 1, policy);
  replacement.releaseResourceLocks = carriedLocks;
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
  // clampMs rather than a bare safe-integer check: `ms: 3e9` is a safe integer,
  // but setTimeout past 2147483647 warns and fires at ~1 ms (measured), so the
  // call returned instantly while reporting `waited_ms: 3000000000`. Same trap
  // as run_command's timeout below, and clampMs already exists with the exact
  // ceiling. A clamped value is reported honestly: the caller sees how long it
  // actually waited, not the number it asked for.
  const ms = clampMs(args.ms, 0);
  if (!Number.isSafeInteger(ms)) {
    throw new Error("ms must be an integer (fractional milliseconds are not a real wait).");
  }
  // unref: a pending wait must not be the thing keeping a draining process (a
  // Bridge in shutdown, a test runner between files) alive for its whole
  // duration — an in-flight tool call is abandoned with the process anyway.
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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

/**
 * "Who is connected?" — both eras, in one answer.
 *
 * The legacy rows are the real thing: a session id, a transport, a call count,
 * and something `close_session` can act on. The modern era has none of that, so
 * it gets one row that is explicitly not a session — because the alternative
 * (leaving it out) was a lie of omission the server had already told once: an
 * agent asking this question while driving the Bridge over the stateless path got
 * an empty list, and the empty list is what a *dead* Bridge looks like.
 *
 * The session TABLE is untouched by this: `state.sessions` must not grow entries
 * that own no transport (see its own comment in state.ts). Only the view says
 * what the table cannot.
 */
export function listSessions(): unknown {
  const legacy = [...state.sessions.entries()].map(([id, s]) => ({
    session_id: id,
    era: "legacy",
    stateless: false,
    closable: true,
    connected_at: new Date(s.connectedAt ?? s.lastUsed).toISOString(),
    last_used: new Date(s.lastUsed).toISOString(),
    calls: s.calls ?? 0,
    todo_count: s.todos.length,
  }));
  if (state.modernLastUsed <= 0) return legacy;
  return [...legacy, {
    session_id: "modern",
    era: "modern",
    stateless: true,
    // Not an action the Bridge can take: there is no transport to drop and no
    // state to clear, because every modern request stands alone.
    closable: false,
    // No handshake happened, so there is none to report — `first_seen` is the
    // honest half of the pair.
    connected_at: null,
    first_seen: new Date(state.modernSince || state.modernLastUsed).toISOString(),
    last_used: new Date(state.modernLastUsed).toISOString(),
    // The legacy rows carry their busy count through the console's session
    // view; the stateless era has no session to hang one on, so it is reported
    // here — and it is the honest answer to "is this instance working right
    // now?" for a request that has not finished yet.
    in_flight: state.modernInFlight,
  }];
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
 * rejected with a message the caller can fix. Reads are passed through instead —
 * `loadTodoStore` replaces a non-array `todos` with `[]` and then hands every
 * entry on untouched, so there is no entry-dropping reader to look for.
 */
function validateTodos(value: unknown): Array<{ id: string; title: string; status: string }> {
  if (!Array.isArray(value)) {
    // Name the read tool as well as the parameter. `set_todos` is write-only,
    // so the commonest way to get here is reaching for it to READ the list
    // (`{action:"list"}` was a real attempt) — at which point "todos must be an
    // array" is a true statement that answers the wrong question. get_todos is
    // right there; the guard costs one clause and saves a round trip.
    throw new Error(
      "todos must be an array. (expected 'todos': object[]) "
      + "set_todos replaces the whole list; use get_todos to read the current one.",
    );
  }
  const seen = new Set<string>();
  const todos = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Todo ${index + 1} must be an object.`);
    const todo = item as Record<string, unknown>;
    const id = String(todo.id ?? "").trim();
    const title = String(todo.title ?? "").trim();
    const status = String(todo.status ?? "");
    if (!id || !title || !["pending", "in_progress", "completed"].includes(status)) {
      // Say which field is missing. "requires id, title, and a valid status"
      // made the caller re-read all three against their payload to find the one
      // that was wrong — and status is the one with a closed vocabulary, so an
      // invalid value there is both the likeliest error and the one a bare
      // field list cannot explain.
      const missing = [!id && "id", !title && "title"].filter(Boolean).join(", ");
      const detail = missing
        ? `missing ${missing}`
        : `status must be pending, in_progress or completed (got ${JSON.stringify(status)})`;
      throw new Error(`Todo ${index + 1}: ${detail}. (expected 'todos[i]': object)`);
    }
    if (seen.has(id)) throw new Error(`Duplicate todo id: ${id}`);
    seen.add(id);
    return { id, title, status };
  });
  return todos;
}
