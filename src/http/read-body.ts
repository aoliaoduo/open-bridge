/**
 * Read a request body, size-capped, as UTF-8 text.
 *
 * Shared by the OAuth form endpoints and the console API, which had grown two
 * copies of the same cap-and-accumulate loop. `undefined` means the cap was
 * hit mid-stream and nothing further is retained — callers answer that with
 * their own status (413 for OAuth, a thrown "Request body too large." for the
 * console API). An empty body is the EMPTY STRING, so "no body" and "too
 * large" stay distinguishable without a sentinel.
 *
 * The MCP transport's reader deliberately stays separate (request-body.ts):
 * it must keep draining a runaway upload so the socket can still answer, and
 * it owns the aborted/close error surface.
 */
import { type IncomingMessage } from "node:http";

export async function readBodyText(req: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > maxBytes) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
