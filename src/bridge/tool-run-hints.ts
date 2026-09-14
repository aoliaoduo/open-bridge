/**
 * Notice when a caller is doing by hand what one tool call could do, and say so
 * once.
 *
 * Motivated by this project's own audit log rather than a guess about models in
 * general: 977 `run_command` calls against 152 `run_script`, on a workspace
 * whose own `docs/tools.md` says to prefer the latter for batches. The advice
 * existed and was read; it lost to the fact that reaching for the shell is the
 * shorter thought each individual time, and the cost of not batching (one more
 * round trip, a few more KB of context) is invisible per call and only shows up
 * in aggregate.
 *
 * So the hint is attached to the aggregate, where the evidence is. It rides on
 * the result of a call the caller already made -- never a refusal, never an
 * extra step -- and states what was observed rather than issuing an
 * instruction.
 *
 * Rules that keep it from becoming noise, which is the only way a hint like
 * this can make things worse:
 *  - It fires on a RUN of the same tool: N consecutive calls, no other tool in
 *    between. Alternating tools is ordinary work, not a missed batch.
 *  - Once per session per pattern. A hint repeated every third call is a
 *    nag, and a nag gets filtered out exactly like the docs did.
 *  - Only for patterns with a concrete better call to name. "You could be more
 *    efficient" is not actionable; "these three reads could be one read_files"
 *    is.
 */

/** A run of identical tool calls, and what to say when it gets long enough. */
interface RunPattern {
  /** Tools this pattern watches. */
  readonly tools: ReadonlySet<string>;
  /** Consecutive identical calls before the hint fires. */
  readonly threshold: number;
  /** Stable id so each pattern fires at most once per session. */
  readonly id: string;
  /** The observation, phrased as a fact plus the call that would replace it. */
  readonly advice: string;
}

const RUN_PATTERNS: readonly RunPattern[] = [
  {
    id: "reads->read_files",
    tools: new Set(["read_file"]),
    threshold: 3,
    advice: "read_files takes a list of paths and returns them in one call.",
  },
  {
    id: "commands->run_script",
    tools: new Set(["run_command"]),
    threshold: 5,
    advice:
      "run_script can compose several tool calls in one round trip and return "
      + "only what you need, which keeps intermediate output out of context.",
  },
  {
    id: "edits->batch",
    tools: new Set(["edit_block"]),
    threshold: 5,
    advice: "batch applies several edits in one call; review_changes then shows the whole set.",
  },
];

/** Per-session run state. Reset when the session ends with it. */
export interface ToolRunState {
  lastTool: string;
  runLength: number;
  firedPatterns: Set<string>;
}

export function freshRunState(): ToolRunState {
  return { lastTool: "", runLength: 0, firedPatterns: new Set() };
}

/**
 * Advance the run counter and return a hint when one is due.
 *
 * Pure apart from mutating the passed state, so the thresholds are testable
 * without a session, a server, or a clock.
 */
export function noteToolCall(state: ToolRunState, tool: string): string | undefined {
  if (tool === state.lastTool) {
    state.runLength += 1;
  } else {
    state.lastTool = tool;
    state.runLength = 1;
  }

  for (const pattern of RUN_PATTERNS) {
    if (!pattern.tools.has(tool)) continue;
    if (state.runLength < pattern.threshold) continue;
    if (state.firedPatterns.has(pattern.id)) continue;
    state.firedPatterns.add(pattern.id);
    return `Note: that is ${state.runLength} ${tool} calls in a row. ${pattern.advice}`;
  }
  return undefined;
}
