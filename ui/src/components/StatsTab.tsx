import { useEffect, useState } from "react";
import { api, type ActivityEntry, type UsageStats } from "../api";
import { Card } from "./Card";
import { ConfirmButton } from "./ConfirmButton";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { Stat } from "./Stat";

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

/** Activity rows carry raw server states; the list reads in Chinese. */
const ACTIVITY_LABEL: Record<string, string> = {
  completed: "完成",
  error: "失败",
  running: "进行中",
  progress: "进行中",
  warning: "警告",
};

type ActivityView = "all" | "error" | "success";

export function StatsTab() {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [note, setNote] = useState("");
  const [view, setView] = useState<ActivityView>("all");

  useEffect(() => {
    // Expired-response guard: drop a slow poll that landed after a newer one.
    let seq = 0;
    const poll = async () => {
      const mine = ++seq;
      try {
        const [u, a] = await Promise.all([api.usage(), api.activity()]);
        if (seq === mine) { setUsage(u); setActivity(a); }
      } catch { /* transient */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => clearInterval(timer);
  }, []);

  const clearStats = async () => {
    try {
      const result = await api.settingsAction({ command: "clearStats" });
      setNote(result.info ?? "已清零");
      setUsage(await api.usage());
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  const topTools = usage
    ? Object.entries(usage.by_tool).sort((a, b) => b[1] - a[1]).slice(0, 12)
    : [];
  // `?? 1`, not `|| 1`: a top tool with zero calls must leave maxCalls at 0.
  const maxCalls = topTools[0]?.[1] ?? 1;
  const failureRate = usage && usage.calls > 0 ? Math.round((usage.failures / usage.calls) * 100) : 0;

  const failures = activity.filter(entry => entry.status === "error" || entry.status === "warning").length;
  const shown = activity
    .filter(entry => view === "all"
      || (view === "error" && (entry.status === "error" || entry.status === "warning"))
      || (view === "success" && entry.status === "completed"))
    .slice(0, 40);

  return (
    <>
      <div className="stats">
        <Stat label="总调用" value={usage?.calls ?? "…"} hint="本次运行" />
        <Stat
          label="成功"
          value={usage?.successes ?? "…"}
          hint={usage ? `占比 ${100 - failureRate}%` : "\u00a0"}
          tone="ok"
        />
        <Stat
          label="失败"
          value={usage?.failures ?? "…"}
          hint={usage ? `占比 ${failureRate}%` : "\u00a0"}
          tone={(usage?.failures ?? 0) > 0 ? "err" : "plain"}
        />
        <Stat
          label="运行时长"
          value={usage ? fmtUptime(usage.uptime_ms) : "…"}
          hint={usage ? `自 ${new Date(usage.started_at).toLocaleString()}` : "\u00a0"}
        />
      </div>

      <Card
        title="调用统计"
        desc="自实例启动起累计；清空只清零计数，不影响正在进行的调用。"
        actions={
          <div className="btn-group">
            {note ? <span className="section-note" style={{ margin: 0 }}>{note}</span> : null}
            <ConfirmButton label="清空统计" onConfirm={() => void clearStats()} />
          </div>
        }
      >
        {usage === null ? (
          <Skeleton lines={2} />
        ) : (
          <div className="props">
            <div className="prop">
              <span className="prop-label">跟踪命令</span>
              <span className="prop-value">{usage.tracked_commands}</span>
            </div>
            <div className="prop">
              <span className="prop-label">进行中命令</span>
              <span className="prop-value">{usage.active_commands}</span>
            </div>
          </div>
        )}
      </Card>

      <Card title="按工具" desc="调用次数排行（前 12 名）。">
        {topTools.length === 0 ? (
          <EmptyState title="还没有工具调用。">客户端每调用一次工具，这里就会多一条计数与排行。</EmptyState>
        ) : topTools.map(([name, count]) => (
          <div className="bar-row" key={name}>
            <span className="name">{name}</span>
            <span className="bar" style={{ width: `${Math.max(2, (count / maxCalls) * 100)}%`, maxWidth: 480 }} />
            <span className="n">{count}</span>
          </div>
        ))}
      </Card>

      <Card
        title="最近活动"
        desc="工具调用、服务启停与配置修改都会记在这里。"
        actions={
          <div className="segmented" role="group" aria-label="活动过滤">
            <button type="button" className={view === "all" ? "active" : ""} onClick={() => setView("all")}>全部</button>
            <button type="button" className={view === "error" ? "active" : ""} onClick={() => setView("error")}>
              失败/警告 {failures}
            </button>
            <button type="button" className={view === "success" ? "active" : ""} onClick={() => setView("success")}>完成</button>
          </div>
        }
      >
        {shown.length === 0 ? (
          <EmptyState title={activity.length === 0 ? "暂无活动。" : "这个筛选下没有记录。"}>
            {activity.length === 0 ? "工具调用、服务启停与配置修改都会出现在这里。" : "换一个筛选看看。"}
          </EmptyState>
        ) : shown.map((entry, index) => (
          <div className="act-row" key={index}>
            <span className={`act-status ${entry.status}`} title={entry.status}>
              {ACTIVITY_LABEL[entry.status] ?? entry.status}
            </span>
            <span className="act-tool">{entry.tool}</span>
            <span className="act-msg">{entry.message}</span>
            <span className="act-time">{entry.at}</span>
          </div>
        ))}
      </Card>
    </>
  );
}
