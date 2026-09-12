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
 * machine already keeps (the VS Code extension uses the editor's globalStorage).
 * Without them the two products cannot see each other, so the app can neither
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
  const wantsTunnel = host().config.get<string>("tunnelProvider", "ngrok") === "ngrok"
    && Boolean(host().config.get<string>("ngrokDomain", "").trim());
  return wantsTunnel ? [own, ...sharedPeerFiles()] : [own];
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
