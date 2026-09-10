import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname } from "node:path";

/**
 * One live Bridge instance on this machine. The shared file never carries a route token: only its
 * first half of the SHA-256 digest, so reading the registry cannot grant access to another window.
 */
export type PeerRecord = { hash: string; port: number; pid: number; root: string; at: number };
export type PeerInput = { token: string; port: number; pid: number; root: string; at: number };

const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export function peerHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/** Route tokens appear in exactly two path shapes; anything else is not ours to forward. */
export function bridgeTokenFromPath(pathname: string): { kind: "mcp" | "healthz"; token: string } | undefined {
  const match = /^\/(mcp|healthz)\/([0-9a-f]{32})$/i.exec(pathname);
  if (!match) return undefined;
  // The regex admits case variations ("/MCP/…") but the router below compares
  // exact lowercase paths; canonicalize so casing can never misroute an MCP
  // call onto the healthz path (or vice versa).
  const kind = match[1]!.toLowerCase() === "mcp" ? "mcp" : "healthz";
  return { kind, token: match[2]!.toLowerCase() };
}

/** Signal 0 performs the existence check without delivering anything. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isPeerRecord(value: unknown): value is PeerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<PeerRecord>;
  return typeof row.hash === "string" && /^[0-9a-f]{32}$/i.test(row.hash) && Number.isInteger(row.port) && Number(row.port) > 0 && Number.isInteger(row.pid) && typeof row.root === "string";
}

export async function readPeers(filePath: string): Promise<PeerRecord[]> {
  let raw = "";
  try { raw = await readFile(filePath, "utf8"); } catch { return []; }
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.filter(isPeerRecord).filter(row => isPidAlive(row.pid));
}

async function writePeers(filePath: string, rows: PeerRecord[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(rows), "utf8");
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(temp, filePath); return; }
    catch (error) {
      if (attempt >= 4) { try { await unlink(temp); } catch { /* temp already reclaimed */ } throw error; }
      // Windows refuses the rename while another window has the target open for reading.
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export async function publishPeer(filePath: string, input: PeerInput): Promise<void> {
  const record: PeerRecord = { hash: peerHash(input.token), port: input.port, pid: input.pid, root: input.root, at: input.at };
  // One row per live instance. A rotation mints a new token — hence a new digest
  // — so the old row can never match a token again, and keying the merge on the
  // hash alone left one dead digest behind per rotation until the process
  // exited (`withdrawPeer` can only drop the row it knows the hash of). Rows for
  // other instances are preserved; a re-publish of the same token stays
  // idempotent because the row it replaces carries the same pid.
  const rows = (await readPeers(filePath)).filter(row => row.pid !== input.pid);
  await writePeers(filePath, [...rows, record]);
}

export async function withdrawPeer(filePath: string, token: string): Promise<void> {
  const hash = peerHash(token);
  await writePeers(filePath, (await readPeers(filePath)).filter(row => row.hash !== hash));
}

/** Looked up per request so a window that starts later is reachable at once. */
export async function findPeerForToken(filePath: string, token: string): Promise<PeerRecord | undefined> {
  if (!token) return undefined;
  const hash = peerHash(token);
  return (await readPeers(filePath)).find(row => row.hash === hash && row.pid !== process.pid);
}

export async function healthCheckUrl(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { "ngrok-skip-browser-warning": "true" }, signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

/**
 * Ask the shared domain who is answering. A Bridge replies 404 with `{"error":"Not found"}` for any
 * path it does not own, which tells us another window holds the tunnel without needing its token;
 * ngrok's own page or a connection failure means the domain is free to claim.
 */
export async function probePublicBridge(domain: string, token: string, timeoutMs = 2_000): Promise<"mine" | "other" | "free"> {
  try {
    const response = await fetch(`https://${domain}/healthz/${token}`, { headers: { "ngrok-skip-browser-warning": "true" }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) return "mine";
    if (response.status !== 404) return "free";
    return (await response.text()).includes("Not found") ? "other" : "free";
  } catch { return "free"; }
}

/**
 * Forward one request to a peer Bridge on loopback, streaming both ways so MCP sessions and SSE keep
 * working. The peer still enforces its own token, so a stale entry here grants nothing extra.
 *
 * Every way the stream can end must settle the proxy: an upstream that dies AFTER response headers
 * started (peer window closed/reloaded mid-SSE) emits no request 'error' — only request 'close' plus
 * response 'aborted'/'error'/'close' — and without listeners for those the client would hang forever
 * on a 200 with a partial body while the socket and the pending await leak.
 */
export function proxyToPeer(peer: PeerRecord, req: IncomingMessage, res: ServerResponse, forwardedPath: string): Promise<void> {
  return new Promise<void>(resolve => {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers[key] = value;
    }
    let settled = false;
    let responseEnded = false; // response fully relayed or deliberately terminated

    const settle = (): void => {
      if (settled) return;
      settled = true;
      try { upstream.destroy(); } catch { /* already gone */ }
      if (!res.writableEnded && !res.destroyed) {
        try { res.end(); } catch { /* response already closing */ }
      }
      resolve();
    };
    // Normal completion: the upstream response ran to its end.
    const normalEnd = (): void => {
      if (responseEnded) { settle(); return; }
      responseEnded = true;
      settle();
    };
    // Abnormal termination: upstream died (or the client left) mid-response.
    // Destroy the client connection so it sees a broken transfer instead of a
    // truncated 200 that a client would mistake for the complete response.
    const abnormalEnd = (): void => {
      if (responseEnded) { settle(); return; }
      responseEnded = true;
      if (!res.destroyed) {
        try { res.destroy(); } catch { /* already destroyed */ }
      }
      settle();
    };

    const upstream = httpRequest({ host: "127.0.0.1", port: peer.port, method: req.method, path: forwardedPath, headers, timeout: 0 }, response => {
      const outgoing: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())) outgoing[key] = value;
      }
      res.writeHead(response.statusCode ?? 502, outgoing);
      res.socket?.setNoDelay(true);
      response.on("end", normalEnd);
      response.on("aborted", abnormalEnd);
      response.on("error", abnormalEnd);
      response.on("close", abnormalEnd);
      response.pipe(res, { end: false });
    });
    upstream.on("error", () => {
      // Connect-phase failure: answer 502 before tearing the response down.
      if (!res.headersSent) {
        try {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Bad Gateway: the peer Bridge is unreachable.");
          responseEnded = true;
        } catch { /* headers already racing */ }
      }
      abnormalEnd();
    });
    // An upstream TCP death after headers does not always raise 'error' on the
    // ClientRequest: 'close' (or the piped response's 'aborted'/'close') is the
    // reliable signal, so it must feed the same finish path.
    upstream.on("close", abnormalEnd);
    req.on("aborted", abnormalEnd);
    req.on("error", abnormalEnd);
    res.on("close", () => {
      // Client disconnected. If the relay already completed normally this is a
      // no-op; otherwise treat it as the abnormal end it is.
      if (!responseEnded) abnormalEnd();
      else settle();
    });
    req.pipe(upstream);
  });
}
