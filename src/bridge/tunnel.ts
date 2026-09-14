/**
 * The public tunnel: spawn it, keep it alive, and decide who owns the domain.
 *
 * Covers the ngrok child process (spawn, readiness, tree kill), the reconnect
 * policy after a crash, the public-health probe, and the shared-domain watch that
 * either adopts a peer's tunnel or claims a domain nobody serves any more.
 *
 * It never imports the lifecycle: claiming a freed domain means restarting the
 * whole instance, which is a lifecycle decision, so that one action is injected
 * (setInstanceRestart). Everything else it needs is a leaf module, so the
 * dependency runs one way: lifecycle -> tunnel.
 */
import { host } from "../host/host.js";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { healthCheckUrl, probePublicBridge } from "../http/peers.js";
import { validateNgrokDomain } from "../http/request-policy.js";
import { isDeterministicNetworkFailure } from "../network/net-failure.js";
import { isEndpointTakenError, isFatalNgrokError, ngrokFailureSummary } from "../network/ngrok-failure.js";
import { windowsHideForChild } from "./child-console.js";
import { RECONNECT_DELAYS_MS, record, state, redactedPublicUrl } from "./state.js";
import { nextFreeRounds, shouldClaimDomain, watchIntervalMs } from "./tunnel-watch.js";
import { enqueueLifecycle } from "./lifecycle-queue.js";
import { publishSelf } from "./peer-registry.js";
import { detectNgrok } from "./ngrok-locate.js";

/** Consecutive deterministic (DNS/refused/TLS) health failures before aborting startup early. */
const PUBLIC_HEALTH_DETERMINISTIC_FAILURE_LIMIT = 3;

/** Kill the tunnel and everything it spawned; a bare kill() leaves orphans holding the domain on Windows. */
export function killTunnelTree(child: ChildProcessWithoutNullStreams | undefined): void {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 3_000,
        windowsHide: true,
      });
      return;
    } catch {
      // taskkill can refuse on an already-dead pid; fall through to kill().
    }
  }
  try { child.kill(); } catch { /* the process was already gone */ }
}

/** A ngrok startup failure (spawn error), distinct from a health-check timeout. */
class NgrokSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NgrokSpawnError";
  }
}

/**
 * Wait for the tunnel's public health endpoint while racing ngrok's own spawn
 * 'error': when the executable is missing or not runnable the failure is known
 * in milliseconds, but the health check against ngrok's edge would otherwise
 * burn the whole 20 s budget first and then report a misleading "health check
 * failed" instead of the real cause.
 */
async function waitForTunnelReady(healthUrl: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  const controller = new AbortController();
  let rejectSpawn: ((error: Error) => void) | undefined;
  const spawnError = new Promise<never>((_, reject) => { rejectSpawn = reject; });
  const onSpawnError = (error: Error): void => {
    rejectSpawn?.(new NgrokSpawnError(error.message));
  };
  // Mark both racers as handled so the loser can never surface as an
  // unhandled rejection after the winner settles.
  void spawnError.catch(() => undefined);
  child.once("error", onSpawnError);

  // ngrok can also start and then die within a second — a rejected --url, a bad
  // authtoken, a refused proxy. Without this racer those attempts sat out the
  // whole public-health budget (20 s by default) and then reported a generic
  // timeout, which the scheduler classified as transient and retried forever:
  // an endless spawn loop that republished a dead https URL on every pass.
  const tail: string[] = [];
  const collect = (chunk: Buffer): void => {
    tail.push(chunk.toString());
    if (tail.length > 40) tail.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const exited = new Promise<never>((_, reject) => {
    // 'close', not 'exit': 'exit' can fire before the process's output has been
    // drained, and an empty buffer classifies ERR_NGROK_313 as a transient blip —
    // which is precisely the endless-retry bug this racer exists to end.
    child.once("close", (code, signal) => {
      const output = tail.join("");
      const how = `code ${code}${signal ? `, signal ${signal}` : ""}`;
      reject(isFatalNgrokError(output)
        ? new NgrokSpawnError(`ngrok 拒绝了这次隧道启动（${how}）：${ngrokFailureSummary(output)}`)
        : new Error(`ngrok exited before the tunnel was ready (${how}).`));
    });
  });
  void exited.catch(() => undefined);

  const health = waitForPublicHealth(healthUrl, controller.signal);
  void health.catch(() => undefined);
  try {
    await Promise.race([health, spawnError, exited]);
  } finally {
    controller.abort();
    child.off("error", onSpawnError);
    child.stdout.off("data", collect);
    child.stderr.off("data", collect);
  }
}

async function waitForPublicHealth(url: string, abort?: AbortSignal): Promise<void> {
  const timeoutMs = host().config.get<number>("publicHealthTimeoutMs", 20_000);
  const until = Date.now() + timeoutMs;
  let last = "No response";
  let deterministicFailures = 0;
  while (Date.now() < until) {
    if (abort?.aborted) throw new Error("Startup aborted before the public health check completed.");
    // Combine the per-attempt cap with the caller's cancellation where the
    // runtime supports it (AbortSignal.any needs Node >= 20.3); on older hosts
    // the loop-top abort check above is the fallback.
    const attemptSignal = abort && typeof AbortSignal.any === "function" ? AbortSignal.any([AbortSignal.timeout(4_000), abort]) : AbortSignal.timeout(4_000);
    try {
      const response = await fetch(url, {
        headers: { "ngrok-skip-browser-warning": "true" },
        signal: attemptSignal,
      });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
      deterministicFailures = 0;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      // DNS/refused/TLS failures cannot heal by waiting; abort early instead of
      // burning the whole budget (the full timeout stays for flaky networks).
      if (isDeterministicNetworkFailure(e)) {
        deterministicFailures += 1;
        if (deterministicFailures >= PUBLIC_HEALTH_DETERMINISTIC_FAILURE_LIMIT) {
          throw new Error(
            `Public health check aborted early: the network failure is deterministic (${last}). ` +
            "If this machine reaches the internet through a proxy, ngrok must be able to connect directly "
            + "(the free plan rejects proxies; set ngrokUseHttpProxy off in the console settings page).",
          );
        }
      } else {
        deterministicFailures = 0;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error(`Public health check failed after ${timeoutMs} ms: ${last}`);
}

/** Cancels a pending reconnect: the last failure was not one retrying can heal. */
function stopReconnectChain(): void {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = undefined;
  state.reconnectAttempt = 0;
}

/**
 * Reconnect the tunnel WITHOUT tearing down the local server: all MCP sessions,
 * todo state and managed processes survive a tunnel crash. A generation guard
 * invalidates timers left behind by a stop/restart that happened in between.
 */
function scheduleReconnect(domain: string, generation: number): void {
  if (state.stopping || generation !== state.tunnelGeneration) return;
  if (!state.server) return; // local side is gone; a reconnect has nothing to attach to
  if (state.tunnelRole === "blocked") return; // another window owns the domain; watcher handles it
  if (!host().config.get<boolean>("autoReconnect", true)) {
    record("ngrok", "progress", "Tunnel exited; autoReconnect is off — the Bridge stays local-only.");
    // With no reconnect the published https URL is dead; clear it so copy and
    // status fall back to the live loopback URL instead of a vanished tunnel.
    state.tunnelRole = "none";
    state.tunnelUrl = "";
    host().ui.refresh();
    return;
  }
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 60_000;
  state.reconnectAttempt += 1;
  record("ngrok", "progress", `Tunnel exited; local Bridge stays up for live sessions. Reconnecting in ${Math.round(delay / 1000)} s.`);
  state.reconnectTimer = setTimeout(() => {
    // Clear the handle when the timer fires: a stale (already-fired) handle
    // made "is a reconnect pending?" unanswerable for startInternal's retry
    // path below.
    state.reconnectTimer = undefined;
    void enqueueLifecycle(async () => {
      if (generation !== state.tunnelGeneration || !state.server) return;
      await startTunnelInternal(generation);
    }).catch(e => {
      const message = e instanceof Error ? e.message : String(e);
      record("ngrok", "error", message);
      // A missing domain, an unusable binary or a configuration ngrok refuses
      // is deterministic — retrying cannot heal it. Stay local-only, say why
      // once, and stop arming reconnects that can never succeed.
      if (message.includes("ngrokDomain") || e instanceof NgrokSpawnError) {
        stopReconnectChain();
        host().notify("error", `隧道无法建立，已停止自动重试：${message}`);
        return;
      }
      scheduleReconnect(domain, generation);
    });
  }, delay);
}

async function adoptSharedTunnel(domain: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    if (await healthCheckUrl(`https://${domain}/healthz/${state.routeToken}`, 1_000)) {
      await watchPublicDomain(domain);
      return true;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 500));
  }
  return false;
}

export function stopPublicWatch(): void {
  // clearTimeout works on either kind of handle, and the watch re-arms itself,
  // so a single cleared handle is enough to end the chain.
  if (state.publicWatchTimer) clearTimeout(state.publicWatchTimer);
  state.publicWatchTimer = undefined;
}

/**
 * Watch the shared domain. The cadence follows the last probe: a borrowed tunnel
 * that answers is checked lazily, one that stopped answering is checked quickly —
 * measured downtime on a real holder exit was ~2 minutes under the old fixed
 * 10 s interval, most of it spent waiting for the next round (see tunnel-watch.ts).
 */
function startPublicWatch(domain: string): void {
  stopPublicWatch();
  let healthy = true;
  const schedule = (): void => {
    state.publicWatchTimer = setTimeout(() => {
      void watchPublicDomain(domain)
        .then(wasHealthy => { healthy = wasHealthy; })
        .catch(error => { record("ngrok", "error", String(error)); })
        .finally(() => { if (state.publicWatchTimer !== undefined) schedule(); });
    }, watchIntervalMs(healthy));
  };
  schedule();
}

/** One watch round. Returns whether the public endpoint is serving us. */
async function watchPublicDomain(domain: string): Promise<boolean> {
  if (await healthCheckUrl(`https://${domain}/healthz/${state.routeToken}`, 4_000)) {
    state.missingPublicRounds = 0;
    if (state.tunnelRole === "follower") return true;
    state.tunnelRole = "follower";
    // Routed through a peer tunnel again: a future tunnel exit should start
    // reconnecting at the fast end of the backoff curve, not at the 60 s cap
    // left over from the failed attempts that led here.
    state.reconnectAttempt = 0;
    state.tunnelUrl = `https://${domain}/mcp/${state.routeToken}`;
    record("bridge", "completed", `Published through a peer tunnel: ${redactedPublicUrl(state.tunnelUrl)}`);
    host().ui.refresh();
    return true;
  }
  // Only ngrok's own "no endpoint here" answer is evidence that nobody holds the
  // domain. A timeout or a 5xx while the holder reconnects is NOT evidence, and
  // a round that is merely inconclusive resets the counter — the claim below
  // spawns a tunnel, so it must not be triggered by someone else's bad minute.
  const verdict = await probePublicBridge(domain, state.routeToken);
  // A busy instance is the other claimant (a reconnect is armed, or a tunnel
  // child exists): never count towards a claim while it works. Resetting rather
  // than merely skipping keeps the rule the docs promise — *two consecutive*
  // free verdicts — so a claim can never be assembled across someone else's
  // reconnect attempt.
  const busy = Boolean(state.reconnectTimer || state.tunnel);
  state.missingPublicRounds = busy ? 0 : nextFreeRounds(state.missingPublicRounds, verdict);
  if (!shouldClaimDomain(state.missingPublicRounds, busy)) return false;
  state.missingPublicRounds = 0;
  stopPublicWatch();
  record("ngrok", "progress", "Public domain is free again; this window will claim it.");
  await claimFreedDomain();
  return true;
}

/**
 * Drop the optimistic https URL and surface the live loopback URL instead.
 * Failure paths that keep the local server alive must never leave the panel
 * advertising a dead public endpoint.
 */
function revertToLocalUrl(): void {
  state.tunnelUrl = "";
  host().ui.refresh();
}

/**
 * Owns everything tunnel-shaped. Runs on every start AND on in-place
 * reconnects; the generation guard makes stale invocations no-ops.
 */
export async function startTunnelInternal(generation: number): Promise<void> {
  if (generation !== state.tunnelGeneration || !state.server) return;
  const provider = host().config.get<string>("tunnelProvider", "ngrok");
  state.tunnelUrl = "";
  if (provider !== "ngrok") {
    state.tunnelRole = "none";
    return;
  }
  const configuredDomain = host().config.get<string>("ngrokDomain", "");
  if (!configuredDomain?.trim()) {
    // A plain `serve` with no domain configured never asked for a tunnel, so
    // this is a state, not a failure: stay local-only and say so once. The old
    // throw landed in startInternal's catch as "Tunnel failed; local Bridge
    // stays up" — an ERROR line in the activity log and the audit trail on
    // EVERY out-of-box start, burying real failures under a message the
    // operator had done nothing to earn. The Start-retry branch in
    // startInternal (tunnelRole "none", no reconnect armed) still picks the
    // tunnel up the moment a domain is saved.
    state.tunnelRole = "none";
    record("bridge", "progress", "未配置隧道域名：仅本机可用。要开公网隧道，在控制台「设置」页填写 ngrokDomain，或运行 open-bridge config set ngrokDomain <你的域名>。");
    return;
  }
  const domain = validateNgrokDomain(configuredDomain);
  if ((await probePublicBridge(domain, state.routeToken)) !== "free") {
    state.tunnelRole = "blocked";
    startPublicWatch(domain);
    // The domain is already held by another instance on this machine.
    // Advertise ourselves FIRST: the adopt probe below
    // can only succeed once the holder has a row to look our token up in, and
    // without this publish it always timed out into local-only even though the
    // running tunnel could have routed us the whole time.
    await publishSelf();
    const adopted = await adoptSharedTunnel(domain);
    record(
      "ngrok",
      "completed",
      adopted && state.tunnelUrl
        ? `Public domain belongs to another instance; serving through its tunnel: ${redactedPublicUrl(state.tunnelUrl)}`
        : "Public domain belongs to another window; this Bridge stays local until that tunnel routes it.",
    );
    return;
  }
  state.tunnelRole = "owner";
  const tunnelChild = spawnTunnel(domain, generation);
  // Published only once the tunnel answers. Setting it here advertised an https
  // endpoint for every attempt — including the ones that were about to fail —
  // so `status` and the console handed out a URL that answered nothing, which is
  // the exact lie the tunnelUrl/public_url split was introduced to end. A peer
  // tunnel sets it after its own health check for the same reason.
  const publishedUrl = `https://${domain}/mcp/${state.routeToken}`;
  try {
    await waitForTunnelReady(`https://${domain}/healthz/${state.routeToken}`, tunnelChild);
    state.reconnectAttempt = 0;
    state.tunnelUrl = publishedUrl;
    host().ui.refresh();
  } catch (error) {
    if (error instanceof NgrokSpawnError) {
      if (isEndpointTakenError(error.message)) {
        // The endpoint came online in the gap between the pre-check and the
        // spawn — the holder was mid-reconnect, or it just claimed the domain.
        // Nothing here is a configuration mistake: stay local, keep watching and
        // adopt that tunnel as soon as it routes us. (This used to throw a
        // "won't retry" error and park the instance local-only for good, while
        // the working tunnel sat right next to it.)
        state.tunnelRole = "blocked";
        killTunnelTree(state.tunnel);
        state.tunnel = undefined;
        revertToLocalUrl();
        stopReconnectChain();
        startPublicWatch(domain);
        record("ngrok", "progress", "The domain went online under another instance mid-start; staying local and watching for a route.");
        await publishSelf();
        await adoptSharedTunnel(domain);
        return;
      }
      // ngrok never bound the domain (missing executable, EACCES, ...). This is
      // deterministic: surface the real cause right away instead of after the
      // public-health budget, and stay local-only. The error type is preserved
      // (NOT wrapped into a plain Error) so scheduleReconnect's instanceof
      // guard can recognize it and stop arming reconnects that can never
      // succeed — the old wrap turned that guard into dead code and produced
      // an endless 60 s spawn-retry loop.
      state.tunnelRole = "none";
      killTunnelTree(state.tunnel);
      state.tunnel = undefined;
      revertToLocalUrl();
      // The process exit that produced this error also arms a reconnect (the exit
      // handler cannot know why it died). Cancel it: a deterministic failure must
      // not spawn ngrok again, and a pending timer would do exactly that.
      stopReconnectChain();
      throw new NgrokSpawnError(
        `${error.message} · 在「设置 → 隧道 → ngrok 可执行文件」里从探测到的列表中选一个`
        + "（没探测到就是还没装：去 https://ngrok.com/download 下载；只想本机用就把提供商改成 none）；"
        + "ERR_NGROK_9009 则是要关掉 ngrokUseHttpProxy。"
        + " 这类错误与配置有关，不会自动重试：修好后点 Start，或重新运行 open-bridge serve。",
      );
    }
    if ((await probePublicBridge(domain, state.routeToken)) !== "free") {
      state.tunnelRole = "blocked";
      startPublicWatch(domain);
      revertToLocalUrl();
      record("ngrok", "progress", "Domain was claimed mid-start; staying local and watching for a route.");
    } else {
      state.tunnelRole = "none";
      killTunnelTree(state.tunnel);
      state.tunnel = undefined;
      // Revert the optimistic https URL (the panel must not advertise an
      // endpoint no tunnel answers) and DO NOT bump tunnelGeneration: the old
      // bump invalidated every future reconnect armed with the current
      // generation, so one transient failure (e.g. DNS still down right after
      // waking from sleep) permanently stopped all self-healing. The exit
      // handler is already neutralized by clearing state.tunnel above.
      revertToLocalUrl();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} · 若域名被上一会话遗留的 ngrok 占用，请在终端执行 taskkill /IM ngrok.exe /F 后重新 Start。`,
      );
    }
  }
}

/**
 * ngrok Free rejects agents that connect through an HTTP(S) proxy
 * (ERR_NGROK_9009). Inheriting the environment is the long-standing behaviour
 * and keeps working setups untouched; opt-out strips proxy variables so ngrok
 * connects directly.
 */
function ngrokProcessEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const useProxy = host().config.get<boolean>("ngrokUseHttpProxy", true);
  if (!useProxy) {
    for (const key of Object.keys(env)) {
      if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key];
    }
  }
  return env;
}

/**
 * What to say when ngrok is not where we looked.
 *
 * The old message named the config key and stopped there, which is only
 * actionable if you already know what value to put in it. Detection knows
 * whether this machine has ngrok at all, and those are two genuinely different
 * problems: "you picked the wrong copy" (say which ones exist) versus "it is
 * not installed" (say where to get it). Both beat naming a key.
 */
export function ngrokMissingMessage(configured: string): string {
  const found = detectNgrok();
  if (found.length) {
    const list = found.map(choice => `${choice.label}: ${choice.value}`).join(" · ");
    return `ngrok executable not found (${configured}), but these copies are installed — `
      + `pick one on the console settings page (设置 → 隧道): ${list}`;
  }
  return `ngrok executable not found (${configured}). ngrok does not appear to be installed on this `
    + "machine: download it from https://ngrok.com/download, then point 设置 → 隧道 → ngrok 可执行文件 "
    + "at the unpacked file. To run loopback-only instead, set the tunnel provider to none.";
}

function spawnTunnel(domain: string, generation: number): ChildProcessWithoutNullStreams {
  // An empty stored value (the page allows clearing it back to "auto") must
  // fall back to the PATH binary instead of spawning "".
  const exe = String(host().config.get<string>("ngrokExecutable", "ngrok") ?? "").trim() || "ngrok";
  const child: ChildProcessWithoutNullStreams = state.tunnel = spawn(
    exe,
    ["http", String(state.port), "--url", `https://${domain}`, "--log", "stdout"],
    // Share our console when we have one, so closing the terminal window takes
    // the agent with it (src/bridge/child-console.ts records the measurement).
    { windowsHide: windowsHideForChild(), env: ngrokProcessEnvironment() },
  );
  child.stdout.on("data", d => {
    try {
      host().log(`[ngrok] ${d.toString().trim()}`);
    } catch { /* a log write must never take the tunnel down */ }
  });
  child.stderr.on("data", d => {
    try {
      host().log(`[ngrok] ${d.toString().trim()}`);
    } catch { /* a log write must never take the tunnel down */ }
  });
  child.once("error", e => {
    if (state.tunnel !== child) return;
    state.tunnel = undefined;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      record("ngrok", "error", ngrokMissingMessage(exe));
    } else {
      record("ngrok", "error", `ngrok failed: ${e.message}`);
    }
    host().notify("error", `ngrok failed: ${e.message}`);
    // Every spawn failure (missing executable, EACCES, EINVAL, ...) is
    // deterministic: retrying cannot heal it. Revert the optimistic public
    // URL/role so the panel does not advertise a dead https endpoint, and do
    // NOT arm a reconnect here — scheduleReconnect's catch recognizes the
    // NgrokSpawnError thrown by waitForTunnelReady and stops the chain. The
    // old fallback call to scheduleReconnect bypassed that guard and produced
    // an endless spawn-retry loop.
    state.tunnelRole = "none";
    state.tunnelUrl = "";
    host().ui.refresh();
  });
  child.once("exit", () => {
    if (state.tunnel !== child) return;
    state.tunnel = undefined;
    // The process carrying this URL is gone, so the endpoint is dead. Clearing
    // it keeps `public_url` honest while the reconnect runs; a peer tunnel
    // republishes after its own health check, and a successful reconnect
    // republishes from startTunnelInternal.
    if (state.tunnelRole !== "follower") {
      state.tunnelRole = "none";
      revertToLocalUrl();
    }
    scheduleReconnect(domain, generation);
  });
  return child;
}

let restartInstance: (() => Promise<void>) | undefined;

/**
 * Injected by lifecycle.ts at import time: the domain watch cannot restart the
 * instance itself without importing the module that starts it.
 */
export function setInstanceRestart(fn: () => Promise<void>): void {
  restartInstance = fn;
}

/** Claim a freed shared domain by restarting this instance onto it. */
async function claimFreedDomain(): Promise<void> {
  if (!restartInstance) {
    throw new Error("setInstanceRestart() must run before the domain watch (lifecycle.ts does it at import time).");
  }
  await restartInstance();
}
