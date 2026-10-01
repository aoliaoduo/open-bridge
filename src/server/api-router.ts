/**
 * /api JSON endpoints + /console static hosting — the standalone host's local
 * admin surface. This file owns only the HTTP boundary: OAuth passthrough,
 * loopback/token gates, static console serving, routing, and error mapping.
 * Domain route behavior lives under ./api/.
 */
import * as fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { state } from "../bridge/runtime-state.js";
import { handleOAuthRequest } from "../http/oauth.js";
import { sendJson } from "../http/json-response.js";
import { escapeHtml } from "../http/oauth-protocol.js";
import { MalformedBodyError } from "./api/http.js";
import { handleReadApiRoute } from "./api/read-routes.js";
import { handleWriteApiRoute } from "./api/write-routes.js";

export { setShutdownHook } from "./api/shutdown.js";

const CONSOLE_HEADER = "x-open-bridge-console";
/** dist/server/api-router.js -> <root>/dist/ui (vite output). */
const UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");

function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
    || host === "127.0.0.1" || host === "localhost";
}

function hasConsoleToken(req: IncomingMessage): boolean {
  const presented = req.headers[CONSOLE_HEADER];
  return typeof presented === "string" && presented.length > 0 && presented === state.routeToken;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function serveConsole(res: ServerResponse, url: URL): Promise<void> {
  let requested: string;
  try {
    requested = decodeURIComponent(url.pathname).replace(/^\/console\/?/, "");
  } catch {
    sendJson(res, 400, { error: "Bad request path." });
    return;
  }

  try {
    const fileLike = !requested.endsWith("/") && path.extname(requested) !== "";
    let rel = requested;
    if (!rel || rel.endsWith("/")) rel = `${rel}console.html`;

    const full = path.normalize(path.join(UI_DIR, rel));
    const within = path.relative(UI_DIR, full);
    if (within.startsWith("..") || path.isAbsolute(within)) {
      sendJson(res, 403, { error: "Forbidden." });
      return;
    }

    const found = existsSync(full) && statSync(full).isFile();
    if (!found && fileLike) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }

    const file = found ? full : path.join(UI_DIR, "console.html");
    try {
      let body = await fs.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      if (type.startsWith("text/html")) {
        const escaped = escapeHtml(state.routeToken);
        const html = body.toString("utf8").replace(
          "</head>",
          `<meta name="open-bridge-console-token" content="${escaped}"></head>`,
        );
        body = Buffer.from(html, "utf8");
      }
      res.writeHead(200, {
        "content-type": type,
        "cache-control": type.startsWith("text/html") ? "no-store" : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
    } catch {
      sendJson(res, 503, {
        error: "Console UI is not built. Run `npm run build` (or `open-bridge doctor` for details).",
      });
    }
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Security boundary and route dispatcher.
 *
 * OAuth is intentionally consulted before the loopback gate because remote MCP
 * clients must discover/complete OAuth. /api and /console remain loopback-only;
 * every mutation additionally requires the injected console token.
 */
export async function apiRouteHandler(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  const isConsole = url.pathname === "/console" || url.pathname.startsWith("/console/");

  if (await handleOAuthRequest(req, res, url)) return true;
  if (!isApi && !isConsole) return false;

  if (!isLoopbackHost(req.headers.host, state.port)) {
    sendJson(res, 403, { error: "The console and API are loopback-only." });
    return true;
  }

  if (isConsole) {
    await serveConsole(res, url);
    return true;
  }

  const route = url.pathname.replace(/^\/api/, "") || "/";
  const mutating = req.method !== "GET" && req.method !== "HEAD";
  if (mutating && !hasConsoleToken(req)) {
    sendJson(res, 403, { error: "Missing or invalid console token." });
    return true;
  }

  try {
    const handled = req.method === "POST"
      ? await handleWriteApiRoute(route, req, res)
      : await handleReadApiRoute(route, req, res);
    if (!handled) sendJson(res, 404, { error: "Unknown API route." });
    return true;
  } catch (error) {
    if (error instanceof MalformedBodyError) {
      sendJson(res, 400, { ok: false, error: error.message });
      return true;
    }
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return true;
  }
}
