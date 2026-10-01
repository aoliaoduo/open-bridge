import { state } from "../../bridge/runtime-state.js";
import { getBridgeStatus } from "../../bridge/tools/meta-tools.js";
import { buildStaleness } from "../../bridge/lifecycle/build-staleness.js";
import { selfProbe } from "../../bridge/lifecycle/self-probe.js";
import { authEnabled } from "../../http/auth.js";

export interface HealthReport {
  checks: Array<{ name: string; level: "ok" | "warn" | "fail"; ok: boolean; detail: string }>;
  exposure: string;
}

/** Real reachability/security health checks, not a restatement of status. */
export async function healthReport(): Promise<HealthReport> {
  const status = getBridgeStatus() as Record<string, unknown>;
  type Level = "ok" | "warn" | "fail";
  const checks: HealthReport["checks"] = [];
  const check = (name: string, level: Level, detail: string): void => {
    checks.push({ name, level, ok: level !== "fail", detail });
  };

  check("instance", status.state === "running" ? "ok" : "fail", `state=${String(status.state ?? "?")}`);
  check("workspace", "ok", String(status.workspace_root ?? ""));
  check(
    "tools",
    Number(status.tool_count ?? 0) > 0 ? "ok" : "fail",
    `${String(status.tool_count ?? 0)} 个（${String(status.tool_profile ?? "?")}）`,
  );

  const build = buildStaleness();
  if (build) {
    check("build", build.stale ? "warn" : "ok", build.stale
      ? "磁盘上的 dist 比运行中的实例新：关掉承载实例的终端窗口，再双击一键启动脚本重新启动即可换上新构建"
      : "与运行中的实例一致");
  }

  const publicUrl = typeof status.public_url === "string" ? status.public_url : "";
  check("tunnel", "ok", publicUrl
    ? `${String(status.tunnel_role ?? "?")} — ${publicUrl}`
    : "未开启（仅本机可用）");

  if (publicUrl && state.routeToken) {
    const origin = new URL(publicUrl).origin;
    const startedAt = Date.now();
    try {
      const probe = await fetch(`${origin}/healthz/${state.routeToken}`, {
        headers: { "ngrok-skip-browser-warning": "true" },
        signal: AbortSignal.timeout(6_000),
      });
      check("public", probe.ok ? "ok" : "fail", `HTTP ${probe.status}（${Date.now() - startedAt} ms）`);
    } catch (error) {
      check("public", "fail", `探测失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const exposure = String(status.exposure ?? "local");
  check("exposure", exposure === "public-open" ? "warn" : "ok", exposure === "public-open"
    ? "公网可达且未开启鉴权：拿到 URL 的人都能读写文件、执行命令"
    : exposure);

  if (authEnabled()) {
    const anonymous = await selfProbe(state.port, `/mcp/${state.routeToken}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "health", version: "1" } },
      }),
    });
    check(
      "auth_gate",
      anonymous.status === 401 ? "ok" : "fail",
      anonymous.status === 401
        ? "已生效：匿名请求被拒（401）"
        : `异常：匿名请求返回 ${anonymous.status || anonymous.body}，预期 401`,
    );
  }
  return { checks, exposure };
}
