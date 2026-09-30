import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactSensitiveText } from "../bridge/state.js";
import { nodeHost } from "../host/node-host.js";

interface SseClient { res: ServerResponse }

const sseClients = new Set<SseClient>();
const LOG_BACKFILL_LINES = 800;
const LOG_BACKFILL_BYTES = 512 * 1024;
let sseWired = false;

/** The bounded tail of bridge.log, oldest first. */
async function recentLogLines(): Promise<string[]> {
  try {
    const file = nodeHost().bridgeLog.path();
    const handle = await fs.open(file, "r");
    try {
      const { size } = await handle.stat();
      const windowStart = Math.max(0, size - LOG_BACKFILL_BYTES);
      const length = size - windowStart;
      if (length <= 0) return [];
      const buffer = Buffer.alloc(Number(length));
      await handle.read(buffer, 0, Number(length), windowStart);
      const text = buffer.toString("utf8");
      const lines = (windowStart > 0 ? text.slice(text.indexOf("\n") + 1) : text)
        .split(/\r?\n/)
        .filter(line => line.length > 0);
      return lines.slice(-LOG_BACKFILL_LINES);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

function ssePush(line: string): void {
  const payload = `data: ${JSON.stringify({ line: redactSensitiveText(line) })}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(payload); } catch { sseClients.delete(client); }
  }
}

function ensureLogStreamWired(): void {
  if (sseWired) return;
  sseWired = true;
  try {
    nodeHost().bridgeLog.onLine(line => ssePush(line));
  } catch {
    sseWired = false;
  }
}

/** Backfill one console subscriber, then keep it attached to live log lines. */
export async function streamBridgeLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureLogStreamWired();
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  for (const line of await recentLogLines()) {
    res.write(`data: ${JSON.stringify({ line: redactSensitiveText(line) })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ line: "--- log stream connected ---" })}\n\n`);
  const client: SseClient = { res };
  sseClients.add(client);
  req.on("close", () => { sseClients.delete(client); });
}
