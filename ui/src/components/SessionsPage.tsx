import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type LockSnapshot, type SessionView } from "../api";
import { ConfirmButton } from "./ConfirmButton";
import { Chip } from "./Chip";
import { EmptyState } from "./EmptyState";

/** "空闲 2 分 13 秒" and friends — idleness is the whole point of this table. */
function idleLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/**
 * Clock time of a handshake. The row already says how long the session has been
 * idle; 「首次连接」 answers the other half — since when — which is what tells an
 * operator whether a client is theirs or something that appeared overnight.
 */
function connectedLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * 会话 — who is connected, and who is holding the file locks.
 *
 * `active_sessions` was a number with nothing behind it: the operator could see
 * three clients and had no way to learn which, how long they had been idle, or
 * to get rid of one. GET /api/sessions returns that table and
 * POST /api/sessions/close acts on it — the "谁在连我 / 一键断开" pair the panel
 * never had.
 */
export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [locks, setLocks] = useState<LockSnapshot>({ held: [], waiting: [] });
  const [note, setNote] = useState("");
  const [closingId, setClosingId] = useState("");
  const [query, setQuery] = useState("");
  // Stale-response guard: a slow poll that lands after a newer one (or after
  // an action) used to overwrite fresh state with expired data.
  const pollSeq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++pollSeq.current;
    try {
      const snapshot = await api.sessions();
      if (pollSeq.current !== mine) return;
      setSessions(snapshot.sessions);
      setLocks(snapshot.locks);
    } catch (error) {
      if (pollSeq.current === mine) setNote(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  /**
   * Filter by client name or session id. With one long-lived agent plus a
   * browser opening and closing sessions all day, the table otherwise grew
   * past the point where "which one is the stale one" was answerable by eye.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions ?? [];
    return (sessions ?? []).filter(session =>
      session.client.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle));
  }, [sessions, query]);

  const close = async (id: string) => {
    if (closingId) return;
    setClosingId(id);
    setNote(`正在断开 ${id.slice(0, 8)}…`);
    try {
      await api.closeSession(id);
      setNote(`已断开 ${id.slice(0, 8)}…：对方需要重新握手才能继续调用。`);
      await refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setClosingId("");
    }
  };

  const lockRows = [
    ...locks.held.map(lock => ({ kind: "持有" as const, key: lock.key, mode: lock.mode ?? "", label: lock.label ?? "", ms: lock.held_ms ?? 0 })),
    ...locks.waiting.map(lock => ({ kind: "等待" as const, key: (lock.keys ?? []).join(" , "), mode: lock.mode ?? "", label: lock.label ?? "", ms: lock.waited_ms ?? 0 })),
  ];

  return (
    <>
      <div className="card">
        <h2>已连接的客户端</h2>
        <div className="section-note">
          一行是一个活着的 MCP 会话：客户端在 <span className="mono">initialize</span> 之后出现，空闲超过 60 分钟或被容量挤出时自动消失。
          <span className="mono">断开</span> 只关掉这一个会话，不影响实例本身，也不影响别的客户端。
        </div>

        {sessions !== null && sessions.length > 0 && (
          <div className="toolbar">
            <label className="search">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.7" />
                <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                placeholder="按客户端或会话 ID 过滤…"
                value={query}
                onChange={event => setQuery(event.target.value)}
                aria-label="过滤会话"
              />
            </label>
            <span className="grow" />
            <span className="count">显示 {visible.length} / 共 {sessions.length} 个会话</span>
          </div>
        )}

        {sessions === null ? (
          <div className="section-note">读取中…</div>
        ) : sessions.length === 0 ? (
          <EmptyState title="当前没有客户端连接。">
            把 <span className="mono">状态</span> 页里 MCP 端点卡片的地址填进客户端之后，这里会出现它的名字与空闲时间。
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="没有匹配的会话。">换个关键词，或清空过滤框。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="token-table">
              <thead>
                <tr>
                  <th>客户端</th>
                  <th>会话</th>
                  <th>首次连接</th>
                  <th>空闲</th>
                  <th>调用数</th>
                  <th>进行中</th>
                  <th>待办</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(session => (
                  <tr key={session.id}>
                    <td>{session.client}</td>
                    <td className="mono" title={session.id}>{session.id.slice(0, 8)}…</td>
                    <td title={session.connected_at}>{connectedLabel(session.connected_at)}</td>
                    <td>{idleLabel(session.idle_ms)}</td>
                    <td>{session.calls > 0 ? session.calls : "—"}</td>
                    <td>{session.active_requests > 0 ? `${session.active_requests} 个请求` : "—"}</td>
                    <td>{session.todos > 0 ? `${session.todos} 项` : "—"}</td>
                    <td>
                      <ConfirmButton label="断开" disabled={closingId === session.id} onConfirm={() => void close(session.id)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="section-note">每 5 秒自动刷新。</div>
      </div>

      <div className="card">
        <h2>文件锁</h2>
        <div className="section-note">
          并发写同一个目录时，第二个调用者会等锁而不是覆盖对方。<span className="mono">持有</span> 是正在写文件的调用，
          <span className="mono">等待</span> 是被挡住的调用；两者都会随时间自己消失。
        </div>
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
                  <th>已持续</th>
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
                    <td>{row.label || "—"}</td>
                    <td>{idleLabel(row.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {note && <div className="card section-note">{note}</div>}
    </>
  );
}
