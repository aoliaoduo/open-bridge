import { useRef, useState } from "react";
import { api, type ActivityEntry, type UsageStats } from "../api";
import { errorMessage } from "../format";
import { t } from "../i18n";
import { usePolling } from "../use-polling";
import { Card } from "./Card";
import { ConfirmButton } from "./ConfirmButton";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { Stat } from "./Stat";

// Not the shared idleLabel: an uptime reads "5 分钟", never "刚刚" or
// "5 分 0 秒" — merging the two formatters would rewrite what this card says.
function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return t(`${s} 秒`, `${s}s`);
  if (s < 3600) return t(`${Math.floor(s / 60)} 分钟`, `${Math.floor(s / 60)}m`);
  return t(
    `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`,
    `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`,
  );
}

/** Activity rows carry raw server states; the list reads in the operator's language. */
const ACTIVITY_LABEL: Record<string, () => string> = {
  completed: () => t("完成", "Done"),
  error: () => t("失败", "Failed"),
  running: () => t("进行中", "Running"),
  progress: () => t("进行中", "Running"),
  warning: () => t("警告", "Warning"),
};

/** The activity buffer carries the ISO-8601 UTC instant; the console shows
 *  local wall-clock time. A value that does not parse passes through as-is. */
function formatActivityTime(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleTimeString();
}

type ActivityView = "all" | "error" | "success";

export function StatsTab() {
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [note, setNote] = useState("");
  const [view, setView] = useState<ActivityView>("all");
  /** Whether `note` holds a poll error — the SessionsPage pattern, so a
      recovered poll clears its own failure but not an action's feedback. */
  const noteIsPollError = useRef(false);

  const poll = usePolling({
    intervalMs: 3000,
    poll: async fresh => {
      try {
        const [u, a] = await Promise.all([api.usage(), api.activity()]);
        if (fresh()) {
          setUsage(u);
          setActivity(a);
          if (noteIsPollError.current) {
            noteIsPollError.current = false;
            setNote("");
          }
        }
      } catch (error) {
        if (fresh()) {
          noteIsPollError.current = true;
          setNote(errorMessage(error));
        }
      }
    },
  });

  const clearStats = async () => {
    try {
      const result = await api.settingsAction({ command: "clearStats" });
      // This is action feedback, not a poll error: a later successful poll
      // must not clear it.
      noteIsPollError.current = false;
      setNote(result.info ?? t("已清零", "Counters cleared"));
      // Expire any poll in flight before reading the reset counters — the
      // same resurrect-the-old-values race StatusTab and ServicesTab
      // document and guard.
      poll.invalidate();
      setUsage(await api.usage());
    } catch (error) {
      noteIsPollError.current = false;
      setNote(errorMessage(error));
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
        <Stat label={t("总调用", "Calls")} value={usage?.calls ?? "…"} hint={t("自统计开始", "Since tracking began")} />
        <Stat
          label={t("成功", "Succeeded")}
          value={usage?.successes ?? "…"}
          hint={usage ? t(`占比 ${100 - failureRate}%`, `${100 - failureRate}% of calls`) : "\u00a0"}
          tone="ok"
        />
        <Stat
          label={t("失败", "Failed")}
          value={usage?.failures ?? "…"}
          hint={usage ? t(`占比 ${failureRate}%`, `${failureRate}% of calls`) : "\u00a0"}
          tone={(usage?.failures ?? 0) > 0 ? "err" : "plain"}
        />
        <Stat
          label={t("统计时长", "Tracked for")}
          value={usage ? fmtUptime(usage.uptime_ms) : "…"}
          hint={usage
            ? t(`自 ${new Date(usage.started_at).toLocaleString()}`, `since ${new Date(usage.started_at).toLocaleString()}`)
            : "\u00a0"}
        />
      </div>

      <Card
        title={t("调用统计", "Call statistics")}
        desc={t(
          "累计计数按工作区持久化，跨 Bridge 重启保留；清空只归零这里的数字，不影响任何正在跑的调用。",
          "Counters persist per workspace across Bridge restarts; clearing zeroes them and does not touch calls in flight.",
        )}
        actions={
          <div className="btn-group">
            {note ? <span className="section-note" style={{ margin: 0 }}>{note}</span> : null}
            <ConfirmButton label={t("清空统计", "Clear stats")} onConfirm={() => void clearStats()} />
          </div>
        }
      >
        {usage === null ? (
          <Skeleton lines={2} />
        ) : (
          <div className="props">
            <div className="prop">
              <span className="prop-label">{t("跟踪命令", "Tracked commands")}</span>
              <span className="prop-value">{usage.tracked_commands}</span>
            </div>
            <div className="prop">
              <span className="prop-label">{t("进行中命令", "Commands in flight")}</span>
              <span className="prop-value">{usage.active_commands}</span>
            </div>
          </div>
        )}
      </Card>

      <Card title={t("按工具", "By tool")} desc={t("调用次数排行（前 12 名）。", "Call-count leaderboard (top 12).")}>
        {topTools.length === 0 ? (
          <EmptyState title={t("还没有工具调用。", "No tool calls yet.")}>
            {t("客户端每调用一次工具，这里就会多一条计数与排行。", "Every tool call a client makes adds to this ranking.")}
          </EmptyState>
        ) : topTools.map(([name, count]) => (
          <div className="bar-row" key={name}>
            <span className="name">{name}</span>
            <span className="bar" style={{ width: `${Math.max(2, (count / maxCalls) * 100)}%`, maxWidth: 480 }} />
            <span className="n">{count}</span>
          </div>
        ))}
      </Card>

      <Card
        title={t("最近活动", "Recent activity")}
        desc={t(
          "工具调用、服务启停与配置修改都会记在这里。",
          "Tool calls, service start/stops and config changes all land here.",
        )}
        actions={
          <div className="segmented" role="group" aria-label={t("活动过滤", "Activity filter")}>
            <button type="button" className={view === "all" ? "active" : ""} onClick={() => setView("all")}>
              {t("全部", "All")}
            </button>
            <button type="button" className={view === "error" ? "active" : ""} onClick={() => setView("error")}>
              {t("失败/警告", "Failed/warned")} {failures}
            </button>
            <button type="button" className={view === "success" ? "active" : ""} onClick={() => setView("success")}>
              {t("完成", "Done")}
            </button>
          </div>
        }
      >
        {shown.length === 0 ? (
          <EmptyState title={activity.length === 0
            ? t("暂无活动。", "No activity yet.")
            : t("这个筛选下没有记录。", "Nothing matches this filter.")}>
            {activity.length === 0
              ? t("工具调用、服务启停与配置修改都会出现在这里。", "Tool calls, service start/stops and config changes appear here.")
              : t("换一个筛选看看。", "Try a different filter.")}
          </EmptyState>
        ) : shown.map((entry, index) => (
          <div className="act-row" key={index}>
            <span className={`act-status ${entry.status}`} title={entry.status}>
              {ACTIVITY_LABEL[entry.status]?.() ?? entry.status}
            </span>
            <span className="act-tool">{entry.tool}</span>
            <span className="act-msg">{entry.message}</span>
            <span className="act-time">{formatActivityTime(entry.at)}</span>
          </div>
        ))}
      </Card>
    </>
  );
}
