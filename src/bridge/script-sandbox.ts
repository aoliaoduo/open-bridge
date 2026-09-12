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

/** Hard caps. The defaults are what most callers should get; the maxima are where the Bridge says no. */
export const SCRIPT_LIMITS = {
  DEFAULT_TIMEOUT_MS: 30_000,
  MAX_TIMEOUT_MS: 300_000,
  DEFAULT_MAX_CALLS: 60,
  HARD_MAX_CALLS: 200,
  MAX_SOURCE_BYTES: 64 * 1024,
  MAX_RESULT_BYTES: 64 * 1024,
  MAX_CONSOLE_BYTES: 8 * 1024,
} as const;

/** Tools a script may not call: itself (no recursion) and the batch fan-out (a script *is* a batch). */
export const NON_SCRIPTABLE_TOOLS: ReadonlySet<string> = new Set(["run_script", "batch"]);

/** The filename every sandbox stack frame carries, so line numbers can be located. */
const SCRIPT_FILENAME = "open-bridge-script.js";

export type ScriptPhase = "compile" | "run" | "tool" | "timeout" | "return" | "limit" | "worker";

/**
 * One script run's result. `result_bytes`/`truncated` describe the returned value,
 * `calls`/`by_tool` the tool use inside the run, `console` whatever it logged.
 * Failures use `ok: false` plus the diagnosing fields.
 */
export interface ScriptRunEnvelope {
  ok: boolean;
  result?: unknown;
  result_bytes?: number;
  truncated?: boolean;
  calls: number;
  by_tool: Record<string, number>;
  duration_ms: number;
  console: string[];
  phase?: ScriptPhase;
  error?: string;
  error_type?: string;
  tool?: string;
  line?: number;
  column?: number;
  code_preview?: string[];
  hint?: string;
}

export interface RunScriptOptions {
  source: string;
  /** Executes one composed tool call; must throw on failure so the script can catch it. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The tools this instance advertises: anything else is refused, exactly as a direct call would be. */
  allowedTools: ReadonlySet<string>;
  timeoutMs?: number;
  maxCalls?: number;
  limits?: Partial<typeof SCRIPT_LIMITS>;
}

/**
 * The worker's own source. It is a string on purpose: it must be evaluated with
 * `eval: true` (the same trick `mcp/regex-worker.ts` uses) so no build step has to
 * know about it, and it is the only place that touches `vm`/`worker_threads`.
 *
 * Deliberate omissions inside the context: `require`, `process`, `globalThis`,
 * `fetch`, `XMLHttpRequest`, `WebSocket`, `setTimeout`/`setInterval`, `import`.
 * Waiting is a tool call (`wait`, `wait_process`), not a sandbox timer.
 */
const SCRIPT_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const limits = workerData.limits;
const toolNames = workerData.toolNames;
const pending = new Map();
const byTool = Object.create(null);
const consoleLines = [];
let nextId = 1;
let calls = 0;
let consoleBytes = 0;
let done = false;

function post(message) {
  if (done) return;
  done = true;
  try {
    parentPort.postMessage(message);
  } catch (error) {
    // The envelope itself could not cross the port; nothing further to do.
    done = false;
  }
}

function toolError(name, message) {
  const error = new Error(String(message || "tools." + name + " failed"));
  error.name = "ToolError";
  error.tool = name;
  return error;
}

function callTool(name, args) {
  if (++calls > limits.maxCalls) {
    const error = new Error(
      "This script exceeded its tool-call budget (" + limits.maxCalls + " calls). Split the work across several run_script calls or raise max_calls."
    );
    error.name = "CallLimitError";
    return Promise.reject(error);
  }
  byTool[name] = (byTool[name] || 0) + 1;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve, reject: reject });
    try {
      parentPort.postMessage({ type: "tool-call", id: id, name: name, args: args === undefined ? {} : args });
    } catch (error) {
      pending.delete(id);
      reject(new Error(
        "The arguments for tools." + name + " cannot cross the sandbox boundary; pass plain JSON data (objects, arrays, strings, numbers, booleans)."
      ));
    }
  });
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "tool-result") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(toolError(message.tool, message.error));
});

// Names a well-behaved sandbox object must not answer to: a returned promise
// checks "then", JSON.stringify checks "toJSON", the inspector checks "inspect".
const RESERVED = ["then", "catch", "finally", "toJSON", "inspect", "constructor", "prototype", "__proto__"];

const tools = new Proxy(Object.create(null), {
  get(_target, property) {
    if (typeof property !== "string" || RESERVED.indexOf(property) >= 0) return undefined;
    return (args) => callTool(property, args);
  },
  has: (_target, property) => typeof property === "string" && toolNames.indexOf(property) >= 0,
  ownKeys: () => toolNames.slice(),
  getOwnPropertyDescriptor: (_target, property) =>
    typeof property === "string" && toolNames.indexOf(property) >= 0
      ? { value: undefined, enumerable: true, configurable: true, writable: false }
      : undefined,
  set: () => false,
});

function capture(level) {
  return function () {
    const parts = Array.prototype.slice.call(arguments);
    const text = parts
      .map(function (part) {
        if (typeof part === "string") return part;
        try {
          return JSON.stringify(part);
        } catch (error) {
          return String(part);
        }
      })
      .join(" ");
    if (consoleBytes >= limits.maxConsoleBytes) return;
    const line = "[" + level + "] " + text;
    consoleBytes += line.length + 1;
    consoleLines.push(line.slice(0, 2000));
  };
}

// The context is granted exactly two things. Everything else it can see is the
// JavaScript language itself, taken from the sandbox realm rather than borrowed
// from this process: no require, no process, no fetch, no timers, no module
// loader, and (via codeGeneration) no eval / new Function.
const sandbox = {
  tools: tools,
  console: { log: capture("log"), info: capture("info"), warn: capture("warn"), error: capture("error"), debug: capture("debug") },
};

async function main() {
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  let script;
  try {
    script = new vm.Script(workerData.wrapped, { filename: workerData.filename, lineOffset: -1 });
  } catch (error) {
    post({ type: "done", ok: false, phase: "compile", error: { name: error.name, message: error.message, stack: error.stack }, calls: calls, byTool: byTool, console: consoleLines });
    return;
  }
  let value;
  try {
    value = await script.runInContext(context, { timeout: workerData.syncTimeoutMs });
  } catch (error) {
    const timedOut = error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
    post({
      type: "done",
      ok: false,
      phase: timedOut ? "timeout" : "run",
      error: { name: error && error.name, message: error && error.message, tool: error && error.tool, stack: error && error.stack },
      calls: calls,
      byTool: byTool,
      console: consoleLines,
    });
    return;
  }
  if (value === undefined) {
    post({
      type: "done",
      ok: false,
      phase: "return",
      error: { name: "NoReturn", message: "The script finished without returning a value. A top-level return is required; console output does not count." },
      calls: calls,
      byTool: byTool,
      console: consoleLines,
    });
    return;
  }
  post({ type: "done", ok: true, result: value, calls: calls, byTool: byTool, console: consoleLines });
}

main();
`;

/**
 * Strip one surrounding Markdown fence from a caller-authored script.
 *
 * Chat-Plus forbids fences outright and treats one as a format violation; this
 * Bridge tolerates them instead, because the source arrives in a JSON argument
 * rather than in prose, and refusing a correct script over ``` markers would be
 * friction with no benefit. CRLF is normalized for the same reason: the line
 * numbers in a failure envelope must match the lines the caller wrote.
 */
export function normalizeScriptSource(raw: unknown): string {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) {
    throw new Error("source must be a non-empty JavaScript program (call tools.<name>(…) and return a value).");
  }
  const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  if (!body) {
    throw new Error("source is empty after removing the Markdown fence.");
  }
  if (Buffer.byteLength(body, "utf8") > SCRIPT_LIMITS.MAX_SOURCE_BYTES) {
    throw new Error(`source is larger than ${SCRIPT_LIMITS.MAX_SOURCE_BYTES} bytes; a script is meant to be short — split it.`);
  }
  return body;
}

/** Wall-clock budget: the default when absent, clamped to [1s, 300s]. */
export function clampScriptTimeout(value: unknown, limits: Partial<typeof SCRIPT_LIMITS> = {}): number {
  const max = limits.MAX_TIMEOUT_MS ?? SCRIPT_LIMITS.MAX_TIMEOUT_MS;
  const fallback = limits.DEFAULT_TIMEOUT_MS ?? SCRIPT_LIMITS.DEFAULT_TIMEOUT_MS;
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, 1_000), max);
}

/** Tool-call budget: the default when absent, clamped to [1, 200]. */
export function clampScriptCalls(value: unknown, limits: Partial<typeof SCRIPT_LIMITS> = {}): number {
  const max = limits.HARD_MAX_CALLS ?? SCRIPT_LIMITS.HARD_MAX_CALLS;
  const fallback = limits.DEFAULT_MAX_CALLS ?? SCRIPT_LIMITS.DEFAULT_MAX_CALLS;
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

/**
 * JSON text for a returned value, with the shapes `JSON.stringify` refuses or
 * silently mangles handled explicitly: `BigInt` (would throw) and non-finite
 * numbers (would become `null` — a quiet lie). Cycles are reported, never guessed at.
 */
export function safeJsonText(value: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString();
      if (typeof item === "number" && !Number.isFinite(item)) return String(item);
      if (typeof item === "function" || typeof item === "symbol") return undefined;
      return item;
    });
    if (text === undefined) return { ok: false, reason: "the returned value has no JSON form (it was undefined)" };
    return { ok: true, text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /circular|cyclic/i.test(message) ? "the returned value contains a cycle" : message;
    return { ok: false, reason };
  }
}

/** Byte-accurate cap on the returned payload (never splits a multi-byte character). */
export function truncateScriptText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    try {
      // fatal: true refuses a slice that ends mid-character; giving back those
      // bytes is cheaper (and more honest) than emitting a replacement character.
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

/** Locate the failing line in the caller's own coordinates and show it with context. */
export function scriptCodePreview(
  stack: string | undefined,
  source: string,
  radius = 2,
): { line?: number; column?: number; code_preview?: string[] } {
  if (!stack) return {};
  const match = new RegExp(`${SCRIPT_FILENAME.replace(/\./g, "\\.")}:(\\d+):(\\d+)`).exec(stack);
  if (!match) return {};
  const line = Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) return {};
  const lines = source.split("\n");
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  const width = String(to).length;
  const code_preview: string[] = [];
  for (let current = from; current <= to; current += 1) {
    const marker = current === line ? ">" : " ";
    code_preview.push(`${marker} ${String(current).padStart(width)} | ${lines[current - 1].slice(0, 200)}`);
  }
  return { line, column, code_preview };
}

/**
 * What to say about a failure, by phase and error class. These hints are the
 * distilled version of Chat-Plus's "error correction rules": name the likely cause
 * and the next action, never just restate the message.
 */
export function scriptFailureHint(phase: ScriptPhase, errorType: string, error: string): string {
  const name = errorType || "Error";
  if (phase === "limit") return error;
  if (phase === "compile") {
    return "The script never ran: it did not compile. Fix the JavaScript syntax and run it again.";
  }
  if (phase === "timeout") {
    return "The run exceeded its wall-clock budget and was stopped. Split the work across several run_script calls, or raise timeout_ms (max 300000). A command the script already started keeps running under supervision.";
  }
  if (phase === "return") {
    if (name === "DataCloneError" || name === "UnserializableReturn") {
      return "The returned value cannot cross the sandbox boundary (a function, symbol, cycle or class instance). Return plain data: objects, arrays, strings, numbers, booleans — JSON only.";
    }
    return "End the script with a top-level `return` of the value you want back; console output is captured separately and never counts as the result.";
  }
  if (name === "ReferenceError") {
    return "Something the script used does not exist. Each run_script call is a fresh scope — variables declared in an earlier call are gone. Declare it here, or pass the earlier value in explicitly.";
  }
  if (name === "TypeError") {
    return "A value was not the shape the script assumed. Tool results are plain JSON — check the real field names (a small probe run is cheaper than guessing).";
  }
  if (name === "ToolError" || phase === "tool") {
    return "A tool call inside the script failed; the message above is that tool's own error. Fix the arguments, or wrap the call in try/catch if the script can continue without it.";
  }
  if (phase === "worker") {
    return "The sandbox worker stopped before the script finished. Re-run; if it repeats, shorten the script.";
  }
  return "The script threw. Read the line and code preview above, fix it and run it again.";
}

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
  let relayedCalls = 0;
  const relayedByTool: Record<string, number> = {};

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
        calls: envelope.calls ?? relayedCalls,
        by_tool: envelope.by_tool ?? relayedByTool,
        console: envelope.console ?? consoleLines,
        duration_ms: Date.now() - startedAt,
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
      if (item.type !== "done") return;
      const calls = typeof item.calls === "number" ? item.calls : relayedCalls;
      const byTool = (item.byTool ?? relayedByTool) as Record<string, number>;
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
      const name = typeof item.name === "string" ? item.name : "";
      const args = (item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args : {}) as Record<string, unknown>;
      const deny = (reason: string): void => {
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
      if (!options.allowedTools.has(name)) {
        deny(`Unknown tool "${name}".${toolNameHint(name, options.allowedTools)}`);
        return;
      }
      relayedCalls += 1;
      relayedByTool[name] = (relayedByTool[name] ?? 0) + 1;
      try {
        const value = await options.callTool(name, args);
        if (settled) return;
        safePost({ type: "tool-result", id, ok: true, value });
      } catch (error) {
        deny(error instanceof Error ? error.message : String(error));
      }
    }

    /** A tool result that cannot cross the port is a tool failure, not a hung script. */
    function safePost(message: Record<string, unknown>): void {
      try {
        worker.postMessage(message);
      } catch (error) {
        if (settled) return;
        try {
          worker.postMessage({
            type: "tool-result",
            id: message.id,
            ok: false,
            tool: message.tool,
            error: `The result of that tool call cannot cross the sandbox boundary: ${error instanceof Error ? error.message : String(error)}`,
          });
        } catch {
          // Both shapes refused by the port: the run will end on its own timeout.
        }
      }
    }
  });
}

/** Inlined rather than imported so this module stays dependency-free (and testable on its own). */
function toolNameHint(name: string, candidates: ReadonlySet<string>): string {
  const lower = name.toLowerCase();
  const ranked = [...candidates]
    .filter(candidate => !NON_SCRIPTABLE_TOOLS.has(candidate))
    .map(candidate => {
      const c = candidate.toLowerCase();
      if (c === lower) return { candidate, rank: 0 };
      if (c.startsWith(lower) || lower.startsWith(c)) return { candidate, rank: 1 };
      if (c.includes(lower) || lower.includes(c)) return { candidate, rank: 2 };
      return { candidate, rank: 3 };
    })
    .filter(entry => entry.rank < 3)
    .sort((left, right) => left.rank - right.rank || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map(entry => entry.candidate);
  return ranked.length ? ` Did you mean ${ranked.map(entry => `"${entry}"`).join(", ")}?` : "";
}
