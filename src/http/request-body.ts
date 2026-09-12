/**
 * Read a POST body, size-capped.
 *
 * Extracted from the listener so the cap and the "keep draining, retain
 * nothing" rule stay together: a runaway upload is answered with 400 instead of
 * being buffered without bound.
 */
import { type IncomingMessage } from "node:http";

// --- Lifecycle constants (ShunCode-derived hardening values) ---
/** Hard cap on a single MCP request body; larger uploads are destroyed mid-stream. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Read (and size-cap) a POST body before handing the parsed JSON to the MCP
 * transport: without this, one runaway upload would be buffered without bound.
 * On overflow the stream keeps draining (so the socket can answer 400) but no
 * further bytes are retained.
 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      if (overflowed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BYTES) {
        overflowed = true;
        chunks.length = 0;
        reject(new Error(`MCP request body exceeds ${MAX_REQUEST_BYTES} bytes.`));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (overflowed) return;
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("MCP request body is not valid JSON."));
      }
    });
    req.on("error", reject);
    // A client that disconnects mid-upload does not always emit 'error'; on
    // several Node paths only 'aborted'/'close' fire. Without these listeners
    // the promise would never settle and the request handler would leak.
    req.on("aborted", () => reject(new Error("MCP request was aborted by the client.")));
    req.on("close", () => {
      if (!req.complete) reject(new Error("MCP request connection closed before the body was received."));
    });
  });
}
