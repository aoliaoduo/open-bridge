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

import { normalizeToolCall } from "./tool-call-shape.js";

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

export type ScriptToolOutcomeStatus = "running" | "succeeded" | "failed";

/**
 * A real tool call seen during a script that did not finish successfully.
 * `running` means the sandbox timed out or crashed before the Bridge call
 * settled; inspect the named tool's normal status surface before retrying it.
 */
export interface ScriptToolOutcome {
  call_id: number;
  tool: string;
  status: ScriptToolOutcomeStatus;
  result?: unknown;
  result_bytes?: number;
  result_truncated?: boolean;
  error?: string;
}

/**
 * One script run's result. `result_bytes`/`truncated` describe the returned value,
 * `calls`/`by_tool` the tool use inside the run, `console` whatever it logged.
 * On failure, `tool_outcomes` preserves the tool calls that were already started;
 * their result snapshots are bounded so recovery data cannot defeat Code Mode's
 * context budget.
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
  tool_outcomes?: ScriptToolOutcome[];
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
 * Waiting is a tool call (`wait`), not a sandbox timer.
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
    // The envelope itself could not cross the port — the usual cause is a
    // return value structured clone cannot carry (BigInt, function, Symbol).
    // Answer with a plain error envelope; the parent used to receive nothing
    // here and misreport the run as a timeout after the wall clock ran out.
    done = false;
    try {
      parentPort.postMessage({
        type: "done",
        ok: false,
        phase: "return",
        error: {
          name: "UnserializableReturn",
          message: "The script's return value could not be sent back to the bridge ("
            + (error && error.message ? error.message : "not serializable")
            + "). Return plain JSON data: objects, arrays, strings, numbers, booleans, null.",
        },
        calls: calls,
        byTool: byTool,
        console: consoleLines,
      });
    } catch (nested) {
      // Even the plain envelope was refused. Give up; the parent's wall-clock
      // timer is the backstop.
      void nested;
    }
  }
}

function toolError(name, message) {
  const error = new Error(String(message || "tools." + name + " failed"));
  error.name = "ToolError";
  error.tool = name;
  return error;
}

function callTool(name, args) {
  if (calls >= limits.maxCalls) {
    const error = new Error(
      "This script exceeded its tool-call budget (" + limits.maxCalls + " calls). Split the work across several run_script calls or raise max_calls."
    );
    error.name = "CallLimitError";
    return Promise.reject(error);
  }
  calls += 1;
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

// Names the tool surface must not answer to: a returned promise checks "then",
// JSON.stringify checks "toJSON", the inspector checks "inspect", and the
// prototype names are how one realm is climbed from another.
const RESERVED = ["then", "catch", "finally", "toJSON", "inspect", "constructor", "prototype", "__proto__"];

// A null-prototype closure, never a method reached through an array: handed a
// real array of strings, a script could call
// toolNames.entries.constructor("return process")() and be back in this realm.
// "entries" is an ordinary own property whose name is not in RESERVED, so no
// name check can catch it.
function makeToolsGate(names) {
  return Object.assign(Object.create(null), {
    has: (name) => names.indexOf(name) >= 0,
  });
}

/**
 * The one thing the sandbox must never be able to hold onto.
 *
 * apply/writeConsole/gate.has are functions defined in THIS realm, so their
 * "constructor" property is this realm's Function. They are delivered as data
 * fields and the bootstrap deletes them before the caller's script is compiled,
 * which is why the deletion order matters more than it looks.
 */
// Plain JavaScript ONLY in this string: the Worker evaluates it with eval:true,
// and Node 22 parses it as JS with no type stripping (Node 24 strips eval'd type
// annotations by default, which once masked this). A stray annotation here is a
// SyntaxError on the declared engine floor and kills every run_script call.
function makeHarness() {
  return Object.assign(Object.create(null), {
    toolNames: toolNames.slice(),
    gate: makeToolsGate(toolNames),
    apply: (name, args) => callTool(name, args),
    writeConsole: (level, text) => capture(level)(text),
  });
}


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

async function main() {
  // codeGeneration: { strings: false } disables the CONTEXT's Function
  // constructor. runInContext still compiles this trusted bootstrap — the
  // option gates eval/Function at runtime, not the host's own compilation.
  const context = vm.createContext(makeHarness(), { codeGeneration: { strings: false, wasm: false } });
  try {
    // compileFunction + parsingContext, not runInContext: the body must run in
    // the CONTEXT realm so the functions it creates carry that realm's
    // Function. An IIFE evaluated by runInContext would only be *created* there
    // and never invoked unless the completion value were called explicitly.
    vm.compileFunction(workerData.bootstrapSource, [], {
      parsingContext: context,
      filename: "open-bridge-sandbox-bootstrap.js",
    })();
  } catch (error) {
    post({
      type: "done",
      ok: false,
      phase: "worker",
      error: { name: error && error.name, message: error && error.message, stack: error && error.stack },
      calls: calls,
      byTool: byTool,
      console: consoleLines,
    });
    return;
  }
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
 * The bootstrap's FUNCTION BODY, compiled with `vm.compileFunction` and
 * `parsingContext: context`. Everything it creates therefore carries the
 * context's own Function as "constructor" — the one thing
 * codeGeneration: { strings: false } disables.
 *
 * It takes no parameters on purpose: it reads the harness off the context's
 * global scope. A parameter would have to be supplied by the host, and the
 * host's argument object lives in this realm.
 *
 * The escape this closes: the tool surface used to be a host-realm object whose
 * values were host-realm arrow functions, so
 * tools.read_files.constructor("return process")() returned the worker's
 * process (and from there getBuiltinModule("node:child_process").execSync) —
 * the whole CLI capability surface, bypassing the dispatcher, resource locks,
 * the audit log and the workspace sandbox. The RESERVED name list could not
 * help: it filters property NAMES on the proxy, while the leak was in the
 * prototype of a value the proxy returned.
 *
 * NOTE for anyone editing this string: it is a String.raw template, so a
 * backtick anywhere inside it — including in a comment — ends it early and
 * produces a wall of unrelated syntax errors.
 */
const BOOTSTRAP_SOURCE = String.raw`
  'use strict';
  var harness = globalThis;
  var RESERVED = ['then', 'catch', 'finally', 'toJSON', 'inspect', 'constructor', 'prototype', '__proto__'];
  var apply = harness.apply;
  var writeConsole = harness.writeConsole;
  var gate = harness.gate;
  var toolNames = harness.toolNames;
  // Close first, delete second. Up to here these host-realm functions are
  // reachable as globals, and any one of them would hand the script this realm.
  delete harness.apply;
  delete harness.writeConsole;
  delete harness.gate;
  delete harness.toolNames;
  function wrap(name) {
    var fn = function (args) { return apply(name, args); };
    try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (error) { /* cosmetic */ }
    return fn;
  }
  var tools = new Proxy(Object.create(null), {
    get: function (_target, property) {
      if (typeof property !== 'string' || RESERVED.indexOf(property) >= 0) return undefined;
      // Every other name is wrapped, advertised or not: an unknown name must
      // still reach callTool, which answers with the dispatcher's own
      // "Unknown tool" message and its did-you-mean suggestion. Returning
      // undefined here turned a typo into "tools.read_fil is not a function".
      return wrap(property);
    },
    has: function (_target, property) {
      return typeof property === 'string' && gate.has(property);
    },
    ownKeys: function () { return toolNames.slice(); },
    getOwnPropertyDescriptor: function (_target, property) {
      if (typeof property !== 'string' || !gate.has(property)) return undefined;
      return { value: undefined, enumerable: true, configurable: true, writable: false };
    },
    set: function () { return false; },
  });
  Object.defineProperty(globalThis, 'tools', { value: tools, writable: false, enumerable: false, configurable: false });
  // console.* is defined here for the same reason as tools.*: the previous
  // host-built capture() functions were a second door with the same shape.
  function capture(level) {
    return function () {
      var parts = Array.prototype.slice.call(arguments);
      var text = parts.map(function (part) {
        if (typeof part === 'string') return part;
        try { return JSON.stringify(part); } catch (error) { return String(part); }
      }).join(' ');
      return writeConsole(level, text);
    };
  }
  Object.defineProperty(globalThis, 'console', {
    value: Object.freeze({
      log: capture('log'), info: capture('info'), warn: capture('warn'),
      error: capture('error'), debug: capture('debug'),
    }),
    writable: false, enumerable: false, configurable: false,
  });
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
  // Group 1 is not optional in that pattern, so a match always carries a string;
  // `?? text` only ever fires when there was no fence at all.
  const body = (fenced?.[1] ?? text).trim();
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

/**
 * A failed script must leave enough evidence to recover from calls it already
 * started, but Code Mode must not turn a failure into N full tool payloads.
 */
const FAILURE_TOOL_OUTCOME_MAX_BYTES = 4 * 1024;

function snapshotToolOutcomeResult(value: unknown): Pick<ScriptToolOutcome, "result" | "result_bytes" | "result_truncated"> {
  const serialized = safeJsonText(value);
  if (!serialized.ok) {
    return {
      result: `[The tool returned a value without a JSON form: ${serialized.reason}]`,
      result_bytes: 0,
      result_truncated: true,
    };
  }
  const resultBytes = Buffer.byteLength(serialized.text, "utf8");
  const capped = truncateScriptText(serialized.text, FAILURE_TOOL_OUTCOME_MAX_BYTES);
  if (capped.truncated) {
    return { result: capped.text, result_bytes: resultBytes, result_truncated: true };
  }
  try {
    return { result: JSON.parse(capped.text), result_bytes: resultBytes, result_truncated: false };
  } catch {
    return { result: capped.text, result_bytes: resultBytes, result_truncated: false };
  }
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
    code_preview.push(`${marker} ${String(current).padStart(width)} | ${(lines[current - 1] ?? "").slice(0, 200)}`);
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
        deny(`Unknown tool "${name}".${toolNameHint(name, options.allowedTools)}`);
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
