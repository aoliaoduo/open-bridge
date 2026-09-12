import { useEffect, useRef, useState } from "react";
import { api, copyText, type BridgeStatus, type SettingsActionResult } from "../api";
import { Chip } from "./Chip";
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
          hint={`上限 64 · 空闲 60 分钟回收`}
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

      <div className="card">
        <h2>MCP 端点</h2>
        <div className="row">
          <span className="mono" style={{ flex: 1 }}>{url ?? "（未运行）"}</span>
          <button
            className="small"
            disabled={!url}
            onClick={() => { void copyText(url!).then(() => notify?.("MCP 地址已复制。")); }}
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
        <div className="row tight">
          <span className="label">暴露面</span>
          {exposure ? <Chip tone={exposure.tone}>{exposure.label}</Chip> : <Chip>读取中…</Chip>}
          <span className="section-note" style={{ margin: 0 }}>{exposure?.note ?? ""}</span>
        </div>
        <div className="section-note">
          把这个 URL 填进 MCP 客户端（ChatGPT 连接器、Claude、Cursor 等）。它本身就是凭证，请当作密钥保管。
          {url && (isPublic
            ? " 当前是公网隧道地址，拿到它的人都能访问。"
              + (status?.tunnel_role === "follower"
                ? "该地址由本机另一个实例的隧道转发，那个实例停止后此地址会失效。"
                : "")
            : " 当前仅本机可访问（未开启隧道）。")}
        </div>
        {status?.exposure === "public-open" && (
          <div className="section-note note-warn">
            ⚠️ 公网可达且未开启鉴权：任何拿到这个 URL 的人都能读写本机文件、执行命令、启停服务。
            要收紧可在「令牌」页签发令牌开启 Bearer 鉴权（客户端需带 Authorization 头），
            或点「轮换端点」立即作废已经流出去的旧链接。
          </div>
        )}
      </div>

      <div className="card">
        <h2>运行控制</h2>
        {status?.build_stale && (
          <div className="section-note note-warn">
            ⚠️ 磁盘上的构建比本实例新：现在跑的仍是启动时加载的代码，新工具与修复要重启后才生效（点下面的「停止」再「启动」）。
          </div>
        )}
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
          <div className="row"><span className="label">状态</span><span>{STATE_LABEL[status?.state ?? ""] ?? status?.state ?? "…"}</span></div>
          <div className="row"><span className="label">隧道角色</span><span>{status?.tunnel_role === "owner" ? "本实例持有隧道（owner）" : status?.tunnel_role === "follower" ? "跟随其他实例（follower）" : "未开启隧道"}</span></div>
          <div className="row"><span className="label">Shell</span><span className="mono">{status?.shell ?? "…"}</span></div>
          <div className="row"><span className="label">鉴权</span><span>{status?.auth_enabled ? "已启用（Bearer）" : "关闭（仅凭 URL）"}</span></div>
        </div>
      </div>
    </>
  );
}
