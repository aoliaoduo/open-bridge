/**
 * Who holds port 443 on this machine's tailnet name — the evidence side of the
 * shared public-endpoint watch, for the provider that has no edge to ask.
 *
 * The ngrok path asks the edge a direct question ("is anyone serving this
 * reserved domain?") and can trust a `free` answer. Funnel has no such edge: the
 * ts.net name belongs to THIS node, and the only possible holder is another
 * Bridge instance on this machine that has already written a 443 mount into the
 * daemon's serve config. `tailscale funnel status --json` is that config, and it
 * is the only truthful source here — the web has no record of a mount that was
 * switched off, and the daemon holds the mount across instance restarts.
 *
 * The rule this module encodes, and the reason it is not simply "is 443 mine?":
 *
 *   - a mount pointing at OUR port is ours, leave it alone;
 *   - a mount pointing at a port that is still listening belongs to a live
 *     instance that is routing traffic right now: following it is correct,
 *     displacing it with `funnel --bg` is a hijack (the daemon keeps ONE mount
 *     per port), and it is how one instance's stop-switch would tear down the
 *     other's public access;
 *   - a mount pointing at a port nobody serves is a leftover from an instance
 *     that died without running `funnel off`. The release HAS happened; waiting
 *     for the config to disappear would wait forever;
 *   - a CLI that did not answer is never evidence of freedom. Claiming on that
 *     is how two instances end up trading the mount back and forth.
 */

import { execFile, execFileSync } from "node:child_process";
import net from "node:net";

/** The backend a 443 mount points at, and whether it is exposed to the internet. */
export interface FunnelBackend {
  port: number;
  /** `AllowFunnel[<host>:443]` — true for `funnel`, false for a tailnet-only `serve`. */
  funnel: boolean;
}

/**
 * What the daemon said, or why we do not know. The `unreadable` arm exists so a
 * failed CLI call can never be mistaken for "no config": those two demand
 * opposite actions (wait vs claim).
 */
export type FunnelRead = { kind: "config"; backend?: FunnelBackend } | { kind: "unreadable"; reason: string };

/**
 * The 443 mount the daemon reports, or `undefined` when there is none for this
 * hostname (which includes an empty `{}` — a node with no serve config holds
 * nothing).
 *
 * `domain` is optional on purpose: the watch asks "is this OUR name's mount",
 * while teardown asks "is the 443 mount's backend our port" — one node carries
 * one name, so narrowing by port is the honest test there.
 */
export function parseFunnelBackend(jsonText: string, domain?: string): FunnelBackend | undefined {
  let parsed: {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    AllowFunnel?: Record<string, boolean>;
  };
  try {
    parsed = JSON.parse(jsonText) as typeof parsed;
  } catch {
    return undefined;
  }
  const web = parsed?.Web;
  if (!web || typeof web !== "object") return undefined;
  const wanted = domain ? `${domain.toLowerCase()}:` : undefined;
  for (const [hostKey, entry] of Object.entries(web)) {
    // 443 only: a mount on any other port is a tailnet-only `serve`, not the funnel.
    if (!hostKey.endsWith(":443")) continue;
    if (wanted && !hostKey.toLowerCase().startsWith(wanted)) continue;
    const proxy = Object.values(entry?.Handlers ?? {})
      .map(handler => handler?.Proxy)
      .find(value => typeof value === "string" && value.length > 0);
    if (!proxy) continue;
    let port: number;
    try {
      port = Number(new URL(proxy).port);
    } catch {
      continue;
    }
    if (!Number.isInteger(port) || port <= 0) continue;
    return { port, funnel: parsed.AllowFunnel?.[hostKey] === true };
  }
  return undefined;
}

/**
 * The verdict, as a pure function so the truth table is testable without a
 * daemon: `backendServing` is the caller's liveness answer for the mount's port.
 */
export function funnelVerdict(
  read: FunnelRead,
  ourPort: number,
  backendServing: boolean,
): "mine" | "other" | "free" | "unknown" {
  if (read.kind === "unreadable") return "unknown";
  const backend = read.backend;
  if (!backend) return "free";
  if (backend.port === ourPort) return "mine";
  return backendServing ? "other" : "free";
}

/**
 * The STARTUP path's verdict rule, as a pure function so the truth table is
 * testable: spawn (claim) only on definite freedom or on our own mount.
 * `other` follows a live peer, and — the rule this exists to pin — `unknown`
 * follows too: a CLI that did not answer is never evidence of freedom, and
 * spawning on it hijacked a live peer's 443 mount whenever `funnel status`
 * timed out. (The watch path already obeyed this via nextFreeRounds; the
 * startup path is the one that got it wrong.)
 */
export function shouldClaimOnStartup(
  verdict: "mine" | "other" | "free" | "unknown",
): boolean {
  return verdict === "free" || verdict === "mine";
}

/** The one place the CLI is invoked; both callers want the same arguments. */
function funnelStatusArgs(): string[] {
  return ["funnel", "status", "--json"];
}

/** Ask the daemon. Never throws: an unanswerable CLI is `unreadable`, not empty. */
export function readFunnelConfig(exe: string, domain: string | undefined, timeoutMs = 5_000): Promise<FunnelRead> {
  return new Promise(resolve => {
    execFile(exe, funnelStatusArgs(), { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve({ kind: "unreadable", reason: `tailscale funnel status failed: ${error.message}` });
        return;
      }
      resolve({ kind: "config", backend: parseFunnelBackend(stdout, domain) });
    });
  });
}

/**
 * The synchronous twin, for teardown: `stopInternal` is synchronous down this
 * path, and the answer decides whether the `off` subcommand may run at all.
 */
export function readFunnelConfigSync(exe: string, domain?: string, timeoutMs = 5_000): FunnelRead {
  try {
    const stdout = execFileSync(exe, funnelStatusArgs(), { timeout: timeoutMs, windowsHide: true, encoding: "utf8" });
    return { kind: "config", backend: parseFunnelBackend(stdout, domain) };
  } catch (error) {
    return { kind: "unreadable", reason: `tailscale funnel status failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Is anything listening on this loopback port right now? */
export function isPortServing(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const settle = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

/**
 * Who would be serving 443 if nothing changed: `mine`, a live peer (`other`),
 * nobody (`free`), or undecidable (`unknown`).
 */
export async function probeFunnelHolder(
  exe: string,
  domain: string,
  ourPort: number,
): Promise<"mine" | "other" | "free" | "unknown"> {
  const read = await readFunnelConfig(exe, domain);
  if (read.kind === "unreadable") return "unknown";
  const backend = read.backend;
  if (!backend || backend.port === ourPort) return funnelVerdict(read, ourPort, false);
  return funnelVerdict(read, ourPort, await isPortServing(backend.port));
}

/** May this instance run `funnel off`? Only when the 443 mount is its own. */
export function funnelMountIsOurs(exe: string, ourPort: number): boolean {
  const read = readFunnelConfigSync(exe);
  if (read.kind === "unreadable") return false;
  return read.backend?.port === ourPort;
}
