import { request as httpRequest } from "node:http";

/** What a self-probe answers: enough to decide ok/not-ok and to say why. */
export interface SelfProbeResult {
  ok: boolean;
  status: number;
  body: string;
}

export interface SelfProbeOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Wall-clock budget; a non-finite or non-positive value falls back to 3 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;

/**
 * A request from this process to its own listener that does not outlive itself.
 *
 * The Bridge verifies itself in three places — the startup readiness probe, the
 * 体检's 本地端点 check, and its anonymous-request gate check — each by hitting
 * its own `127.0.0.1:<port>`. Doing that with global `fetch` goes through
 * undici's global dispatcher, which **parks the connection in a keep-alive pool
 * inside the very process that is listening on the other end**. The socket then
 * outlives the request, and at shutdown `closeAllConnections()` destroys a
 * connection whose client-side handle is still alive: Node 24 on Windows aborts
 * with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`
 * and the instance exits with a fastfail code (3221226505) instead of 0 — a
 * clean shutdown that looks like a crash, with nothing in the output to say so.
 *
 * `agent: false` is the whole fix: `node:http` opens the socket, reads the
 * response and closes it, so nothing is left pooled against a server that is
 * about to stop. The public (tunnel) probes deliberately stay on `fetch` — they
 * point at another host, and one of them is a 6–8 s budgeted probe whose
 * redirect/timeout semantics belong to that path, not here.
 */
export function selfProbe(port: number, pathname: string, options: SelfProbeOptions = {}): Promise<SelfProbeResult> {
  const raw = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: SelfProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: options.method ?? "GET",
        // The reason this helper exists: no pooling, so no self-connection
        // surviving the request and outlasting the listener.
        agent: false,
        headers: options.headers,
      },
      response => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
        response.on("end", () => finish({
          ok: status >= 200 && status < 300,
          status,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
        response.on("error", error => finish({
          ok: false,
          status,
          body: error instanceof Error ? error.message : String(error),
        }));
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish({ ok: false, status: 0, body: `self-probe timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    request.on("error", error => finish({
      ok: false,
      status: 0,
      body: error instanceof Error ? error.message : String(error),
    }));
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}
