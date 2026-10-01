import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../../http/json-response.js";
import { state } from "../../bridge/runtime-state.js";
import { getBridgeStatus } from "../../bridge/tools/meta-tools.js";
import { controlService, listServiceViews } from "../../bridge/tools/service-tools.js";
import { start, stop } from "../../bridge/lifecycle/lifecycle.js";
import { handleSettingsAction } from "../settings-handler.js";
import { afterResponse, jsonAndClose, readApiBody } from "./http.js";
import { gracefulShutdown } from "./shutdown.js";
import { sessionViews } from "./views.js";

export async function handleWriteApiRoute(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  switch (route) {
    case "/bridge/start":
      await start();
      sendJson(res, 200, { ok: true, status: getBridgeStatus() });
      return true;

    case "/bridge/stop":
      jsonAndClose(res, 200, { ok: true, status: getBridgeStatus() });
      afterResponse(res, () => { void stop(); });
      return true;

    case "/bridge/rotate": {
      const rotated = await handleSettingsAction({ command: "rotateEndpoint" });
      jsonAndClose(res, rotated.ok ? 200 : 400, {
        ok: rotated.ok,
        status: getBridgeStatus(),
        reloadRequired: rotated.ok,
        error: rotated.error,
      });
      return true;
    }

    case "/sessions/close": {
      const body = await readApiBody(req) as { id?: unknown } | undefined;
      const wanted = String(body?.id ?? "");
      if (!wanted) {
        sendJson(res, 400, { ok: false, error: "id is required." });
        return true;
      }
      const matches = [...state.sessions.entries()].filter(([id]) => id === wanted || id.startsWith(wanted));
      if (matches.length === 0) {
        sendJson(res, 404, { ok: false, error: "会话不存在（可能已经自己断开）。" });
        return true;
      }
      if (matches.length > 1) {
        sendJson(res, 400, { ok: false, error: `id 前缀不唯一（匹配到 ${matches.length} 个会话），请使用更长的前缀。` });
        return true;
      }
      const [closedId, session] = matches[0]!;
      state.sessions.delete(closedId);
      void session.transport.close();
      sendJson(res, 200, { ok: true, closed: closedId, sessions: sessionViews() });
      return true;
    }

    case "/settings/action": {
      const result = await handleSettingsAction(await readApiBody(req));
      const closing = result.ok && result.deferStop;
      (closing ? jsonAndClose : sendJson)(res, result.ok ? 200 : 400, result);
      if (result.ok && result.deferStop) afterResponse(res, () => { void stop(); });
      return true;
    }

    case "/shutdown":
      jsonAndClose(res, 200, { ok: true, message: "Shutting down." });
      afterResponse(res, () => { void gracefulShutdown(); });
      return true;

    case "/services/action": {
      const body = await readApiBody(req) as { action?: unknown; name?: unknown } | undefined;
      const action = String(body?.action ?? "");
      const name = String(body?.name ?? "");
      if (action !== "start" && action !== "stop" && action !== "restart") {
        sendJson(res, 400, { ok: false, error: "action must be start, stop or restart." });
        return true;
      }
      if (!name) {
        sendJson(res, 400, { ok: false, error: "name is required." });
        return true;
      }
      try {
        const result = await controlService(action, name);
        sendJson(res, 200, { ok: true, result, services: listServiceViews() });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }

    default:
      return false;
  }
}
