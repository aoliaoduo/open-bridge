import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ServiceView } from "../api";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/**
 * Saved services (the MCP `save_service` definitions) with start/stop/restart.
 *
 * The VS Code panel offered exactly these three buttons; the standalone app had
 * the tools but no operator surface at all, so a service the agent had saved
 * could only be controlled by asking the agent again. Service definitions are
 * still created by the agent — this page drives them.
 */
export function ServicesTab({ notify }: { notify?: (text: string, isError?: boolean) => void } = {}) {
  const [services, setServices] = useState<ServiceView[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  // Expired-response guard. Without it a poll that left BEFORE an action and
  // landed AFTER it resurrected the old running badge over the action's fresh
  // answer (a stopped service looked running until the next tick).
  const pollSeq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++pollSeq.current;
    try {
      const list = await api.services();
      if (pollSeq.current === mine) setServices(list);
    } catch (error) {
      if (pollSeq.current === mine) setNote(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (name: string, action: "start" | "stop" | "restart") => {
    setBusy(name);
    try {
      const result = await api.serviceAction(action, name);
      // Invalidate any poll still in flight before applying the action's own
      // (fresher) answer.
      pollSeq.current += 1;
      setServices(result.services);
      setNote(`${name}: ${action === "start" ? t("已启动", "started")
        : action === "stop" ? t("已停止", "stopped") : t("已重启", "restarted")}`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
    setBusy("");
  };

  const logName = (file: string | null): string => (file ? file.split(/[\\/]/).pop() ?? file : "—");
  const running = (services ?? []).filter(service => service.running).length;

  return (
    <Card
      title={t("服务", "Services")}
      desc={
        <>
          {t("由 MCP 工具 ", "Named processes defined through the MCP tool ")}
          <span className="mono">save_service</span>
          {t(
            " 定义过的命名进程（例如一个开发服务器）。这里只负责启停；健康检查与按组批量启停仍在 MCP 工具侧。",
            " (a dev server, say). This page only starts and stops them; health checks and group operations stay on the MCP side.",
          )}
        </>
      }
      actions={
        <div className="btn-group">
          {services
            ? <Chip tone={running > 0 ? "ok" : "idle"}>{t(`${running} / ${services.length} 运行中`, `${running} / ${services.length} running`)}</Chip>
            : null}
        </div>
      }
    >
      {services === null ? (
        <Skeleton lines={3} />
      ) : services.length === 0 ? (
        <EmptyState title={t("还没有保存过服务。", "No saved services yet.")}>
          {t("服务由 MCP 工具 ", "Services are defined through the MCP tool ")}
          <span className="mono">save_service</span>
          {t(
            "定义（例如一个开发服务器），保存后就能在这里启停，不必再让代理代劳。",
            " (a dev server, say); once saved you can start and stop them here instead of asking the agent.",
          )}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="token-table">
            <thead>
              <tr>
                <th>{t("名称", "Name")}</th>
                <th>{t("分组", "Group")}</th>
                <th>{t("状态", "State")}</th>
                <th className="num">{t("端口", "Port")}</th>
                <th>{t("命令", "Command")}</th>
                <th>{t("日志", "Log")}</th>
                <th className="actions">{t("操作", "Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {services.map(service => (
                <tr key={service.name}>
                  <td className="mono name">{service.name}</td>
                  <td>{service.group || "—"}</td>
                  <td>
                    {service.running
                      ? <Chip tone="ok">{t("运行中", "Running")}</Chip>
                      : <Chip>{t("已停止", "Stopped")}</Chip>}
                  </td>
                  <td className="num">{service.port ?? "—"}</td>
                  <td className="mono" title={service.command}>
                    {service.command.length > 46 ? `${service.command.slice(0, 46)}…` : service.command}
                  </td>
                  <td className="mono" title={service.log_file ?? ""}>
                    <span className="row-actions">
                      {logName(service.log_file)}
                      {service.log_file ? (
                        <CopyButton
                          value={service.log_file}
                          label={t("复制日志路径", "Copy log path")}
                          onCopied={() => notify?.(t("日志路径已复制。", "Log path copied."))}
                        />
                      ) : null}
                    </span>
                  </td>
                  <td className="actions">
                    <span className="row-actions">
                      <button
                        className="small"
                        disabled={busy === service.name || service.running}
                        onClick={() => void run(service.name, "start")}
                      >
                        {t("启动", "Start")}
                      </button>
                      <button
                        className="small"
                        disabled={busy === service.name || !service.running}
                        onClick={() => void run(service.name, "stop")}
                      >
                        {t("停止", "Stop")}
                      </button>
                      <button
                        className="small"
                        disabled={busy === service.name || !service.running}
                        onClick={() => void run(service.name, "restart")}
                      >
                        {t("重启", "Restart")}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-foot">
        {note ? <span className="section-note" style={{ margin: 0 }}>{note}</span> : <span className="spacer" />}
        <span className="spacer" />
        <span className="section-note" style={{ margin: 0 }}>
          {t("状态每 5 秒自动刷新。", "State refreshes every 5 seconds.")}
        </span>
      </div>
    </Card>
  );
}
