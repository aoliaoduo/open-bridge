import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SessionView } from "../api";
import { Card } from "./Card";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/** "空闲 2 分 13 秒" and friends — idleness is the whole point of this table. */
// The 文件锁明细 card on 状态页 imports this: one formatter, two tables.
export function idleLabel(ms: number): string {
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

/** A session is 活跃 while it is serving a request. */
const STALE_MS = 5 * 60 * 1000;

type View = "all" | "active" | "idle";

/**
 * 会话 — who is connected, and who is holding the file locks.
 *
 * `active_sessions` was a number with nothing behind it: the operator could see
 * three clients and had no way to learn which, how long they had been idle, or
 * to get rid of one. GET /api/sessions returns that table and
 * POST /api/sessions/close acts on it — the "谁在连我 / 一键断开" pair the panel
 * never had.
 */
export function SessionsPage({ notify }: { notify?: (text: string, isError?: boolean) => void } = {}) {
  const [sessions, setSessions] = useState<SessionView[] | null>(null);
  const [note, setNote] = useState("");
  const [closingId, setClosingId] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  // Stale-response guard: a slow poll that lands after a newer one (or after
  // an action) used to overwrite fresh state with expired data.
  const pollSeq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++pollSeq.current;
    try {
      const snapshot = await api.sessions();
      if (pollSeq.current !== mine) return;
      setSessions(snapshot.sessions);
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
   * Two filters, because they answer two different questions: the quick views
   * answer "is anything stuck?", the search box answers "where is that client?".
   * With one long-lived agent plus a browser opening and closing sessions all
   * day, neither question was answerable by eye.
   */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (sessions ?? []).filter(session => {
      if (view === "active" && session.active_requests <= 0) return false;
      if (view === "idle" && session.idle_ms < STALE_MS) return false;
      if (!needle) return true;
      return session.client.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle);
    });
  }, [sessions, query, view]);

  const activeCount = (sessions ?? []).filter(session => session.active_requests > 0).length;
  const staleCount = (sessions ?? []).filter(session => session.idle_ms >= STALE_MS).length;

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


  return (
    <>
      <Card
        title="已连接的客户端"
        desc={
          <>
            一行是一个活着的 MCP 会话：客户端在 <span className="mono">initialize</span> 之后出现，
            空闲超过 60 分钟或被容量挤出时自动消失。<span className="mono">断开</span> 只关掉这一个会话。
          </>
        }
        actions={
          <div className="segmented" role="group" aria-label="会话视图">
            <button type="button" className={view === "all" ? "active" : ""} onClick={() => setView("all")}>
              全部 {sessions ? sessions.length : ""}
            </button>
            <button type="button" className={view === "active" ? "active" : ""} onClick={() => setView("active")}>
              活跃 {activeCount}
            </button>
            <button type="button" className={view === "idle" ? "active" : ""} onClick={() => setView("idle")}>
              空闲 ≥5 分 {staleCount}
            </button>
          </div>
        }
      >
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
          <Skeleton lines={3} />
        ) : sessions.length === 0 ? (
          <EmptyState title="当前没有客户端连接。">
            把 <span className="mono">状态</span> 页里 MCP 端点卡片的地址填进客户端之后，这里会出现它的名字与空闲时间。
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title="没有匹配的会话。">换个关键词，或切回「全部」视图。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="token-table">
              <thead>
                <tr>
                  <th>客户端</th>
                  <th>会话</th>
                  <th>首次连接</th>
                  <th>空闲</th>
                  <th className="num">调用数</th>
                  <th className="num">进行中</th>
                  <th className="num">待办</th>
                  <th className="actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(session => (
                  <tr key={session.id}>
                    <td className="name">{session.client}</td>
                    <td className="mono" title={session.id}>
                      <span className="row-actions">
                        {session.id.slice(0, 8)}…
                        <CopyButton
                          value={session.id}
                          label="复制会话 ID"
                          onCopied={() => notify?.(`已复制会话 ID ${session.id.slice(0, 8)}…`)}
                        />
                      </span>
                    </td>
                    <td className="muted" title={session.connected_at}>{connectedLabel(session.connected_at)}</td>
                    <td>{idleLabel(session.idle_ms)}</td>
                    <td className="num">{session.calls > 0 ? session.calls : "—"}</td>
                    <td className="num">{session.active_requests > 0 ? session.active_requests : "—"}</td>
                    <td className="num">{session.todos > 0 ? session.todos : "—"}</td>
                    <td className="actions">
                      <span className="row-actions">
                        <ConfirmButton label="断开" disabled={closingId === session.id} onConfirm={() => void close(session.id)} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-foot">
          <span className="section-note" style={{ margin: 0 }}>每 5 秒自动刷新。</span>
        </div>
      </Card>


      {note && <div className="card section-note" style={{ marginBottom: 0 }}>{note}</div>}
    </>
  );
}
