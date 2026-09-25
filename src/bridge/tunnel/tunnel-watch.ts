/**
 * When to look at the public domain, and when to claim it.
 *
 * A Bridge that is serving through *someone else's* tunnel (role "follower") is
 * one process death away from being unreachable from the internet: the holder
 * disappears, ngrok's edge goes offline, and nothing tells the follower until it
 * looks. The reference point is a real incident — the holder (another
 * instance) was closed, and this instance did reclaim the domain on its own
 * (bridge.log: "Public domain is free again; this window will claim it." 2 min
 * later), and those two minutes were pure downtime for every remote client.
 *
 * Two rules, both pure so they can be tested without a tunnel:
 *
 *  - **Probe lazily while healthy, quickly while not.** A borrowed tunnel that is
 *    answering does not need attention ten times a minute; one that has stopped
 *    answering is exactly when the domain may be free, and every probe cycle
 *    spent waiting is a cycle of downtime.
 *  - **Only two consecutive `free` verdicts claim.** "free" means ngrok itself
 *    said there is no endpoint here. A timeout, a 5xx or a live-but-not-ours
 *    answer is not evidence, and the status quo claim decision (2 rounds) is kept
 *    deliberately: a claim spawns ngrok, and claiming on a guess is how two
 *    instances end up fighting over one reserved domain.
 */

import type { PublicBridgeVerdict } from "../../http/peers.js";

/** Healthy borrowed tunnel: a slow, cheap check. */
export const WATCH_INTERVAL_HEALTHY_MS = 10_000;
/** The public endpoint stopped serving us: look again soon. */
export const WATCH_INTERVAL_UNHEALTHY_MS = 4_000;
/** Consecutive `free` verdicts required before this instance claims the domain. */
export const CLAIM_FREE_ROUNDS = 2;

/**
 * How long to wait before the next public probe. `healthy` is the *previous*
 * probe's outcome, so a follower that just lost its tunnel switches to the fast
 * cadence for the very next round.
 */
export function watchIntervalMs(healthy: boolean): number {
  return healthy ? WATCH_INTERVAL_HEALTHY_MS : WATCH_INTERVAL_UNHEALTHY_MS;
}

/**
 * The new consecutive-`free` counter after one probe: `free` increments it, and
 * anything else — including `mine` (we are being routed) and `unknown` (the edge
 * could not answer) — resets it to zero.
 */
export function nextFreeRounds(current: number, verdict: PublicBridgeVerdict): number {
  return verdict === "free" ? current + 1 : 0;
}

/**
 * May this instance spawn ngrok for the domain right now? `busy` is
 * `reconnectTimer || tunnel`: the reconnect chain is the other claimant, and two
 * claimants race each other.
 */
export function shouldClaimDomain(freeRounds: number, busy: boolean): boolean {
  return freeRounds >= CLAIM_FREE_ROUNDS && !busy;
}

/**
 * The self-rescheduling watch chain, separated from tunnel.ts so the
 * retirement rule is unit-testable without a tunnel.
 *
 * The rule a bare timer handle cannot express: the handle is SPENT the moment
 * it fires, so a stop (or a claim taking over the slot) during a round in
 * flight could not reach the chain — the round's `.finally` re-armed a ghost
 * chain that kept claiming free domains and could restart a deliberately
 * stopped instance. Each chain therefore carries a generation: `stop()` bumps
 * it, and a retired round's finally is a no-op. A round receives its own
 * generation so its BODY can re-check before any irreversible action (a
 * claim), not only before the reschedule.
 */
export interface WatchChain {
  /** Run rounds forever (until stop) with the recorded cadence. */
  start(): void;
  /** Retire the chain: pending timers are cancelled and an in-flight round
      will neither act nor reschedule. */
  stop(): void;
  /** The chain's current generation; bumped by every stop. */
  generation(): number;
}

export function createWatchChain(options: {
  /** One round. `chain` is this chain's generation at arm time — compare it
      against `generation()` before acting irreversibly. */
  round: (chain: number) => Promise<boolean>;
  /** Wait before the next round; receives the last round's outcome. */
  intervalMs: (healthy: boolean) => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  onError: (error: unknown) => void;
}): WatchChain {
  let generation = 0;
  let handle: unknown;
  let healthy = true;
  const schedule = (chain: number): void => {
    handle = options.setTimer(() => {
      handle = undefined;
      void options.round(chain)
        .then(wasHealthy => { healthy = wasHealthy; })
        .catch(error => options.onError(error))
        .finally(() => {
          // Reschedule only while this chain is still current: a newer stop()
          // owns the slot now, and the spent-handle rule means a cleared
          // handle alone can never reach an in-flight round.
          if (chain === generation && handle === undefined) schedule(chain);
        });
    }, options.intervalMs(healthy));
  };
  const chain: WatchChain = {
    start() {
      // Clear a pending round WITHOUT bumping: only an explicit stop() retires
      // a chain (tunnel.ts always stop()s the previous chain before arming a
      // new one, so a fresh start carries generation 0).
      if (handle !== undefined) {
        options.clearTimer(handle);
        handle = undefined;
      }
      schedule(generation);
    },
    stop() {
      generation += 1;
      if (handle !== undefined) options.clearTimer(handle);
      handle = undefined;
    },
    generation() {
      return generation;
    },
  };
  return chain;
}
