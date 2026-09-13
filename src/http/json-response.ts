/**
 * One JSON response writer for the HTTP surfaces that hand-roll their replies
 * (`oauth.ts` and `server/api-router.ts` each grew their own copy, and the two
 * had already drifted apart).
 *
 * The envelope is the part that must not drift: JSON content type, no caching,
 * no content sniffing. Endpoint-specific headers are passed in by the caller.
 */
import type { ServerResponse } from "node:http";

/** Send `body` as JSON. `headers` are merged over the defaults and may override them. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (!res.headersSent) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    });
  }
  res.end(JSON.stringify(body));
}
