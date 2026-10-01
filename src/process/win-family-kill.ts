/**
 * Kill a Windows process FAMILY: the whole Windows-visible tree plus the
 * members Windows parent links cannot see.
 *
 * Host-free on purpose. The Bridge reaches this through processes.ts
 * (terminateProcess) and shell-sessions.ts (closeShell), but `open-bridge
 * stop`'s kill fallback — the rescue path for an instance too wedged to answer
 * its own /api/shutdown — needs the exact same semantics from the CLI
 * process, where no host is installed and the shell must be passed in
 * explicitly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isBashLikeShell } from "./tee-capture.js";

const execFileAsync = promisify(execFile);

export type WindowsProcessRow = {
  ProcessId?: number;
  ParentProcessId?: number;
};

/** Pure tree projection, exported so the no-self-kill invariant can be pinned. */
export function descendantPidsFromRows(rootPid: number, rows: WindowsProcessRow[]): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const pid = Number(row.ProcessId);
    const parent = Number(row.ParentProcessId);
    if (pid > 0 && parent > 0) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const result: number[] = [];
  const seen = new Set<number>();
  const visit = (pid: number): void => {
    if (seen.has(pid)) return;
    seen.add(pid);
    for (const child of children.get(pid) ?? []) visit(child);
    result.push(pid);
  };
  visit(rootPid);
  return result;
}

/** The caller and all of its Windows ancestors are never legitimate kill targets. */
export function ancestorPidsFromRows(startPid: number, rows: WindowsProcessRow[]): number[] {
  const parentByPid = new Map<number, number>();
  for (const row of rows) {
    const pid = Number(row.ProcessId);
    const parent = Number(row.ParentProcessId);
    if (pid > 0 && parent >= 0) parentByPid.set(pid, parent);
  }
  const result: number[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    result.push(pid);
    pid = parentByPid.get(pid) ?? 0;
  }
  return result;
}

/**
 * Caller ancestry used by destructive Windows tree cleanup.
 *
 * If the caller itself is absent from the process snapshot, the snapshot is
 * not trustworthy enough to prove that a target is outside caller ancestry.
 * Failing open here is dangerous because taskkill /T against an ancestor also
 * kills the current Bridge/test runner. The immediate parent is added again as
 * an independent guard against a stale parent chain.
 */
export function protectedCallerPidsFromRows(
  callerPid: number,
  callerParentPid: number,
  rows: WindowsProcessRow[],
): number[] {
  if (!rows.some(row => Number(row.ProcessId) === callerPid)) {
    throw new Error("Cannot safely terminate a Windows process family: caller is missing from the process snapshot.");
  }
  const protectedPids = new Set(ancestorPidsFromRows(callerPid, rows));
  protectedPids.add(callerPid);
  if (Number.isSafeInteger(callerParentPid) && callerParentPid > 0) protectedPids.add(callerParentPid);
  return [...protectedPids];
}

async function windowsProcessRows(): Promise<WindowsProcessRow[]> {
  if (process.platform !== "win32") return [];
  const script =
    "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $rows | ConvertTo-Json -Compress";
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 5000 },
  );
  const parsed = JSON.parse(result.stdout || "[]") as WindowsProcessRow | WindowsProcessRow[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Enumerate a process tree on Windows so the whole shell job can be killed. */
async function descendantPids(rootPid: number, rows?: WindowsProcessRow[]): Promise<number[]> {
  if (process.platform !== "win32" || !rootPid) return [rootPid];
  try {
    return descendantPidsFromRows(rootPid, rows ?? await windowsProcessRows());
  } catch {
    return [rootPid];
  }
}

/**
 * Kill the MSYS process GROUPS of a Windows-visible process family.
 *
 * Windows parent links do not survive MSYS fork/exec emulation: every external
 * child (sleep, node, ...) is spawned through a short-lived intermediate that
 * exits at once, leaving orphans whose ParentProcessId points at a dead pid —
 * `taskkill /T` and the CIM walk both MISS them, they keep the stdio pipes
 * open, 'close' never fires, and terminate degrades into an honest refusal
 * (empirically: a `while true; do sleep 30 & sleep 1; done` tree refused at
 * ~6-10 s with the root bash dead and every sleep alive).
 *
 * The MSYS process table still knows the real family: the running
 * `/usr/bin/bash` executor — whose MSYS PPID reparents to 1, so it is only
 * reachable through its intact WINDOWS link to the win32 launcher we spawned —
 * leads a process group that every loop child shares. Native children spawned
 * by the executor inherit that group too (probed: `node &` under a bash
 * executor shows the executor's PGID in `ps -W`), so one group kill reaps
 * MSYS and native strays alike, while processes spawned native→native (the
 * Bridge itself, detached tools) report PGID 0 and are never touched here.
 *
 * Group 0 must NEVER be killed: processes spawned from non-MSYS parents report
 * PGID 0, and so does every unrelated system process in `ps -W` — a group-0
 * kill is a massacre (probed empirically: it signalled the probing shell
 * itself). Hence the `$3>0` awk guard and the `-gt 0` test.
 */
async function terminateMsysGroups(
  winPids: number[],
  protectedWinPids: ReadonlySet<number>,
  shellFile: string,
): Promise<void> {
  if (!isBashLikeShell(shellFile) || winPids.length === 0) return;
  const list = winPids.filter(n => Number.isSafeInteger(n) && n > 0).join(" ");
  const protectedList = [...protectedWinPids].filter(n => Number.isSafeInteger(n) && n > 0).join(" ");
  if (!list) return;
  // A process group can escape the Windows parent tree when MSYS fork/exec
  // reparents children. Never signal a group containing this CLI/Bridge or any
  // of its ancestors: a self-hosted release check may legitimately be testing
  // a child Bridge from inside the Bridge that is carrying the current MCP call.
  //
  // Take ONE ps snapshot. The first protected implementation ran `ps -W` once
  // per candidate-group × ancestor pair; under the full integration suite that
  // could burn the helper's entire 5 s budget before any group received SIGKILL,
  // leaking an orphan that kept the child's stdio open and prevented `close`.
  const script =
    `ps -W | awk -v targets="${list}" -v protected="${protectedList || "0"}" '` +
    `BEGIN { nt=split(targets,a," "); for(i=1;i<=nt;i++) target[a[i]]=1; ` +
    `np=split(protected,a," "); for(i=1;i<=np;i++) guard[a[i]]=1 } ` +
    `$3>0 { if(target[$4]) candidate[$3]=1; if(guard[$4]) blocked[$3]=1 } ` +
    `END { for(g in candidate) if(!blocked[g]) print g }' ` +
    `| while read -r g; do kill -9 -- -"$g" 2>/dev/null; done`;
  try {
    await execFileAsync(shellFile, ["-c", script], { windowsHide: true, timeout: 5000 });
  } catch { /* family already gone, ps unavailable, or the helper refused — taskkill follows */ }
}

/**
 * Kill a Windows process family, MSYS-aware. Shared by terminateProcess,
 * closeShell, and the CLI stop fallback so the three cannot drift apart — the
 * CLI's bare `taskkill /T /F` predated the MSYS group fix and silently leaked
 * the wedged instance's session background jobs.
 *
 * bash-like shells: enumerate the Windows-visible members, kill their MSYS
 * process groups FIRST (the only view that still knows the real family, and
 * discoverable only while the members live), then taskkill the members.
 * Native shells (PowerShell/cmd): Windows parent links are intact, so one
 * atomic `taskkill /T /F` ends the whole family.
 */
export async function killWindowsProcessFamily(pid: number, shellFile: string): Promise<void> {
  let rows: WindowsProcessRow[] = [];
  try {
    rows = await windowsProcessRows();
  } catch (error) {
    if (process.platform === "win32") {
      throw new Error(
        `Cannot safely terminate Windows process family ${pid}: process snapshot failed: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  const protectedPids = process.platform === "win32"
    ? new Set(protectedCallerPidsFromRows(process.pid, process.ppid, rows))
    : new Set([process.pid, process.ppid].filter(value => value > 0));
  const pids = await descendantPids(pid, rows.length > 0 ? rows : undefined);
  const protectedTarget = pids.find(targetPid => protectedPids.has(targetPid));
  if (protectedTarget !== undefined) {
    throw new Error(`Refusing to terminate protected process ${protectedTarget} in caller ancestry.`);
  }
  if (isBashLikeShell(shellFile)) {
    await terminateMsysGroups(pids, protectedPids, shellFile);
    // The group kill handles MSYS-orphaned jobs. For the Windows-visible tree,
    // prefer one atomic /T kill over the old sequential pid loop: under load a
    // long list can otherwise spend the close budget killing descendants one by
    // one while the shell continues to spawn replacements. If the group kill
    // already removed the root, /T naturally refuses; in that case kill the
    // pre-snapshotted members concurrently as a best-effort cleanup.
    let rootTreeKilled = false;
    try {
      await execFileAsync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 3000,
      });
      rootTreeKilled = true;
    } catch { /* group kill may already have removed the root */ }
    if (!rootTreeKilled) {
      await Promise.all(pids.map(async targetPid => {
        try {
          await execFileAsync("taskkill.exe", ["/pid", String(targetPid), "/f"], {
            windowsHide: true,
            timeout: 3000,
          });
        } catch { /* taskkill refuses an already-dead pid */ }
      }));
    }
  } else {
    try {
      await execFileAsync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 3000,
      });
    } catch { /* taskkill refuses an already-dead pid; the caller's kill() follows */ }
  }
}
