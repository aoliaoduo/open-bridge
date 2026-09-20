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

const execFileAsync = promisify(execFile);

/** Enumerate a process tree on Windows so the whole shell job can be killed. */
async function descendantPids(rootPid: number): Promise<number[]> {
  if (process.platform !== "win32" || !rootPid) return [rootPid];
  try {
    const script =
      "$rows = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $rows | ConvertTo-Json -Compress";
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 5000 },
    );
    const rows = JSON.parse(result.stdout || "[]") as Array<{
      ProcessId?: number;
      ParentProcessId?: number;
    }>;
    const children = new Map<number, number[]>();
    for (const row of rows) {
      const pid = Number(row.ProcessId);
      const parent = Number(row.ParentProcessId);
      if (pid && parent) children.set(parent, [...(children.get(parent) ?? []), pid]);
    }
    const resultPids: number[] = [];
    const visit = (pid: number): void => {
      for (const child of children.get(pid) ?? []) {
        visit(child);
        resultPids.push(child);
      }
    };
    visit(rootPid);
    resultPids.push(rootPid);
    return [...new Set(resultPids)];
  } catch {
    return [rootPid];
  }
}

/**
 * True when `file` is a POSIX-style (MSYS) shell whose process family shares a
 * group. Takes the path explicitly so host-less callers (the CLI stop
 * fallback) can use it too; the Bridge passes its configured shellSpec().
 */
export function shellIsBashLike(file: string): boolean {
  const n = file.toLowerCase().replace(/\\/g, "/");
  return n.includes("bash") || n.endsWith("/sh") || n.endsWith("/sh.exe") || n.includes("/bin/sh");
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
async function terminateMsysGroups(winPids: number[], shellFile: string): Promise<void> {
  if (!shellIsBashLike(shellFile) || winPids.length === 0) return;
  const list = winPids.filter(n => Number.isSafeInteger(n) && n > 0).join(" ");
  if (!list) return;
  const script =
    `for w in ${list}; do ps -W | awk -v w="$w" '$4==w && $3>0 {print $3}'; done | sort -u ` +
    `| while read -r g; do if [ "$g" -gt 0 ] 2>/dev/null; then kill -9 -- -"$g" 2>/dev/null; fi; done`;
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
  if (shellIsBashLike(shellFile)) {
    const pids = await descendantPids(pid);
    await terminateMsysGroups(pids, shellFile);
    for (const targetPid of pids) {
      try {
        await execFileAsync("taskkill.exe", ["/pid", String(targetPid), "/f"], {
          windowsHide: true,
          timeout: 3000,
        });
      } catch { /* taskkill refuses an already-dead pid */ }
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
