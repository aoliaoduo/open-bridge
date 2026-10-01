/**
 * Pure run_script contract, limits, serialization and diagnostics.
 *
 * This module performs no worker creation and no Bridge tool dispatch. Keeping
 * these deterministic rules separate makes the security boundary testable
 * without entering the VM/Worker runtime.
 */
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
export const SCRIPT_FILENAME = "open-bridge-script.js";

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

export function snapshotToolOutcomeResult(value: unknown): Pick<ScriptToolOutcome, "result" | "result_bytes" | "result_truncated"> {
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
