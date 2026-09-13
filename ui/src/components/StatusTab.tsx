import { useEffect, useRef, useState } from "react";
import { api, type BridgeStatus, type SettingsActionResult } from "../api";
import { CardHead } from "./CardHead";
import { Chip } from "./Chip";
import { CopyButton } from "./CopyButton";
import { Props as PropList } from "./Props";
import { Stat } from "./Stat";

interface Props {
  act: (action: Record<string, unknown>) => Promise<unknown>;
  onRefresh: () => Promise<void>;
  /** Shell toast: the copy buttons confirm themselves through it. */
  notify?: (text: string, isError?: boolean) => void;
}

/** Server states are code words; the panel speaks Chinese. */
const STATE_LABEL: Record<string, string> = {
  running: "运行中",
  stopped: "已停止",
  starting: "启动中",
  stopping: "停止中",
};

const EXPOSURE: Record<string, { label: string; tone: "ok" | "warn"; note: string }> = {
  local: { label: "仅本机", tone: "ok", note: "只有这台机器上的客户端能访问。" },
  "public-open": { label: "公网可达 · 无鉴权", tone: "warn", note: "任何拿到 URL 的人都能访问。" },
  "public-authed": { label: "公网可达 · 需令牌", tone: "ok", note: "客户端必须带 Bearer 令牌。" },
};

function TunnelRole({ role }: { role?: string }) {
  if (role === "owner") return <Chip tone="ok">本实例持有隧道</Chip>;
  if (role === "follower") return <Chip tone="warn">跟随其他实例</Chip>;
  return <span className="muted">未开启隧道</span>;
}

export function StatusTab({ act, onRefresh, notify }: Props) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<{ ok: boolean; info: string; lines: string[] } | null>(null);
  // Expired-response guard: a poll that started before an action and finished
  // after it used to overwrite the fresher state with stale data.
  const pollSeq = useRef(0);

  useEffect(() => {
    const poll = async () => {
      const mine = ++pollSeq.current;
      try {
        const next = await api.status();
        if (pollSeq.current === mine) setStatus(next);
      } catch { /* server may be mid-restart */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => clearInterval(timer);
  }, []);

  const running = status?.state === "running";
  // mcp_url already resolves tunnel-vs-loopback server-side; the UI no longer
  // has to guess which of the two fields is populated.
  const url = status?.mcp_url || status?.local_url;
  const isPublic = Boolean(status?.public_url);
  const exposure = EXPOSURE[status?.exposure ?? ""];

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onRefresh();
      // Bump past any poll already in flight so its stale answer cannot land
      // after this fresh one.
      const mine = pollSeq.current + 1;
      pollSeq.current = mine;
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
      {/* The four numbers an operator checks first. 实时状态 below used to carry
          the same values at body-text size among eight other rows. */}
      <div className="stats">
        <Stat
          label="会话"
          value={status?.active_sessions ?? "…"}
          hint="上限 64 · 空闲 60 分钟回收"
          tone={(status?.active_sessions ?? 0) > 0 ? "accent" : "plain"}
        />
        <Stat
          label="活动命令"
          value={status?.active_commands ?? "…"}
          hint="正在跑的子进程"
          tone={(status?.active_commands ?? 0) > 0 ? "accent" : "plain"}
        />
        <Stat
          label="对外工具"
          value={status?.tool_count ?? "…"}
          hint={`配置档 ${status?.tool_profile ?? "…"}`}
        />
        <Stat
          label="文件锁"
          value={status?.locks.held ?? 0}
          hint={`等待 ${status?.locks.waiting ?? 0} 个`}
          tone={(status?.locks.waiting ?? 0) > 0 ? "warn" : "plain"}
        />
      </div>

      <div className="split">
        <div>
          <div className="card">
            <CardHead
              title="MCP 端点"
              desc="把这个 URL 填进 MCP 客户端（ChatGPT 连接器、Claude、Cursor 等）。它本身就是凭证，请当作密钥保管。"
              actions={
                <button
                  type="button"
                  className="small icon-text"
                  disabled={busy || !running}
                  onClick={() => void run(() => act({ command: "copyPrompt" }))}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                  复制接入提示词
                </button>
              }
            />
            <div className="row" style={{ paddingTop: 0 }}>
              <span className="code-chip">
                <span className="value">{url ?? "（未运行）"}</span>
              </span>
              <CopyButton
                value={url ?? ""}
                label="复制 URL"
                disabled={!url}
                onCopied={() => notify?.("MCP 地址已复制。")}
              />
            </div>

            <PropList
              items={[
                {
                  label: "暴露面",
                  value: exposure ? <Chip tone={exposure.tone}>{exposure.label}</Chip> : <Chip>读取中…</Chip>,
                },
                { label: "隧道角色", value: <TunnelRole role={status?.tunnel_role} /> },
                {
                  label: "客户端可达",
                  value: url ? (isPublic ? "公网 + 本机" : "仅本机") : "不可达（实例未运行）",
                },
              ]}
            />

            <div className="card-foot" style={{ display: "block" }}>
              <div className="section-note" style={{ margin: 0 }}>
                {url && (isPublic
                  ? "当前是公网隧道地址，拿到它的人都能访问。"
                    + (status?.tunnel_role === "follower"
                      ? "该地址由本机另一个实例的隧道转发，那个实例停止后此地址会失效。"
                      : "")
                  : "当前仅本机可访问（未开启隧道）。")}
              </div>
              {status?.exposure === "public-open" && (
                <div className="section-note note-warn" style={{ marginBottom: 0 }}>
                  ⚠️ 公网可达且未开启鉴权：任何拿到这个 URL 的人都能读写本机文件、执行命令、启停服务。
                  要收紧可在「令牌」页签发令牌开启 Bearer 鉴权（客户端需带 Authorization 头），
                  或点「轮换端点」立即作废已经流出去的旧链接。
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <CardHead
              title="实例生命周期"
              desc="实例由终端窗口掌握：打开终端即启动，关闭终端即停止（一键启动脚本就是这个语义）。"
            />
            {status?.build_stale && (
              <div className="section-note note-warn">
                ⚠️ 磁盘上的构建比本实例新：现在跑的仍是启动时加载的代码。要换成新构建，请**关掉承载本实例的终端窗口**，
                再双击一次一键启动脚本（或在该窗口 Ctrl+C 后重新运行 <code>open-bridge serve</code>）。
              </div>
            )}
            <div className="section-note">
              因此本页没有「启动 / 停止 / 重启」按钮：停止会一并关掉这个页面，按钮既点不到也不可靠。
              下面两个操作只作用于当前进程内的配置与探测，不影响进程本身。
            </div>
            <div className="btn-group">
              <button
                type="button"
                className="small icon-text"
                disabled={busy || !running}
                onClick={() => void run(() => act({ command: "rotateEndpoint" }))}
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M19 5v5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M18.4 10a7 7 0 1 0 .2 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
                轮换端点
              </button>
              <button
                type="button"
                className="small icon-text"
                disabled={busy || !running}
                onClick={() => void checkHealth()}
              >
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                健康检查
              </button>
            </div>
            <div className="section-note" style={{ marginBottom: 0 }}>
              健康检查会真的去请求：本机端点、公网隧道（若已开启），并在鉴权开启时确认匿名请求确实被拒。
            </div>
            {health && (
              <div className="section-note" style={{ marginBottom: 0 }}>
                <span className={`act-status ${health.ok ? "completed" : "error"}`}>{health.info}</span>
                {health.lines.map((line, index) => <div key={index}>· {line}</div>)}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <CardHead title="实时状态" desc="每 2 秒刷新一次。" />
          <PropList
            items={[
              { label: "状态", value: STATE_LABEL[status?.state ?? ""] ?? status?.state ?? "…" },
              { label: "Shell", value: status?.shell ?? "…", mono: true },
              { label: "鉴权", value: status?.auth_enabled ? "已启用（Bearer）" : "关闭（仅凭 URL）" },
              { label: "工具配置档", value: status?.tool_profile ?? "…", mono: true },
              { label: "工作区数", value: status?.allowed_directories?.length ?? 0 },
            ]}
          />
        </div>
      </div>
    </>
  );
}
