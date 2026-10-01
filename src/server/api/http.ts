import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../http/json-response.js";
import { readBodyText } from "../../http/read-body.js";

export function jsonAndClose(res: ServerResponse, status: number, body: unknown): void {
  if (!res.headersSent) res.setHeader("connection", "close");
  sendJson(res, status, body);
}

/** Run a teardown only after the response body has been flushed. */
export function afterResponse(res: ServerResponse, task: () => void): void {
  let ran = false;
  const run = (): void => {
    if (ran) return;
    ran = true;
    task();
  };
  if (res.writableFinished) {
    run();
    return;
  }
  res.once("finish", run);
  res.once("close", run);
  setTimeout(run, 2_000).unref?.();
}

export class MalformedBodyError extends Error {}

export async function readApiBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const text = await readBodyText(req, maxBytes);
  if (text === undefined) throw new Error("Request body too large.");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new MalformedBodyError(
      `Request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}
