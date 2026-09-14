/**
 * Isolated evaluation of user-supplied regular expressions (merged module,
 * formerly safe-regex.ts + ready-pattern.ts):
 *
 * A pathological pattern (catastrophic backtracking, e.g. `(a+)+$`) can burn
 * CPU forever. Evaluating patterns in a worker thread with a hard timeout
 * means the worst case is a terminated worker — the Bridge process
 * never freezes.
 *
 * - `matchLinesInWorker`: batch line matching for the search_files fallback.
 * - `testReadyPattern` / `validateReadyPattern`: single-shot readiness-pattern
 *   check for start_process (kept as its own single-shot variant so its error
 *   contract stays unchanged).
 */
import { Worker } from "node:worker_threads";

const WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  try {
    const expression = new RegExp(workerData.pattern);
    if (workerData.lines) {
      const indices = [];
      for (let i = 0; i < workerData.lines.length; i += 1) {
        if (expression.test(workerData.lines[i])) indices.push(i);
      }
      parentPort.postMessage({ indices });
    } else {
      parentPort.postMessage({ matched: expression.test(workerData.text) });
    }
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
`;

export class SafeRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeRegexError";
  }
}

export class ReadyPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadyPatternError";
  }
}

/** Per-batch evaluation budget for the search fallback. */
export const SAFE_REGEX_BATCH_TIMEOUT_MS = 1_000;

/** Reject malformed patterns before a process is started. */
export async function validateReadyPattern(pattern: string): Promise<void> {
  await testReadyPattern(pattern, "", 1_000);
}

/**
 * Return the indices of `lines` matching `pattern`, evaluating in a worker.
 * Rejects with SafeRegexError on malformed patterns, worker failures, or when
 * evaluation exceeds `timeoutMs` (catastrophic backtracking guard).
 */
export async function matchLinesInWorker(
  pattern: string,
  lines: string[],
  timeoutMs: number = SAFE_REGEX_BATCH_TIMEOUT_MS,
): Promise<number[]> {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new SafeRegexError("regex pattern must be a non-empty string.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("regex timeout must be a positive safe integer.");
  }

  return new Promise<number[]>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, lines },
    });
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new SafeRegexError(
          `Regex evaluation exceeded ${timeoutMs} ms and was stopped (possible catastrophic backtracking in pattern).`,
        ));
      });
    }, timeoutMs);

    worker.once("message", (message: unknown) => {
      const result = message as { indices?: unknown; error?: unknown };
      if (typeof result.error === "string") {
        finish(() => reject(new SafeRegexError(`Invalid regex: ${result.error}`)));
        return;
      }
      if (!Array.isArray(result.indices) || !result.indices.every(i => Number.isSafeInteger(i))) {
        finish(() => reject(new SafeRegexError("Regex worker returned an invalid result.")));
        return;
      }
      finish(() => resolve(result.indices as number[]));
    });
    worker.once("error", error => {
      finish(() => reject(new SafeRegexError(`Regex worker failed: ${error.message}`)));
    });
    worker.once("exit", code => {
      if (code !== 0) {
        finish(() => reject(new SafeRegexError(`Regex worker exited with code ${code}.`)));
      }
    });
  });
}

/**
 * Compile and evaluate a caller-provided readiness regular expression outside
 * a worker thread. A pathological expression can consume a worker, but it
 * cannot freeze the Bridge process.
 */
export async function testReadyPattern(
  pattern: string,
  text: string,
  timeoutMs: number,
): Promise<boolean> {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new ReadyPatternError("ready_pattern must be a non-empty string.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("ready pattern timeout must be a positive safe integer.");
  }

  return new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, text },
    });
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new ReadyPatternError(`ready_pattern evaluation exceeded ${timeoutMs} ms and was stopped.`));
      });
    }, timeoutMs);

    worker.once("message", (message: unknown) => {
      const result = message as { matched?: unknown; error?: unknown };
      if (typeof result.error === "string") {
        finish(() => reject(new ReadyPatternError(`Invalid ready_pattern: ${result.error}`)));
        return;
      }
      if (typeof result.matched !== "boolean") {
        finish(() => reject(new ReadyPatternError("ready_pattern worker returned an invalid result.")));
        return;
      }
      finish(() => resolve(result.matched === true));
    });
    worker.once("error", error => {
      finish(() => reject(new ReadyPatternError(`ready_pattern worker failed: ${error.message}`)));
    });
    worker.once("exit", code => {
      if (code !== 0) {
        finish(() => reject(new ReadyPatternError(`ready_pattern worker exited with code ${code}.`)));
      }
    });
  });
}
