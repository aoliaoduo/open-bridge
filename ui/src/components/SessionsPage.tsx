import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type SessionView } from "../api";
import { t } from "../i18n";
import { Card } from "./Card";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/** "空闲 2 分 13 秒" and friends — idleness is the whole point of this table. */
// The 文件锁明细 card on 状态页 imports this: one formatter, two tables.
export function idleLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return t("刚刚", "just now");
  if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t(`${minutes} 分 ${seconds % 60} 秒`, `${minutes}m ${seconds % 60}s`);
  const hours = Math.floor(minutes / 60);
  return t(`${hours} 小时 ${minutes % 60} 分`, `${hours}h ${minutes % 60}m`);
}

/**
 * Clock time of a handshake. The row already says how long the session has been
 * idle; 「首次连接」 answers the other half — since when — which is what tells an
 * operator whether a client is theirs or something that appeared overnight.
 */
function connectedLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function clientLabel(session: SessionView): string {
  return session.stateless ? t("现代 MCP（无状态）", "Modern MCP (stateless)") : session.client;
}

/** A session or activity summary is 活跃 while it is serving a request. */
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
      return clientLabel(session).toLowerCase().includes(needle)
        || session.client.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle);
    });
  }, [sessions, query, view]);

  const activeCount = (sessions ?? []).filter(session => session.active_requests > 0).length;
  const staleCount = (sessions ?? []).filter(session => session.idle_ms >= STALE_MS).length;

  const close = async (id: string) => {
    const session = sessions?.find(row => row.id === id);
    if (closingId || !session || session.stateless || session.closable === false) return;
    setClosingId(id);
    setNote(t(`正在断开 ${id.slice(0, 8)}…`, `Disconnecting ${id.slice(0, 8)}…`));
    try {
      await api.closeSession(id);
      setNote(t(
        `已断开 ${id.slice(0, 8)}…：对方需要重新握手才能继续调用。`,
        `Disconnected ${id.slice(0, 8)}… — that client must handshake again before it can call.`,
      ));
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
        title={t("客户端与活动", "Clients and activity")}
        desc={
          <>
            {t("有会话客户端在 ", "Stateful clients appear after ")}
            <span className="mono">initialize</span>
            {t(
              " 之后出现，空闲超过 60 分钟或被容量挤出时自动消失。断开只关闭一个会话。现代协议显示无状态活动汇总，不代表单个客户端，也没有可断开的会话。",
              " and disappear after 60 minutes idle or when capacity evicts them. Disconnect closes one session. Modern traffic is a stateless activity summary, not an individual client or a disconnectable session.",
            )}
          </>
        }
        actions={
          <div className="segmented" role="group" aria-label={t("会话视图", "Session view")}>
            <button type="button" className={view === "all" ? "active" : ""} onClick={() => setView("all")}>
              {t("全部", "All")} {sessions ? sessions.length : ""}
            </button>
            <button type="button" className={view === "active" ? "active" : ""} onClick={() => setView("active")}>
              {t("活跃", "Active")} {activeCount}
            </button>
            <button type="button" className={view === "idle" ? "active" : ""} onClick={() => setView("idle")}>
              {t("空闲 ≥5 分", "Idle ≥5m")} {staleCount}
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
                placeholder={t("按客户端或会话 ID 过滤…", "Filter by client or session ID…")}
                value={query}
                onChange={event => setQuery(event.target.value)}
                aria-label={t("过滤会话", "Filter sessions")}
              />
            </label>
            <span className="grow" />
            <span className="count">
              {t(`显示 ${visible.length} / 共 ${sessions.length} 项`, `${visible.length} of ${sessions.length} entries`)}
            </span>
          </div>
        )}

        {sessions === null ? (
          <Skeleton lines={3} />
        ) : sessions.length === 0 ? (
          <EmptyState title={t("当前没有客户端连接。", "No clients connected.")}>
            {t("把 ", "Paste the MCP endpoint from the ")}
            <span className="mono">{t("状态", "Status")}</span>
            {t(
              " 页里 MCP 端点卡片的地址填进客户端之后，这里会出现它的名字与空闲时间。",
              " page into a client and its name and idle time show up here.",
            )}
          </EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState title={t("没有匹配的会话。", "No matching sessions.")}>
            {t("换个关键词，或切回「全部」视图。", "Try another keyword, or switch back to the All view.")}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="token-table">
              <thead>
                <tr>
                  <th>{t("客户端", "Client")}</th>
                  <th>{t("会话", "Session")}</th>
                  <th>{t("连接 / 首次观察", "Connected / first seen")}</th>
                  <th>{t("空闲", "Idle")}</th>
                  <th className="num">{t("调用数", "Calls")}</th>
                  <th className="num">{t("进行中", "In flight")}</th>
                  <th className="num">{t("待办", "To do")}</th>
                  <th className="actions">{t("操作", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(session => (
                  <tr key={session.id}>
                    <td className="name">{clientLabel(session)}</td>
                    <td className="mono" title={session.stateless ? undefined : session.id}>
                      {session.stateless ? t("无会话 ID", "No session ID") : <span className="row-actions">
                        {session.id.slice(0, 8)}…
                        <CopyButton
                          value={session.id}
                          label={t("复制会话 ID", "Copy session ID")}
                          onCopied={() => notify?.(t(
                            `已复制会话 ID ${session.id.slice(0, 8)}…`,
                            `Copied session ID ${session.id.slice(0, 8)}…`,
                          ))}
                        />
                      </span>}
                    </td>
                    <td className="muted" title={(session.stateless ? session.first_seen : session.connected_at) ?? undefined}>
                      {session.stateless
                        ? `${t("首次观察", "First seen")} ${connectedLabel(session.first_seen)}`
                        : connectedLabel(session.connected_at)}
                    </td>
                    <td>{idleLabel(session.idle_ms)}</td>
                    <td className="num">{(session.calls ?? 0) > 0 ? session.calls : "—"}</td>
                    <td className="num">{session.active_requests > 0 ? session.active_requests : "—"}</td>
                    <td className="num">{(session.todos ?? 0) > 0 ? session.todos : "—"}</td>
                    <td className="actions">
                      {session.stateless || session.closable === false ? (
                        <span className="muted">{t("不可断开", "Not disconnectable")}</span>
                      ) : <span className="row-actions">
                        <ConfirmButton
                          label={t("断开", "Disconnect")}
                          disabled={closingId === session.id}
                          onConfirm={() => void close(session.id)}
                        />
                      </span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-foot">
          <span className="section-note" style={{ margin: 0 }}>
            {t("每 5 秒自动刷新。", "Refreshes every 5 seconds.")}
          </span>
        </div>
      </Card>


      {note && <div className="card section-note" style={{ marginBottom: 0 }}>{note}</div>}
    </>
  );
}
