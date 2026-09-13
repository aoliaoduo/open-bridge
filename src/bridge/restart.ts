/**
 * Restarting the instance so a new build is actually loaded.
 *
 * A rebuild does nothing to a *running* process: Node has already loaded the old
 * modules into memory, and the lifecycle's stop/start (`setInstanceRestart`,
 * used when a follower claims a freed public domain) rebinds the listener inside
 * the same process. That is right for the domain handover and wrong for an
 * update — no amount of in-process stopping and starting reloads a module. The
 * console used to tell the operator to stop and then start for exactly this,
 * which was wrong twice over: stopping closes the listener that serves the
 * console, so the 启动 button is gone, and even a successful in-process start
 * would still be the old code.
 *
 * So an operator-facing restart hands over: this process stops, starts a
 * successor with its own command line, and exits. The successor is detached on
 * purpose — it has to outlive the process that spawned it, or the old process's
 * exit (and its shutdown deadline) would take the new instance down with it. The
 * trade-off is stated in the console: after a web-triggered restart the instance
 * is a background process, so it is stopped from the console's 退出进程 or with
 * `open-bridge stop`, not by closing the original window.
 *
 * Deliberately free of host imports: every function here takes the paths it needs
 * (the runtime record is passed in, computed by the CLI that owns its naming), so
 * the whole module is testable without standing up a host, a state or a config.
 */
import * as fs from "node:fs";
import { spawn } from "node:child_process";

/** How to start this instance again: the same executable, the same arguments. */
export interface SuccessorPlan {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Replay this process's own command line, as an argv array.
 *
 * No shell and no quoting: `spawn` takes the arguments separately, and rebuilding
 * a command *line* would break on exactly the paths that matter (spaces in a
 * Windows workspace path). `argv[0]` is the interpreter, which is why the plan
 * pairs `execPath` with `argv.slice(1)` instead of reusing argv[0] blindly.
 */
export function successorPlan(argv: readonly string[], execPath: string, cwd: string): SuccessorPlan {
  const script = argv[1];
  if (!script) {
    throw new Error("this process was started without a script argument, so its command line cannot be replayed.");
  }
  return { command: execPath, args: [...argv.slice(1)], cwd };
}

/** The pid in a runtime record, or undefined when it is missing, unreadable or corrupt. */
export function recordedPid(runtimeFile: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeFile, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

/** Start the successor detached, with no inherited stdio. Resolves with its pid. */
export function spawnSuccessor(plan: SuccessorPlan): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      if (child.pid === undefined) reject(new Error("the successor started without a pid."));
      else resolve(child.pid);
    });
  });
}

/**
 * Wait for the successor to publish its runtime record — the moment its listener
 * bound, which is the earliest proof it is up.
 *
 * The record is removed before the successor starts, so a leftover file cannot
 * satisfy this; comparing the pid is the second half of that guarantee (the
 * successor writes its own).
 */
export async function waitForSuccessor(runtimeFile: string, pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (recordedPid(runtimeFile) === pid) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
