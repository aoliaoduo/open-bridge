import { useEffect, useState } from "react";
import { api, copyText, type BridgeStatus, type SettingsActionResult, type SettingsState } from "../api";

interface Props {
  settings?: SettingsState | null;
  act: (action: Record<string, unknown>) => Promise<unknown>;
  onRefresh: () => Promise<void>;
}

export function StatusTab({ act, onRefresh }: Props) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean; info: string; lines: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.status();
        if (!cancelled) setStatus(next);
      } catch { /* server may be mid-restart */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const running = status?.state === "running";
  // mcp_url already resolves tunnel-vs-loopback server-side; the UI no longer
  // has to guess which of the two fields is populated.
  const url = status?.mcp_url || status?.local_url;
  const isPublic = Boolean(status?.public_url);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onRefresh();
      setStatus(await api.status());
    } catch { /* the settings action already toasted */ }
    setBusy(false);
  };

  const checkHealth = async () => {
    setBusy(true);
    try {
      const result = await act({ command: "healthCheck" }) as SettingsActionResult | null;
      if (result) setHealth({ ok: result.healthOk !== false, info: result.info ?? "", lines: result.healthLines ?? [] });
    } catch { /* the settings action already toasted */ }
    setBusy(false);
  };

  return (
    <>
      <div className="card">
        <h2>MCP 端点</h2>
        <div className="row">
          <span className="mono" style={{ flex: 1 }}>{url ?? "（未运行）"}</span>
          <button
            className="small"
            disabled={!url}
            onClick={() => { void copyText(url!).then(() => undefined); }}
          >
            复制 URL
          </button>
          <button
            className="small"
            disabled={busy || !running}
            onClick={() => void run(() => act({ command: "copyPrompt" }))}
          >
            复制接入提示词
          </button>
        </div>
        <div className="section-note">
          把这个 URL 填进 MCP 客户端（ChatGPT 连接器、Claude、Cursor 等）。它本身就是凭证，请当作密钥保管。
          {url && (isPublic
            ? " 当前是公网隧道地址，拿到它的人都能访问。"
            : " 当前仅本机可访问（未开启隧道）。")}
        </div>
      </div>

      <div className="card">
        <h2>运行控制</h2>
        <div className="row">
          <button className="primary" disabled={busy || running} onClick={() => void run(() => act({ command: "start" }))}>
            启动
          </button>
          <button disabled={busy || !running} onClick={() => void run(() => act({ command: "stop" }))}>
            停止
          </button>
          <button disabled={busy || !running} onClick={() => void run(() => act({ command: "rotateEndpoint" }))}>
            轮换端点
          </button>
          <button disabled={busy || !running} onClick={() => void checkHealth()}>
            健康检查
          </button>
        </div>
        <div className="section-note">轮换端点会生成新的 URL，旧链接立即失效。</div>
        <div className="section-note">
          健康检查会真的去请求：本机端点、公网隧道（若已开启），并在鉴权开启时确认匿名请求确实被拒。
        </div>
        {health && (
          <div className="section-note">
            <span className={`act-status ${health.ok ? "completed" : "error"}`}>{health.info}</span>
            {health.lines.map((line, index) => <div key={index}>· {line}</div>)}
          </div>
        )}
      </div>

      <div className="card">
        <h2>实时状态</h2>
        <div className="grid2">
          <div className="row"><span className="label">状态</span><span>{status?.state ?? "…"}</span></div>
          <div className="row"><span className="label">会话</span><span>{status?.active_sessions ?? "…"}</span></div>
          <div className="row"><span className="label">活动命令</span><span>{status?.active_commands ?? "…"}</span></div>
          <div className="row"><span className="label">工具数</span><span>{status?.tool_count ?? "…"}（{status?.tool_profile ?? "…"}）</span></div>
          <div className="row"><span className="label">Shell</span><span className="mono">{status?.shell ?? "…"}</span></div>
          <div className="row"><span className="label">鉴权</span><span>{status?.auth_enabled ? "已启用（Bearer）" : "关闭（仅凭 URL）"}</span></div>
          <div className="row"><span className="label">锁</span><span>持有 {status?.locks.held ?? 0} · 等待 {status?.locks.waiting ?? 0}</span></div>
        </div>
      </div>
    </>
  );
}
