import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ServiceView } from "../api";
import { CardHead } from "./CardHead";
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
      setNote(`${name}：${action === "start" ? "已启动" : action === "stop" ? "已停止" : "已重启"}`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
    setBusy("");
  };

  const logName = (file: string | null): string => (file ? file.split(/[\\/]/).pop() ?? file : "—");
  const running = (services ?? []).filter(service => service.running).length;

  return (
    <div className="card">
      <CardHead
        title="服务"
        desc={
          <>
            由 MCP 工具 <span className="mono">save_service</span> 定义过的命名进程（例如一个开发服务器）。
            这里只负责启停；健康检查与按组批量启停仍在 MCP 工具侧。
          </>
        }
        actions={
          <div className="btn-group">
            {services ? <Chip tone={running > 0 ? "ok" : "idle"}>{running} / {services.length} 运行中</Chip> : null}
          </div>
        }
      />

      {services === null ? (
        <Skeleton lines={3} />
      ) : services.length === 0 ? (
        <EmptyState title="还没有保存过服务。">
          服务由 MCP 工具 <span className="mono">save_service</span> 定义（例如一个开发服务器），
          保存后就能在这里启停，不必再让代理代劳。
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="token-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>分组</th>
                <th>状态</th>
                <th className="num">端口</th>
                <th>命令</th>
                <th>日志</th>
                <th className="actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {services.map(service => (
                <tr key={service.name}>
                  <td className="mono name">{service.name}</td>
                  <td>{service.group || "—"}</td>
                  <td>
                    {service.running
                      ? <Chip tone="ok">运行中</Chip>
                      : <Chip>已停止</Chip>}
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
                          label="复制日志路径"
                          onCopied={() => notify?.("日志路径已复制。")}
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
                        启动
                      </button>
                      <button
                        className="small"
                        disabled={busy === service.name || !service.running}
                        onClick={() => void run(service.name, "stop")}
                      >
                        停止
                      </button>
                      <button
                        className="small"
                        disabled={busy === service.name || !service.running}
                        onClick={() => void run(service.name, "restart")}
                      >
                        重启
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
        <span className="section-note" style={{ margin: 0 }}>状态每 5 秒自动刷新。</span>
      </div>
    </div>
  );
}
