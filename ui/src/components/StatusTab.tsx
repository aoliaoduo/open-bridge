import { useEffect, useState } from "react";
import { api, copyText, type BridgeStatus, type SettingsState } from "../api";

interface Props {
  settings?: SettingsState | null;
  act: (action: Record<string, unknown>) => Promise<unknown>;
  onRefresh: () => Promise<void>;
}

export function StatusTab({ act, onRefresh }: Props) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);

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
  const url = status?.public_url || status?.local_url;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onRefresh();
      setStatus(await api.status());
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
        </div>
        <div className="section-note">
          把这个 URL 填进 MCP 客户端（ChatGPT 连接器、Claude、Cursor 等）。它本身就是凭证，请当作密钥保管。
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
        </div>
        <div className="section-note">轮换端点会生成新的 URL，旧链接立即失效。</div>
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
