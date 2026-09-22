/**
 * Foreground `run_command` timeout, end to end.
 *
 * This branch had two independent signals claiming it might not exist.
 * TypeScript narrows `let timedOut = false` to the literal `false` and does not
 * track the assignment inside the `setTimeout` callback, so `if (timedOut && …)`
 * type-checked as dead code (`@typescript-eslint/no-unnecessary-condition`:
 * "value is always falsy"). And no test ever fired the timer — every
 * `timeout_ms` in the suite was 20–30 s, far above any command's runtime.
 *
 * It is not dead, and it is the answer an agent gets every time it starts a dev
 * server in the foreground. What `run_command`'s own description promises:
 * "on timeout it keeps running: status \"running\" + command_id (stop:
 * force_terminate)". Each half of that is pinned below.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {mkdtempSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import { removeTempDir } from "./tmpdir.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ROOT, createRpcId, makeOpenSession, makeRawRequest, makeToolCaller,
  startBridge, stopServe,
} from "./lib/bridge-runtime.mjs";
import { setTimeout as delay } from "node:timers/promises";

let workspace;
let home;
let child;
let port;
let routeToken;
let sessionId;

/** Shared by the first two tests: the timeout answer, then proof it survived. */
let slowCommandId;

before(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), "ob-timeout-ws-"));
  home = mkdtempSync(path.join(tmpdir(), "ob-timeout-home-"));
  // Prints once immediately, once after 5 s, then exits 0.
  writeFileSync(
    path.join(workspace, "slow.mjs"),
    'console.log("first");\nsetTimeout(() => { console.log("second"); }, 5000);\n',
    "utf8",
  );
  // Never exits: the force_terminate case.
  writeFileSync(path.join(workspace, "forever.mjs"), 'setInterval(() => {}, 1000);\n', "utf8");
  // Short, but long enough that a timer firing at ~0 ms would beat it.
  writeFileSync(
    path.join(workspace, "quick.mjs"),
    'setTimeout(() => { console.log("done"); }, 300);\n',
    "utf8",
  );
  ({ child, port, routeToken } = await startBridge({ root: workspace, home }));
  sessionId = (await openSession()).sessionId;
  assert.ok(sessionId, "MCP session was established");
});

after(async () => {
  await stopServe(child);
  removeTempDir(workspace);
  removeTempDir(home);
});

test("a command that outlives timeout_ms returns as still running instead of blocking", async () => {
  const startedAt = Date.now();
  const res = asObject(await callTool("run_command", { command: "node slow.mjs", timeout_ms: 2000 }));
  const elapsed = Date.now() - startedAt;

  // The command runs 5 s. Returning in well under that is the whole point: the
  // caller is not held hostage by a foreground wait. The integration files run
  // one at a time now (--test-concurrency=1), so the cost is mostly one node
  // cold start; the bound keeps a wide margin below the 5 s completion.
  assert.ok(elapsed < 4500, `the call returned after ${elapsed} ms, not after the command's 5000 ms`);

  assert.equal(res.timed_out, true, "the answer says it timed out");
  assert.equal(res.status, "running", "and that the command is still running");
  assert.equal(res.ready, false, "it never became ready");
  assert.equal(res.exit_code, undefined, "no exit code is invented for a live process");
  assert.ok(typeof res.command_id === "string" && res.command_id.length > 0,
    `a command_id comes back for polling: ${JSON.stringify(res).slice(0, 200)}`);
  assert.match(res.message ?? "", /left alive under supervision/,
    "the message tells the caller the process was not killed");
  // 2000 ms is comfortably past node's cold start, so the first line is there.
  assert.match(res.output ?? "", /first/, "output produced before the timeout is still returned");
  assert.doesNotMatch(res.output ?? "", /second/, "and output that has not happened yet is not");

  slowCommandId = res.command_id;
});

test("the process really was left alive: it finishes on its own and the id still works", async () => {
  assert.ok(slowCommandId, "the previous test returned a command id");

  // If the timeout had killed it, this would report a terminated process and
  // "second" would never appear.
  const waited = asObject(await callTool("wait_process", { command_id: slowCommandId, timeout_ms: 10_000 }));
  assert.equal(waited.status, "completed", `the same command ran to completion: ${JSON.stringify(waited).slice(0, 300)}`);
  assert.equal(waited.exit_code, 0, "and exited cleanly");
  assert.match(waited.output ?? "", /second/, "the work after the timeout actually happened");

  const snap = asObject(await callTool("get_process_snapshot", { command_id: slowCommandId }));
  assert.equal(snap.exit_code, 0, "the snapshot agrees");
});

test("force_terminate is a real way out of a command that never exits", async () => {
  const started = asObject(await callTool("run_command", { command: "node forever.mjs", timeout_ms: 2000 }));
  assert.equal(started.timed_out, true, "an endless command times out too");
  assert.equal(started.status, "running");

  // `force_terminate` is the legacy alias the timeout message names; it routes
  // to process_control{action:"terminate"}.
  const killed = await callTool("force_terminate", { command_id: started.command_id });
  assert.equal(killed.isError, false, `the alias still works: ${killed.text.slice(0, 300)}`);

  const snap = asObject(await callTool("get_process_snapshot", { command_id: started.command_id }));
  assert.equal(snap.shell_alive, false, `the shell is gone: ${JSON.stringify(snap).slice(0, 400)}`);
  assert.equal(snap.termination_reason, "terminated", "and the snapshot says why");
});

test("terminate kills a shell tree whose children outlive the shell itself", {
  skip: process.platform !== "win32"
    ? "the atomic tree-kill path is win32-only (taskkill /T); POSIX tree-kill would need process groups"
    : false,
}, async () => {
  // Every loop iteration leaves a `sleep 30` background child that outlives any
  // single kill. The old enumerate-then-kill-each path (PowerShell full process
  // table scan, 1-4 s cold, then sequential taskkills, root LAST) burned the
  // 5 s close budget before the kills landed — and gave the loop a window to
  // respawn in between — so an orphan held the stdio pipes, 'close' neve
  // fired, and terminate honestly REFUSED a tree one atomic `taskkill /T /F`
  // handles. Empirically this exact shape refused at ~6 s; pinned live first.
  const started = asObject(await callTool("run_command", {
    command: "while true; do sleep 30 & sleep 1; done",
    background: true,
  }));
  assert.equal(started.status, "running");
  await delay(3500); // let the loop leave a couple of long-lived children behind

  const alive = asObject(await callTool("get_process_snapshot", { command_id: started.command_id }));
  assert.equal(alive.status, "running", "precondition: the bash loop is still running (Git Bash present)");

  const startedAt = Date.now();
  const killed = asObject(await callTool("process_control", { action: "terminate", command_id: started.command_id }));
  const elapsed = Date.now() - startedAt;
  assert.equal(killed.terminated, true,
    `the whole tree terminates inside the budget: ${JSON.stringify(killed).slice(0, 400)}`);
  assert.ok(elapsed < 20_000, `and it took ${elapsed} ms, not minutes`);

  const snap = asObject(await callTool("get_process_snapshot", { command_id: started.command_id }));
  assert.equal(snap.shell_alive, false, "the shell is gone");
});

test("a background command distinguishes no readiness check from a ready process", async () => {
  const started = asObject(await callTool("run_command", { command: "node forever.mjs", background: true }));
  assert.equal(started.status, "running", "background work returns immediately under supervision");
  assert.equal(started.ready, true, "the compatibility ready value is preserved when no pattern was requested");
  assert.equal(started.ready_checked, false, "callers can now distinguish no check from observed readiness");
  assert.ok(typeof started.command_id === "string" && started.command_id.length > 0);
  await callTool("process_control", { action: "terminate", command_id: started.command_id });
});

test("a garbage timeout_ms falls back to the default instead of firing at ~0 ms", async () => {
  // `Number("abc")` is NaN and `setTimeout(cb, NaN)` fires immediately, which
  // used to report a 300 ms command as "still running". The guard in
  // process-tools.ts exists for exactly this; nothing pinned it until now.
  const res = asObject(await callTool("run_command", { command: "node quick.mjs", timeout_ms: "abc" }));
  assert.equal(res.timed_out, false, `a non-numeric timeout must not fire at once: ${JSON.stringify(res).slice(0, 300)}`);
  assert.equal(res.status, "completed", "the command was waited for normally");
  assert.equal(res.exit_code, 0);
  assert.match(res.output ?? "", /done/, "and it really ran to completion");

  const zero = asObject(await callTool("run_command", { command: "node quick.mjs", timeout_ms: -5 }));
  assert.equal(zero.timed_out, false, "a negative timeout falls back too, rather than firing at once");
  assert.match(zero.output ?? "", /done/);
});

// --- harness ---------------------------------------------------------------

const rawRequest = makeRawRequest(() => port, 20_000);
const rpcId = createRpcId();
const openSession = makeOpenSession({ request: rawRequest, routeToken: () => routeToken, clientName: "process-timeout", nextId: rpcId });
const { callTool } = makeToolCaller({ request: rawRequest, routeToken: () => routeToken, nextId: rpcId, getSessionId: () => sessionId });

/** The tool's own JSON payload, or `{}` when it answered with prose. */
function asObject({ text }) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

test("start_process refuses timeout_ms and names the knob that does apply", async () => {
  // start_process has no timeout_ms. Passing one used to be accepted and then
  // ignored: the caller believed it had widened the wait while the ready loop
  // kept its own 10 s default -- which is how a slow vite/next first build gets
  // reported as "not ready". An argument that silently does nothing is worse
  // than a rejection, and this repo rejects unknown discriminator values fo
  // exactly that reason.
  const refused = await callTool("start_process", {
    command: "node forever.mjs",
    ready_pattern: "this never appears",
    timeout_ms: 4000,
  });
  assert.equal(refused.isError, true, "the argument is refused, not ignored");
  assert.match(refused.text, /timeout_ms/, "the refusal says which argument it is about");
  assert.match(refused.text, /ready_timeout_ms/,
    "and names the argument that actually controls the wait");
});

test("ready_timeout_ms is the wait, and a process that misses it is reported, not killed", async () => {
  const startedAt = Date.now();
  const res = asObject(await callTool("start_process", {
    command: "node forever.mjs",
    ready_pattern: "this never appears",
    ready_timeout_ms: 1500,
  }));
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 1200, `the wait honoured ready_timeout_ms (${elapsed} ms)`);
  assert.ok(elapsed < 8000, `and did not fall back to the 10 s default (${elapsed} ms)`);
  assert.equal(res.ready, false, "the pattern never matched");
  assert.equal(res.ready_checked, true, "the result distinguishes an attempted readiness check from an omitted one");
  assert.equal(res.status, "running", "the process is left running for the caller to poll");
  assert.ok(typeof res.command_id === "string" && res.command_id.length > 0,
    "a command_id comes back either way");
  // An endless process is not a nice thing to leave behind on the machine.
  await callTool("process_control", { action: "terminate", command_id: res.command_id });
});

test("close_shell takes the session's background jobs with it", {
  skip: process.platform !== "win32"
    ? "the MSYS process-group reap is win32-only; POSIX close relies on the shell's own exit"
    : false,
  timeout: 120_000,
}, async () => {
  // A session shell exists so jobs can outlive one send_to_shell call —
  // watchers, `npm run dev &`, `sleep 300 &`. close_shell answered closed:true
  // while leaking exactly those jobs: the graceful "exit\n" made bash exit
  // (bash does NOT take background children with it), which set cmd.done and
  // skipped the kill path entirely; and even when the kill ran, a single
  // `taskkill /T /F` cannot see MSYS exec-emulation orphans — their Windows
  // parent links point at dead intermediate pids. Same root cause as the
  // terminate-budget refusal above, different symptom: a silent leak of
  // unstoppable strays instead of an honest refusal.
  //
  // The orphans are renamed copies of sleep so this assertion cannot be
  // disturbed by the plain `sleep` other integration files run in parallel.
  const cp = asObject(await callTool("run_command", { command: "cp /usr/bin/sleep ob-sleep && echo copied", timeout_ms: 20_000 }));
  assert.match(cp.output ?? "", /copied/, "the unique orphan binary is in place");

  const name = "ob-close-tree";
  const opened = await callTool("open_shell", { name });
  assert.equal(opened.isError, false, `open_shell answered: ${opened.text.slice(0, 200)}`);

  /** Live (msys pid, winpid) pairs of our orphan binaries, per `ps -W`. */
  const alivePairs = async () => {
    const snap = asObject(await callTool("run_command", {
      command: "ps -W | awk '$8 ~ /ob-sleep/ {print $1, $4}'",
      timeout_ms: 20_000,
    }));
    return new Set(
      (snap.output ?? "").split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+ \d+$/.test(l)),
    );
  };

  let rows = [];
  try {
    const sent = asObject(await callTool("send_to_shell", {
      name,
      command: "./ob-sleep 300 & ./ob-sleep 300 & ./ob-sleep 300 & echo spawned",
      timeout_ms: 20_000,
    }));
    assert.equal(sent.timed_out, false, `backgrounding returns at once: ${JSON.stringify(sent).slice(0, 200)}`);
    assert.match(sent.output ?? "", /spawned/, "the session ran the line");

    rows = [...(await alivePairs())];
    assert.ok(rows.length >= 3, `three background jobs are visible in ps -W: ${rows.join(", ")}`);

    const closed = asObject(await callTool("close_shell", { name }));
    assert.equal(closed.closed, true, `close_shell reports closed: ${JSON.stringify(closed).slice(0, 200)}`);

    // The kill lands asynchronously: poll within a bounded budget (the same
    // 40 x 250 ms shape stop-guard uses for its teardown waits) instead of
    // sampling once after a fixed sleep, which read false red on slow machines.
    let still = await alivePairs();
    for (let i = 0; i < 40 && rows.some(row => still.has(row)); i += 1) {
      await delay(250);
      still = await alivePairs();
    }
    const survivors = rows.filter(r => still.has(r));
    assert.equal(survivors.length, 0,
      `close_shell killed the session's background jobs; survivors (msys pid, winpid): ${survivors.join(", ")}`);
  } finally {
    await callTool("close_shell", { name }).catch(() => {});
    const still = await alivePairs().catch(() => new Set());
    const strays = rows.filter(r => still.has(r));
    if (strays.length) {
      // Never leave five-minute strays on the machine, red or green. Kill by
      // the recorded MSYS pid only after re-verifying the (pid, winpid) pai
      // still exists, so a recycled pid can never be hit.
      await callTool("run_command", {
        command: strays.map(r => `kill -9 ${r.split(" ")[0]} 2>/dev/null`).join("; "),
        timeout_ms: 20_000,
      }).catch(() => {});
    }
  }
});
test("cli stop's kill fallback reaps the wedged instance's session jobs", {
  skip: process.platform !== "win32"
    ? "the MSYS process-group reap is win32-only; the POSIX fallback sends a plain signal"
    : false,
  timeout: 120_000,
}, async () => {
  // `open-bridge stop` normally asks the instance to shut down over HTTP, and
  // the instance reaps its own children (lifecycle sweeps state.commands
  // through terminateProcess). The kill fallback exists for the instance that
  // cannot answer — and it used to be a bare `taskkill /T /F` on the instance
  // pid, which reaches only the Windows-visible tree. The MSYS exec-emulation
  // children of the instance's bash sessions survive it as unstoppable strays:
  // the same root cause terminateProcess and close_shell already fixed on the
  // inside, seen from the outside. This pins the outside path to the same
  // standard: kill the family, not just the tree.
  //
  // `cli-orphan` is a renamed copy of sleep so the plain `sleep` of parallel
  // integration files cannot disturb the ps filter.
  const cp = asObject(await callTool("run_command", {
    command: "cp /usr/bin/sleep cli-orphan && echo copied",
    timeout_ms: 20_000,
  }));
  assert.match(cp.output ?? "", /copied/, "the unique orphan binary is in place");

  const name = "ob-cli-stop";
  const opened = await callTool("open_shell", { name });
  assert.equal(opened.isError, false, `open_shell answered: ${opened.text.slice(0, 200)}`);

  /** Live (msys pid, winpid) pairs of our orphan binaries, per a local `ps -W`. */
  const alivePairs = () => {
    const snap = spawnSync("bash",
      ["-c", "ps -W | awk '$8 ~ /cli-orphan/ {print $1, $4}'"],
      { encoding: "utf8", timeout: 20_000 });
    assert.equal(snap.error, undefined, `a local bash can read the MSYS table: ${String(snap.error)}`);
    return new Set(
      (snap.stdout ?? "").split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+ \d+$/.test(l)),
    );
  };

  let rows = [];
  try {
    const sent = asObject(await callTool("send_to_shell", {
      name,
      command: "./cli-orphan 300 & ./cli-orphan 300 & ./cli-orphan 300 & echo spawned",
      timeout_ms: 20_000,
    }));
    assert.equal(sent.timed_out, false, `backgrounding returns at once: ${JSON.stringify(sent).slice(0, 200)}`);
    assert.match(sent.output ?? "", /spawned/, "the session ran the line");

    rows = [...alivePairs()];
    assert.ok(rows.length >= 3, `three background jobs are visible in ps -W: ${rows.join(", ")}`);

    // Wedge the graceful path: the record keeps the REAL, alive pid (so cmdStop
    // proceeds) but its port points nowhere, so both /api/shutdown attempts
    // fail and the kill fallback runs.
    const runtimeFile = readdirSync(home)
      .map(f => path.join(home, f))
      .find(f => /^runtime-[0-9a-f]{24}\.json$/.test(path.basename(f)));
    assert.ok(runtimeFile, "the harness instance published a runtime record");
    const record = JSON.parse(readFileSync(runtimeFile, "utf8"));
    assert.equal(record.pid, child.pid, "the record names the harness server");
    record.port = 1; // nothing serves here: ECONNREFUSED, twice
    writeFileSync(runtimeFile, JSON.stringify(record), "utf8");

    const cli = await new Promise((resolve, reject) => {
      const cliChild = spawn(process.execPath,
        [path.join(ROOT, "bin", "open-bridge.js"), "stop", "--pid", String(child.pid)],
        { cwd: ROOT, env: { ...process.env, OPEN_BRIDGE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      cliChild.stdout.on("data", chunk => { stdout += chunk; });
      cliChild.stderr.on("data", chunk => { stderr += chunk; });
      const timer = setTimeout(() => {
        cliChild.kill("SIGKILL");
        reject(new Error("`open-bridge stop` did not exit within 60 s"));
      }, 60_000);
      cliChild.once("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      cliChild.once("error", reject);
    });
    assert.equal(cli.code, 0, `the fallback stop succeeded: ${(cli.stdout + cli.stderr).slice(0, 300)}`);

    const exited = await Promise.race([
      new Promise(resolve => {
        if (child.exitCode !== null) resolve(true); else child.once("exit", () => resolve(true));
      }),
      delay(10_000).then(() => false),
    ]);
    assert.ok(exited, "the fallback actually stopped the instance");

    // Same bounded poll as the close_shell case above: the reap lands
    // asynchronously, so wait for it instead of sleeping a fixed 2.5 s.
    let still = alivePairs();
    for (let i = 0; i < 40 && rows.some(row => still.has(row)); i += 1) {
      await delay(250);
      still = alivePairs();
    }
    const survivors = rows.filter(r => still.has(r));
    assert.equal(survivors.length, 0,
      `cli stop's fallback killed the session jobs with the instance; survivors (msys pid, winpid): ${survivors.join(", ")}`);
  } finally {
    // Never leave five-minute strays on the machine, red or green. Kill by the
    // recorded winpid only after re-verifying the (pid, winpid) pair still
    // exists, so a recycled pid can never be hit.
    const still = (() => { try { return alivePairs(); } catch { return new Set(); } })();
    const strays = rows.filter(r => still.has(r));
    for (const r of strays) {
      spawnSync("taskkill.exe", ["/pid", r.split(" ")[1], "/f"], { stdio: "ignore" });
    }
    await callTool("close_shell", { name }).catch(() => {});
  }
});

