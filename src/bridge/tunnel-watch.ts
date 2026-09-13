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

import type { PublicBridgeVerdict } from "../http/peers.js";

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
