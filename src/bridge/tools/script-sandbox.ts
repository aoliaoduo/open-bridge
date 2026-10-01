/**
 * `run_script` — Code Mode for this Bridge.
 *
 * The idea is taken from Chat-Plus's Code Mode, and it is the one thing in that
 * project this Bridge was genuinely missing: instead of forcing one tool call per
 * roundtrip, let the caller write a **small JavaScript program that composes the
 * tools it needs** — loops, conditionals, `Promise.all`, filtering — and return
 * only the value it wants back. Two things improve at once: roundtrips collapse,
 * and (the real prize) the bulk of a large tool result never has to enter the
 * model's context, because the script can reduce it before returning.
 *
 * Everything below is a deliberate departure from a browser-side sandbox, because
 * this one sits in the server:
 *
 *  - **Every `tools.x()` call is a real Bridge call.** It goes through the ordinary
 *    dispatcher, so resource locks, the audit log, redaction, session state and
 *    error semantics are inherited unchanged. A script is a convenience for the
 *    caller, never a way around the server's own bookkeeping — which is why the
 *    sub-call usage counters are left to the outer request (`countUsage: false`)
 *    and a per-tool breakdown is returned instead: `calls == successes + failures`
 *    keeps holding at the protocol layer.
 *  - **The sandbox itself has nothing.** No filesystem, no network, no process, no
 *    `require`, no timers, no `eval`: only the tool API plus a curated set of pure
 *    JS builtins, in a `vm` context with string code generation disabled. Tool
 *    names are resolved in the parent (a `Proxy` hands every access over), so an
 *    unknown name comes back with the same "did you mean…" hint a typo'd direct
 *    call would get from the Bridge itself.
 *  - **A fresh scope per run.** Nothing survives between `run_script` calls; data
 *    travels through `return`.
 *  - **Stopping a script is not a kill switch.** Terminating the worker discards
 *    the script, but a command it already started keeps running under supervision,
 *    with the same contract as the ordinary `run_command` timeout.
 *
 * Failures come back in the fixed-field envelope below (`phase`, `error_type`,
 * `line`, `code_preview`, `hint`) so a caller can fix its own code and re-run
 * instead of apologising — the most useful habit borrowed from that project's
 * system instruction.
 */

import { Worker } from "node:worker_threads";

import { suggestionHint } from "./error-hints.js";
import { normalizeToolCall } from "./tool-call-shape.js";
import {
  NON_SCRIPTABLE_TOOLS,
  SCRIPT_FILENAME,
  SCRIPT_LIMITS,
  clampScriptCalls,
  clampScriptTimeout,
  normalizeScriptSource,
  safeJsonText,
  scriptCodePreview,
  scriptFailureHint,
  snapshotToolOutcomeResult,
  truncateScriptText,
  type RunScriptOptions,
  type ScriptPhase,
  type ScriptRunEnvelope,
  type ScriptToolOutcome,
  type ScriptToolOutcomeStatus,
} from "./script-sandbox-contract.js";
import { BOOTSTRAP_SOURCE, SCRIPT_WORKER_SOURCE } from "./script-sandbox-worker-source.js";

export {
  NON_SCRIPTABLE_TOOLS,
  SCRIPT_LIMITS,
  clampScriptCalls,
  clampScriptTimeout,
  normalizeScriptSource,
  safeJsonText,
  scriptCodePreview,
  scriptFailureHint,
  truncateScriptText,
};
export type {
  RunScriptOptions,
  ScriptPhase,
  ScriptRunEnvelope,
  ScriptToolOutcome,
  ScriptToolOutcomeStatus,
};

/**
 * Run one script in an isolated worker. Resolves with the envelope — it never
 * rejects, because a script failure is a normal, reportable outcome.
 */
export async function runScriptInSandbox(options: RunScriptOptions): Promise<ScriptRunEnvelope> {
  const limits = { ...SCRIPT_LIMITS, ...(options.limits ?? {}) };
  const timeoutMs = clampScriptTimeout(options.timeoutMs, limits);
  const maxCalls = clampScriptCalls(options.maxCalls, limits);
  const source = options.source;
  const startedAt = Date.now();
  const consoleLines: string[] = [];
  // The worker normally reports these exact totals when it finishes. They are
  // also maintained here so a wall-clock timeout can truthfully name calls
  // already handed to the parent, even though the worker can no longer reply.
  let observedCalls = 0;
  const observedByTool: Record<string, number> = {};
  const toolOutcomes: ScriptToolOutcome[] = [];

  // The one added line is the async wrapper, hence lineOffset -1 in the worker:
  // a reported line number is the line the caller wrote.
  const wrapped = `(async () => {\n${source}\n})()`;

  return await new Promise<ScriptRunEnvelope>(resolve => {
    const worker = new Worker(SCRIPT_WORKER_SOURCE, {
      eval: true,
      workerData: {
        wrapped,
        filename: SCRIPT_FILENAME,
        syncTimeoutMs: timeoutMs,
        toolNames: [...options.allowedTools],
        // The bootstrap is compiled INSIDE the context, so its source has to
        // travel with the worker; a module binding would not exist there.
        bootstrapSource: BOOTSTRAP_SOURCE,
        limits: { maxCalls, maxConsoleBytes: limits.MAX_CONSOLE_BYTES },
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;

    const finish = (envelope: Partial<ScriptRunEnvelope>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      resolve({
        ok: envelope.ok === true,
        calls: envelope.calls ?? observedCalls,
        by_tool: envelope.by_tool ?? observedByTool,
        console: envelope.console ?? consoleLines,
        duration_ms: Date.now() - startedAt,
        ...(envelope.ok === true ? {} : { tool_outcomes: toolOutcomes.map(outcome => ({ ...outcome })) }),
        ...envelope,
      });
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        phase: "timeout",
        error: `Script exceeded ${timeoutMs} ms and was stopped.`,
        error_type: "ScriptTimeout",
        hint: scriptFailureHint("timeout", "ScriptTimeout", ""),
      });
    }, timeoutMs);

    worker.on("message", (message: unknown) => {
      const item = message as Record<string, unknown> | null;
      if (!item || typeof item !== "object") return;
      if (item.type === "tool-call") {
        void handleToolCall(item);
        return;
      }
      if (item.type === "console" && typeof item.line === "string") {
        // Streamed console output. Only while the run is unsettled: after
        // finish() the array is the resolved envelope's own, and appending to
        // it would mutate a result the caller already holds.
        if (!settled && consoleLines.length < 2000) consoleLines.push(item.line);
        return;
      }
      if (item.type !== "done") return;
      const calls = typeof item.calls === "number" ? item.calls : observedCalls;
      const byTool = (item.byTool ?? observedByTool) as Record<string, number>;
      const logs = Array.isArray(item.console) ? (item.console as string[]) : consoleLines;
      if (item.ok === true) {
        const serialized = safeJsonText(item.result);
        if (!serialized.ok) {
          finish({
            ok: false,
            phase: "return",
            error: `The returned value cannot be sent back: ${serialized.reason}.`,
            error_type: "UnserializableReturn",
            calls,
            by_tool: byTool,
            console: logs,
            hint: scriptFailureHint("return", "UnserializableReturn", serialized.reason),
          });
          return;
        }
        const capped = truncateScriptText(serialized.text, limits.MAX_RESULT_BYTES);
        let result: unknown = capped.text;
        if (!capped.truncated) {
          try {
            result = JSON.parse(capped.text);
          } catch {
            result = capped.text;
          }
        }
        finish({
          ok: true,
          result,
          result_bytes: Buffer.byteLength(serialized.text, "utf8"),
          truncated: capped.truncated,
          calls,
          by_tool: byTool,
          console: logs,
          ...(capped.truncated
            ? { hint: `The returned value was larger than ${limits.MAX_RESULT_BYTES} bytes and was cut; return less (filter or aggregate inside the script) or read the rest with a follow-up call.` }
            : {}),
        });
        return;
      }
      const error = (item.error ?? {}) as { name?: string; message?: string; tool?: string; stack?: string };
      const reported = typeof item.phase === "string" ? (item.phase as ScriptPhase) : "run";
      const phase: ScriptPhase = error.name === "CallLimitError" ? "limit" : reported;
      const located = scriptCodePreview(error.stack, source);
      finish({
        ok: false,
        phase,
        error: error.message ?? "The script failed.",
        error_type: error.name ?? "Error",
        ...(error.tool ? { tool: error.tool } : {}),
        ...located,
        calls,
        by_tool: byTool,
        console: logs,
        hint: scriptFailureHint(phase, error.name ?? "Error", error.message ?? ""),
      });
    });

    worker.on("error", error => {
      finish({
        ok: false,
        phase: "worker",
        error: error.message,
        error_type: error.name,
        hint: scriptFailureHint("worker", error.name, error.message),
      });
    });

    worker.on("exit", code => {
      if (code !== 0) {
        finish({
          ok: false,
          phase: "worker",
          error: `The sandbox worker exited with code ${code} before finishing.`,
          error_type: "WorkerExit",
          hint: scriptFailureHint("worker", "WorkerExit", ""),
        });
      }
    });

    /** Relay one composed call into the Bridge, with the same refusal rules a direct call would meet. */
    async function handleToolCall(item: Record<string, unknown>): Promise<void> {
      const id = item.id;
      const callId = typeof id === "number" && Number.isInteger(id) && id > 0 ? id : 0;
      const name = typeof item.name === "string" ? item.name : "";
      const args = (item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args : {}) as Record<string, unknown>;
      // Record before validation or dispatch. A caller that times out after this
      // message needs to know whether it must inspect or clean up this tool call,
      // not merely that a script timed out after an opaque count.
      observedCalls += 1;
      observedByTool[name] = (observedByTool[name] ?? 0) + 1;
      const outcome: ScriptToolOutcome = { call_id: callId, tool: name, status: "running" };
      toolOutcomes.push(outcome);
      const deny = (reason: string): void => {
        outcome.status = "failed";
        outcome.error = reason;
        if (settled) return;
        safePost({ type: "tool-result", id, ok: false, tool: name, error: reason });
      };
      if (!name) {
        deny("tools.<name>(…) needs a tool name.");
        return;
      }
      if (NON_SCRIPTABLE_TOOLS.has(name)) {
        deny(
          name === "run_script"
            ? "run_script cannot be called from inside a script. Write one script that does the whole job."
            : "batch cannot be called from inside a script: the script already composes its own calls. Call the tools directly.",
        );
        return;
      }
      // A legacy name is accepted when the tool it now means is in the catalog:
      // a script written against the older vocabulary keeps working, while the
      // session's own catalog still decides what is reachable.
      if (!options.allowedTools.has(name) && !options.allowedTools.has(normalizeToolCall(name).tool)) {
        // Same suggestion vocabulary as the dispatcher's own "Unknown tool"
        // error (error-hints.ts), minus the tools a script may never call, so
        // a typo inside a script reads exactly like a typo'd direct call.
        deny(`Unknown tool "${name}".${suggestionHint(name, [...options.allowedTools].filter(candidate => !NON_SCRIPTABLE_TOOLS.has(candidate)))}`);
        return;
      }
      try {
        const value = await options.callTool(name, args);
        outcome.status = "succeeded";
        Object.assign(outcome, snapshotToolOutcomeResult(value));
        if (settled) return;
        safePost({ type: "tool-result", id, ok: true, value });
      } catch (error) {
        deny(error instanceof Error ? error.message : String(error));
      }
    }

    /** A tool result that cannot cross the port is a tool failure, not a hung script. */
    function safePost(message: Record<string, unknown>): void {
      // Cheap early exit: a settled run cannot observe the message anyway, and
      // any postMessage attempt on a terminated worker is guaranteed to throw.
      if (settled) return;
      try {
        worker.postMessage(message);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        try {
          worker.postMessage({
            type: "tool-result",
            id: message.id,
            ok: false,
            tool: message.tool,
            error: `The result of that tool call cannot cross the sandbox boundary: ${reason}`,
          });
        } catch {
          // Both shapes refused by the port. Without surfacing this, the script
          // side just hangs and the only signal is the next sandbox timeout —
          // which makes diagnosis painful. Emit a warning so the service log
          // shows the orphan tool call and its id.
          console.warn(
            `[script-sandbox] orphaned tool-result (id=${String(message.id)}, tool=${String(message.tool)}): postMessage refused and run is not yet settled.`,
          );
        }
      }
    }
  });
}
