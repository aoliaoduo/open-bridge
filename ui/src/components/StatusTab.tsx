import { useEffect, useRef, useState } from "react";
import { api, reloadConsole, type BridgeStatus, type SettingsActionResult } from "../api";
import { CardHead } from "./CardHead";
import { ConfirmButton } from "./ConfirmButton";
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
  const [exiting, setExiting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
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

  /**
   * Restart, then bring this page back by itself.
   *
   * The reply to the action is sent before the listener goes down, but the page
   * still cannot count on receiving it (nor on the first few polls after it):
   * during the handover nothing answers. So "no answer" is not a failure — the
   * page waits for the successor to answer /api/status and then reloads itself,
   * which is also how it picks up the new build's injected console token.
   */
  const restart = async () => {
    setBusy(true);
    setRestartFailed(false);
    setRestarting(true);
    try {
      await act({ command: "restart" });
    } catch {
      /* the listener went down mid-reply; that is the restart working, not failing */
    }
    setBusy(false);
    const deadline = Date.now() + 60_000;
    const waitForSuccessor = async (): Promise<void> => {
      try {
        await api.status();
        reloadConsole();
        return;
      } catch { /* still handing over */ }
      if (Date.now() > deadline) {
        setRestarting(false);
        setRestartFailed(true);
        return;
      }
      window.setTimeout(() => void waitForSuccessor(), 700);
    };
    window.setTimeout(() => void waitForSuccessor(), 700);
  };

  const shutdown = async () => {
    setBusy(true);
    try {
      await api.shutdown();
    } catch {
      // The server answers first and exits second, over the very socket the
      // exit closes — losing that race means the request DID land, so "no
      // answer" is not "nothing happened" and must not be shown as an error.
    } finally {
      setExiting(true);
      setBusy(false);
    }
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
              title="运行控制"
              desc="启停、轮换端点、退出进程与健康检查都会立刻作用于本实例；轮换后旧链接立即失效。"
              actions={
                <div className="btn-group">
                  <button
                    type="button"
                    className="primary small icon-text"
                    disabled={busy || running}
                    onClick={() => void run(() => act({ command: "start" }))}
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
                    启动
                  </button>
                  <button
                    type="button"
                    className="small icon-text"
                    disabled={busy || !running}
                    onClick={() => void run(() => act({ command: "stop" }))}
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.7" /></svg>
                    停止
                  </button>
                </div>
              }
            />
            {status?.build_stale && (
              <div className="section-note note-warn">
                ⚠️ 磁盘上的构建比本实例新：现在跑的仍是启动时加载的代码，新工具与修复要重启进程才生效。点「重启」即可 ——
                它会交给一个新进程接手（本地与公网地址中断几秒），本页会自动重连。用「停止」再「启动」拿不到新构建：
                停止会一并关掉这个控制台，而且同进程内启停并不会重新加载代码。
              </div>
            )}
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
              <ConfirmButton label="重启" disabled={busy || restarting || !running} onConfirm={() => void restart()} />
              <ConfirmButton label="退出进程" disabled={busy || restarting || !running} onConfirm={() => void shutdown()} />
            </div>
            {restarting && (
              <div className="section-note note-warn">
                正在重启：旧实例已停止，新进程正在接手。本页会自动重连（通常几秒），无需手动刷新。
                重启后实例由后台进程承载 —— 停止请用本页「退出进程」或 <code>open-bridge stop</code>。
              </div>
            )}
            {restartFailed && (
              <div className="section-note note-warn">
                重启后本页没能连上：请双击一键启动脚本（或终端 <code>open-bridge serve</code>）重新启动。
              </div>
            )}
            {exiting && (
              <div className="section-note note-warn">
                已请求退出：监听、隧道与 Node 进程都会结束，本页面随后断开。
                再次启动可以双击一键启动脚本，或在终端运行 <code>open-bridge serve</code>。
              </div>
            )}
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
