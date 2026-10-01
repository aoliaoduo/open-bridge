import type { ServerResponse } from "node:http";
import { sendJson } from "../../http/json-response.js";
import { state } from "../../bridge/runtime-state.js";
import { getBridgeStatus, getUsageStats } from "../../bridge/tools/meta-tools.js";
import { buildSettingsState } from "../settings-handler.js";
import { buildTunnelView } from "../settings-tunnel.js";
import { listServiceViews } from "../../bridge/tools/service-tools.js";
import { lockSnapshot } from "../../bridge/runtime/resource-locks.js";
import { listSkills } from "../../bridge/tools/skills.js";
import { listToolDefinitions } from "../../bridge/tools/tool-catalog.js";
import { CORE_TOOLS } from "../../mcp/tool-definitions.js";
import { oauthConsoleView } from "../../http/oauth.js";
import { streamBridgeLogs } from "../log-stream.js";
import { webAiPrompt } from "../../bridge/lifecycle/lifecycle.js";
import type { IncomingMessage } from "node:http";
import { healthReport } from "./health.js";
import { firstLine, sessionViews, todoView } from "./views.js";

export async function handleReadApiRoute(
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  switch (route) {
    case "/status": sendJson(res, 200, { ok: true, status: getBridgeStatus() }); return true;
    case "/sessions": sendJson(res, 200, { ok: true, sessions: sessionViews(), locks: lockSnapshot() }); return true;
    case "/todos": sendJson(res, 200, { ok: true, ...todoView() }); return true;
    case "/tools": {
      const profile = String((getBridgeStatus() as Record<string, unknown>).tool_profile ?? "full");
      const tools = listToolDefinitions().map(tool => ({
        name: tool.name,
        description: firstLine(tool.description),
        core: CORE_TOOLS.has(tool.name),
      }));
      sendJson(res, 200, { ok: true, profile, count: tools.length, tools });
      return true;
    }
    case "/skills": {
      const discovered = listSkills();
      sendJson(res, 200, {
        ok: true,
        count: discovered.count,
        skills: discovered.skills,
        scanned_dirs: discovered.scanned_dirs,
        shadowed: discovered.shadowed,
      });
      return true;
    }
    case "/health": sendJson(res, 200, { ok: true, health: await healthReport() }); return true;
    case "/services": sendJson(res, 200, { ok: true, services: listServiceViews() }); return true;
    case "/activity": sendJson(res, 200, { ok: true, activity: state.activity }); return true;
    case "/usage": sendJson(res, 200, { ok: true, usage: getUsageStats() }); return true;
    case "/oauth": sendJson(res, 200, { ok: true, oauth: await oauthConsoleView() }); return true;
    case "/settings": sendJson(res, 200, { ok: true, state: await buildSettingsState() }); return true;
    case "/tunnel": sendJson(res, 200, { ok: true, tunnel: await buildTunnelView() }); return true;
    case "/prompt": sendJson(res, 200, { ok: true, prompt: webAiPrompt() }); return true;
    case "/logs/stream":
      await streamBridgeLogs(req, res);
      return true;
    default:
      return false;
  }
}
