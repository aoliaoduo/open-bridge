import { useEffect, useRef, useState } from "react";
import { api, type BridgeStatus, type SettingsActionResult } from "../api";
import type { LockSnapshot } from "../api";
import { EXPOSURE_META } from "../exposure";
import type { RouteId } from "../routes";
import { CardHead } from "./CardHead";
import { EmptyState } from "./EmptyState";
import { idleLabel } from "./SessionsPage";
import { Chip } from "./Chip";
import { CopyButton } from "./CopyButton";
import { Props as PropList } from "./Props";
import { Stat } from "./Stat";

interface Props {
  act: (action: Record<string, unknown>) => Promise<unknown>;
  onRefresh: () => Promise<void>;
  /** Shell toast: the copy buttons confirm themselves through it. */
  notify?: (text: string, isError?: boolean) => void;
  onOpen?: (id: RouteId) => void;
}

/** Server states are code words; the panel speaks Chinese. */
const STATE_LABEL: Record<string, string> = {
  running: "运行中",
  stopped: "已停止",
  starting: "启动中",
  stopping: "停止中",
};

function TunnelRole({ role }: { role?: string }) {
  if (role === "owner") return <Chip tone="ok">本实例持有隧道</Chip>;
  if (role === "follower") return <Chip tone="warn">跟随其他实例</Chip>;
  return <span className="muted">未开启隧道</span>;
}

export function StatusTab({ act, onRefresh, notify, onOpen }: Props) {
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
  const exposure = EXPOSURE_META[status?.exposure ?? ""];

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

  const [locks, setLocks] = useState<LockSnapshot>({ held: [], waiting: [] });

  useEffect(() => {
    let alive = true;
    const pollLocks = async () => {
      try {
        const snapshot = await api.sessions();
        if (alive) setLocks(snapshot.locks);
      } catch {
        /* The locks table keeps its last snapshot; the status poll beside
           it reports reachability already. */
      }
    };
    void pollLocks();
    const timer = setInterval(() => void pollLocks(), 5_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const lockRows = [
    ...locks.held.map(lock => ({ kind: "持有" as const, key: lock.key, mode: lock.mode ?? "", label: lock.label ?? "", ms: lock.held_ms ?? 0 })),
    ...locks.waiting.map(lock => ({ kind: "等待" as const, key: (lock.keys ?? []).join(" , "), mode: lock.mode ?? "", label: lock.label ?? "", ms: lock.waited_ms ?? 0 })),
  ];

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
              desc="把这个 URL 填进 MCP 客户端（ChatGPT 连接器、Claude、Cursor 等）。它是地址。公网状态下请配合安全页的门禁使用。"
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
                  ⚠️ 公网可达且未开启鉴权：详情与加固去「安全」页。
                  {onOpen ? (
                    <button type="button" className="small" onClick={() => onOpen("security")}>去安全页</button>
                  ) : null}
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
              下面的健康检查只做探测，不影响进程本身。
            </div>
            <div className="btn-group">
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

          <div className="card">
            <CardHead
              title="文件锁明细"
              desc={
                <>
                  并发写同一个目录时，第二个调用者会等锁而不是覆盖对方。<span className="mono">持有</span> 是正在写文件的调用，
                  <span className="mono">等待</span> 是被挡住的调用；两者都会随时间自己消失。
                </>
              }
            />
            {lockRows.length === 0 ? (
              <EmptyState title="当前没有加锁，也没有等待者。">
                多客户端同时写同一个目录时，这里会出现资源路径、调用名与已经等了多少。
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="token-table">
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>资源</th>
                      <th>模式</th>
                      <th>调用</th>
                      <th className="num">已持续</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Key includes the index: two waiters can legally queue on the
                        same resource (that is the whole point of the table), and a
                        kind+key key collided between them. */}
                    {lockRows.map((row, index) => (
                      <tr key={`${row.kind}-${row.key}-${index}`}>
                        <td>{row.kind === "持有" ? <Chip tone="ok">持有</Chip> : <Chip tone="warn">等待</Chip>}</td>
                        <td className="mono" title={row.key || undefined}>{row.key || "—"}</td>
                        <td>{row.mode || "—"}</td>
                        <td className="muted">{row.label || "—"}</td>
                        <td className="num">{idleLabel(row.ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="card-foot">
              <span className="section-note" style={{ margin: 0 }}>每 5 秒自动刷新。</span>
            </div>
          </div>
        </div>

        <div className="card">
          <CardHead title="实时状态" desc="每 2 秒刷新一次。" />
          <PropList
            items={[
              { label: "状态", value: STATE_LABEL[status?.state ?? ""] ?? status?.state ?? "…" },
              { label: "Shell", value: status?.shell ?? "…", mono: true },
              { label: "鉴权", value: status?.auth_enabled ? "已启用（Bearer）" : "关闭（只填 URL 即可接入）" },
              { label: "工具配置档", value: status?.tool_profile ?? "…", mono: true },
              { label: "工作区数", value: status?.allowed_directories?.length ?? 0 },
            ]}
          />
        </div>
      </div>
    </>
  );
}
