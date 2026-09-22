/**
 * Peer registry publication.
 *
 * Windows shares one public tunnel between instances, so each instance advertises
 * its route token and loopback port in a shared registry (file format and proxy
 * live in http/peers.ts). This module owns the policy: which registries we write,
 * when we may advertise ourselves at all, and the periodic re-publish that heals
 * a lost read-merge-write race.
 */
import { host } from "../host/host.js";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { peerRegistryCandidates, publishPeerTo, withdrawPeerFrom } from "../http/peers.js";
import { CONFIG_DEFAULTS } from "./config-defaults.js";
import { record, state } from "./state.js";

// Windows share one public tunnel: each instance advertises its token and loopback port,
// and whichever owns ngrok forwards requests addressed to a peer token.
function peersFile(): string {
  const storage = host().storageDir();
  return storage ? path.join(storage, "bridge-peers.json") : "";
}

/**
 * Every registry this instance advertises itself in.
 *
 * Its own comes first; the rest are the ones another Open Bridge build on this
 * machine already keeps (each build keeps its own registry file).
 * Without them the two instances cannot see each other, so the app can neither
 * serve requests that arrive through an existing tunnel nor borrow it — see
 * peerRegistryCandidates. `sharedPeerRegistry` replaces the discovery with one
 * explicit path for setups the guess does not cover.
 */
function sharedPeerFiles(): string[] {
  const own = peersFile();
  if (!own) return [];
  const override = host().config.get<string>("sharedPeerRegistry", "").trim();
  if (override) return [override];
  return peerRegistryCandidates(own, {
    appData: process.platform === "win32" ? process.env.APPDATA : undefined,
    configHome: process.platform === "linux"
      ? process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, ".config") : undefined)
      : undefined,
    libraryHome: process.platform === "darwin" && process.env.HOME
      ? path.join(process.env.HOME, "Library", "Application Support")
      : undefined,
  }, file => fsSync.existsSync(file)).slice(1);
}

/** Registries to READ peers from: ours, plus any the machine already has. */
export function readablePeerFiles(): string[] {
  const own = peersFile();
  return own ? [own, ...sharedPeerFiles()] : [];
}

/**
 * Registries to ADVERTISE ourselves in.
 *
 * Advertising in someone else's registry is what makes their tunnel route our
 * token to us — it publishes this instance. So it happens only while a tunnel is
 * actually in play: `--no-tunnel` (tunnelProvider none) or an empty domain means
 * local-only, and local-only must not become reachable from the internet through
 * a tunnel this machine merely happens to run for something else.
 */
function publishablePeerFiles(): string[] {
  const own = peersFile();
  if (!own) return [];
  const cfg = host().config;
  const publishes = tunnelInPlay(
    String(cfg.get<string>("tunnelProvider", CONFIG_DEFAULTS.tunnelProvider as string)),
    String(cfg.get<string>("ngrokDomain", "") ?? ""),
    String(cfg.get<string>("tailscaleDomain", "") ?? ""),
  );
  return publishes ? [own, ...sharedPeerFiles()] : [own];
}

/**
 * Is a public tunnel actually in play for this configuration?
 *
 * The one question that decides whether this instance advertises into OTHER
 * builds' registries — and therefore whether their tunnel can route our token
 * here. It used to be asked with ngrok in mind only, so an instance serving the
 * Tailscale funnel published itself into its own file and nowhere else. On a
 * machine where two instances share the single 443 funnel — tailscale's version
 * of ngrok Free's one-domain budget, i.e. exactly the case the sharing exists
 * for — neither could see the other, and the failure was silent: nothing in the
 * log says "I did not publish".
 *
 * Each provider is asked about its own address: `--no-tunnel` with a leftover
 * ngrok domain still stored publishes nothing, and a tailscale instance is
 * published once discovery has filled its domain in (before that there is no
 * address to serve, which is the same state as ngrok with no domain).
 */
export function tunnelInPlay(provider: string, ngrokDomain: string, tailscaleDomain: string): boolean {
  if (provider === "ngrok") return Boolean(ngrokDomain.trim());
  if (provider === "tailscale") return Boolean(tailscaleDomain.trim());
  return false;
}

export async function publishSelf(): Promise<void> {
  const files = publishablePeerFiles();
  if (!files.length || !state.routeToken || !state.port) return;
  const results = await publishPeerTo(files, {
    token: state.routeToken,
    port: state.port,
    pid: process.pid,
    root: state.activeWorkspaceRoot,
    at: Date.now(),
  });
  state.peersRegistered = results.some(result => result.ok);
  for (const failed of results.filter(result => !result.ok)) {
    record("bridge", "error", `Peer registry write failed (${failed.file}): ${failed.error}`);
  }
}

export async function withdrawSelf(): Promise<void> {
  // Withdraw from every registry we might have advertised in: a row left behind
  // in the tunnel owner's file would keep routing traffic to a dead port.
  const files = readablePeerFiles();
  if (!files.length || !state.routeToken || !state.peersRegistered) return;
  state.peersRegistered = false;
  // Best-effort by nature: a stale row must never block a shutdown, and the
  // readers drop rows whose pid is gone anyway. A failure is still recorded,
  // because a registry we cannot write is worth knowing about.
  for (const failed of (await withdrawPeerFrom(files, state.routeToken)).filter(result => !result.ok)) {
    record("bridge", "error", `Peer registry cleanup failed (${failed.file}): ${failed.error}`);
  }
}

export function stopRepublishLoop(): void {
  if (state.rePublishTimer) clearInterval(state.rePublishTimer);
  state.rePublishTimer = undefined;
}

/**
 * Re-assert our peer registry entry periodically. The shared file is a plain
 * read-merge-write JSON blob: two windows publishing concurrently can lose a
 * row (last writer wins), which would leave the loser unreachable through the
 * shared tunnel until it republishes. A 30 s re-publish heals that quickly.
 */
export function startRepublishLoop(): void {
  stopRepublishLoop();
  state.rePublishTimer = setInterval(() => { void publishSelf(); }, 30_000);
}
