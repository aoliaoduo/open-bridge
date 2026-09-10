import { useEffect, useState } from "react";
import { api, type ActivityEntry, type UsageStats } from "../api";

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

export function StatsTab() {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const [u, a] = await Promise.all([api.usage(), api.activity()]);
        if (!cancelled) { setUsage(u); setActivity(a); }
      } catch { /* transient */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const topTools = usage
    ? Object.entries(usage.by_tool).sort((a, b) => b[1] - a[1]).slice(0, 12)
    : [];
  const maxCalls = topTools.length ? topTools[0][1] : 1;

  return (
    <>
      <div className="card">
        <h2>调用统计（本次运行 · 自 {usage ? new Date(usage.started_at).toLocaleString() : "…"} 起）</h2>
        <div className="stat-grid">
          <div><div className="stat-num">{usage?.calls ?? "…"}</div><div className="cap">总调用</div></div>
          <div><div className="stat-num" style={{ color: "var(--ok)" }}>{usage?.successes ?? "…"}</div><div className="cap">成功</div></div>
          <div><div className="stat-num" style={{ color: "var(--err)" }}>{usage?.failures ?? "…"}</div><div className="cap">失败</div></div>
          <div><div className="stat-num">{usage ? fmtUptime(usage.uptime_ms) : "…"}</div><div className="cap">运行时长</div></div>
        </div>
      </div>

      <div className="card">
        <h2>按工具</h2>
        {topTools.length === 0 ? (
          <div className="section-note">还没有工具调用。</div>
        ) : topTools.map(([name, count]) => (
          <div className="bar-row" key={name}>
            <span className="name">{name}</span>
            <span className="bar" style={{ width: `${Math.max(2, (count / maxCalls) * 100)}%`, maxWidth: 480 }} />
            <span className="n">{count}</span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>最近活动</h2>
        {activity.length === 0 ? (
          <div className="section-note">暂无活动。</div>
        ) : activity.slice(0, 40).map((entry, index) => (
          <div className="row" key={index} style={{ padding: "3px 0", gap: 12 }}>
            <span className="act-time">{entry.at}</span>
            <span className={`act-status ${entry.status}`}>{entry.status}</span>
            <span className="act-tool">{entry.tool}</span>
            <span className="act-msg">{entry.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}
