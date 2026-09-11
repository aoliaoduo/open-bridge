/**
 * Refusing to stop the instance that is running the command.
 *
 * `open-bridge stop` asks an instance to shut itself down, and a client driving
 * this machine through the bridge can type that command wherever it can run a
 * shell — including into the very instance that hosts its session. That stop is
 * the one mistake such a client cannot recover from on its own: the MCP URL goes
 * dead mid-answer and a web client has no local console left to talk to, so the
 * human has to notice and start it again by hand.
 *
 * The marker below makes the refusal exact instead of a blanket rule. A serving
 * process stamps its own pid into `OPEN_BRIDGE_HOST_PID` once, and every child
 * it spawns (run_command, shells, services, the tunnel) inherits it. `stop`
 * refuses only when the pid it is about to stop equals that inherited value —
 * i.e. when the command was issued from inside the instance being stopped. A
 * human in their own terminal carries no marker, stopping *another* instance is
 * never blocked, and `--force` overrides in every case.
 */

export const HOST_PID_ENV = "OPEN_BRIDGE_HOST_PID";

/** Stamp this process as the host of everything it is about to spawn. */
export function markHostProcess(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): void {
  env[HOST_PID_ENV] = String(pid);
}

/**
 * The refusal text for a stop that would kill the instance running the command,
 * or null when the stop is legitimate: no marker, a different instance's marker,
 * or a marker that is not a pid at all (a foreign environment variable must not
 * be able to block a real stop).
 */
export function selfStopRefusal(
  env: NodeJS.ProcessEnv,
  targetPid: number,
  consoleUrl: string,
): string | null {
  const marker = env[HOST_PID_ENV];
  if (marker === undefined || !/^\d+$/.test(marker)) return null;
  if (Number(marker) !== targetPid) return null;
  return `拒绝停止 pid ${targetPid}：这条命令就是由它自己启动的（它正在承载你此刻的连接）。`
    + "停掉它等于立刻断线，而且只能由人从外部把它重新拉起来。"
    + `\n  要真的停，请由人在终端里执行 open-bridge stop --force；它的控制台: ${consoleUrl}`;
}
