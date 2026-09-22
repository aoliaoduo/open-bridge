import { useState } from "react";
import { api, type BridgeStatus } from "../api";
import type { LockSnapshot } from "../api";
import { idleLabel } from "../format";
import { EXPOSURE_META } from "../exposure";
import { t } from "../i18n";
import type { RouteId } from "../routes";
import { usePolling } from "../use-polling";
import { Card } from "./Card";
import { EmptyState } from "./EmptyState";
import { Chip } from "./Chip";
import { CopyButton, CopyIcon } from "./CopyButton";
import { Props as PropList } from "./Props";
import { SecurityCta } from "./SecurityCta";
import { Stat } from "./Stat";

interface Props {
  act: (action: Record<string, unknown>) => Promise<unknown>;
  onRefresh: () => Promise<void>;
  /** Shell toast: the copy buttons confirm themselves through it. */
  notify?: (text: string, isError?: boolean) => void;
  onOpen?: (id: RouteId) => void;
}

/** Server states are code words; the panel speaks Chinese. */
const STATE_LABEL: Record<string, () => string> = {
  running: () => t("运行中", "Running"),
  stopped: () => t("已停止", "Stopped"),
  starting: () => t("启动中", "Starting"),
  stopping: () => t("停止中", "Stopping"),
};

function TunnelRole({ role }: { role?: string }) {
  if (role === "owner") return <Chip tone="ok">{t("本实例持有隧道", "This instance owns the tunnel")}</Chip>;
  if (role === "follower") return <Chip tone="warn">{t("跟随其他实例", "Following another instance")}</Chip>;
  return <span className="muted">{t("未开启隧道", "No tunnel")}</span>;
}

export function StatusTab({ act, onRefresh, notify, onOpen }: Props) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const statusPoll = usePolling({
    intervalMs: 2000,
    poll: async fresh => {
      try {
        const next = await api.status();
        if (fresh()) setStatus(next);
      } catch { /* server may be mid-restart */ }
    },
  });

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
      // Expire any poll already in flight so its stale answer cannot land
      // after this fresh one.
      statusPoll.invalidate();
      setStatus(await api.status());
    } catch { /* the settings action already toasted */ }
    setBusy(false);
  };

  const [locks, setLocks] = useState<LockSnapshot>({ held: [], waiting: [] });

  usePolling({
    intervalMs: 5_000,
    poll: async fresh => {
      try {
        const snapshot = await api.sessions();
        if (fresh()) setLocks(snapshot.locks);
      } catch {
        /* The locks table keeps its last snapshot; the status poll beside
           it reports reachability already. */
      }
    },
  });

  const lockRows = [
    ...locks.held.map(lock => ({ kind: "held" as const, key: lock.key, mode: lock.mode ?? "", label: lock.label ?? "", ms: lock.held_ms ?? 0 })),
    ...locks.waiting.map(lock => ({ kind: "waiting" as const, key: (lock.keys ?? []).join(" , "), mode: lock.mode ?? "", label: lock.label ?? "", ms: lock.waited_ms ?? 0 })),
  ];

  return (
    <>
      {/* The four numbers an operator checks first. 实时状态 below used to carry
          the same values at body-text size among eight other rows. */}
      <div className="stats">
        <Stat
          label={t("有状态会话", "Stateful sessions")}
          value={status?.active_sessions ?? "…"}
          hint={t("上限 64 · 空闲 60 分钟回收", "Cap 64 · reclaimed after 60 min idle")}
          tone={(status?.active_sessions ?? 0) > 0 ? "accent" : "plain"}
        />
        <Stat
          label={t("活动命令", "Active commands")}
          value={status?.active_commands ?? "…"}
          hint={t("正在跑的子进程", "Child processes running")}
          tone={(status?.active_commands ?? 0) > 0 ? "accent" : "plain"}
        />
        <Stat
          label={t("对外工具", "Tools advertised")}
          value={status?.tool_count ?? "…"}
          hint={t(`配置档 ${status?.tool_profile ?? "…"}`, `Profile ${status?.tool_profile ?? "…"}`)}
        />
        <Stat
          label={t("文件锁", "File locks")}
          value={status?.locks.held ?? 0}
          hint={t(`等待 ${status?.locks.waiting ?? 0} 个`, `${status?.locks.waiting ?? 0} waiting`)}
          tone={(status?.locks.waiting ?? 0) > 0 ? "warn" : "plain"}
        />
      </div>

      <div className="split">
        <div>
          <Card
            title={t("MCP 端点", "MCP endpoint")}
            desc={t(
              "把这个 URL 填进 MCP 客户端（ChatGPT 连接器、Claude、Cursor 等）就能连上。公网可达时，拿到它的人就能读写文件、执行命令 —— 请配合安全页的门禁。",
              "Paste this URL into an MCP client (ChatGPT connectors, Claude, Cursor…) and it connects. While it is publicly reachable, whoever has it can read your files and run commands — pair it with the gate on the Security page.",
            )}
            actions={
              <button
                type="button"
                className="small icon-text"
                disabled={busy || !running}
                onClick={() => void run(() => act({ command: "copyPrompt" }))}
              >
                <CopyIcon />
                {t("复制接入提示词", "Copy setup prompt")}
              </button>
            }
          >
            <div className="row" style={{ paddingTop: 0 }}>
              <span className="code-chip">
                <span className="value">{url ?? t("（未运行）", "(not running)")}</span>
              </span>
              <CopyButton
                value={url ?? ""}
                label={t("复制 URL", "Copy URL")}
                disabled={!url}
                onCopied={() => notify?.(t("MCP 地址已复制。", "MCP URL copied."))}
              />
            </div>

            <PropList
              items={[
                {
                  label: t("暴露面", "Exposure"),
                  value: exposure
                    ? <Chip tone={exposure.tone}>{exposure.label()}</Chip>
                    : <Chip>{t("读取中…", "Loading…")}</Chip>,
                },
                { label: t("隧道角色", "Tunnel role"), value: <TunnelRole role={status?.tunnel_role} /> },
                {
                  label: t("客户端可达", "Reachable from"),
                  value: url
                    ? (isPublic ? t("公网 + 本机", "Internet + local") : t("仅本机", "Local only"))
                    : t("不可达（实例未运行）", "Unreachable (instance not running)"),
                },
              ]}
            />

            <div className="card-foot" style={{ display: "block" }}>
              <div className="section-note" style={{ margin: 0 }}>
                {url && (isPublic
                  ? t("当前是公网隧道地址，拿到它的人都能访问。", "This is a public tunnel address: anyone who has it can reach it.")
                    + (status?.tunnel_role === "follower"
                      ? t(
                        "该地址由本机另一个实例的隧道转发，那个实例停止后此地址会失效。",
                        " It is forwarded by another instance's tunnel on this machine, and stops working when that instance does.",
                      )
                      : "")
                  : t("当前仅本机可访问（未开启隧道）。", "Reachable from this machine only (no tunnel)."))}
              </div>
              {status?.exposure === "public-open" && (
                <div className="section-note note-warn" style={{ marginBottom: 0 }}>
                  {t(
                    "⚠️ 公网可达且未开启鉴权：详情与加固去「安全」页。",
                    "⚠️ Publicly reachable with no authentication: detail and hardening on the Security page.",
                  )}
                  <SecurityCta onOpen={onOpen} />
                </div>
              )}
            </div>
          </Card>

          {/* This card used to spend two of its three paragraphs explaining
              that it has no start/stop/restart buttons — a card whose main
              content was a description of its own absence. The reason is real
              (stopping would close the page that holds the button) but it
              belongs in the docs, not in permanent screen space on the page
              every operator opens first. What survives is what acts: the
              stale-build warning, and the way to the checks. */}
          <Card
            title={t("运行中的这份构建", "The build that is running")}
            desc={t(
              "实例由启动它的终端窗口掌握：关掉窗口就停，再运行一次启动脚本就起来。",
              "The terminal window that started this instance owns it: close the window to stop, run the start script again to bring it back.",
            )}
          >
            {status?.build_stale && (
              <div className="section-note note-warn">
                {t(
                  "⚠️ 磁盘上的构建比本实例新：现在跑的仍是启动时加载的代码。要换成新构建，请关掉承载本实例的终端窗口，再双击一次一键启动脚本（或在该窗口 Ctrl+C 后重新运行 ",
                  "⚠️ The build on disk is newer than this instance: it is still running the code loaded at startup. To pick up the new build, close the terminal window hosting it and run the one-click script again (or Ctrl+C in that window and rerun ",
                )}
                <code>open-bridge serve</code>
                {t("）。", ").")}
              </div>
            )}
            <div className="btn-group">
              <button type="button" className="small" disabled={!running} onClick={() => onOpen?.("health")}>
                {t("去体检页", "Open Health")}
              </button>
            </div>
            <div className="section-note" style={{ marginBottom: 0 }}>
              {t(
                "体检会真的发请求验证本机端点、公网隧道与鉴权门禁，不影响进程本身。",
                "Health sends real requests to verify the local endpoint, the public tunnel and the auth gate. It never touches the process.",
              )}
            </div>
          </Card>

        </div>

        <div>

          <Card title={t("实时状态", "Live state")} desc={t("每 2 秒刷新一次。", "Refreshes every 2 seconds.")}>
            <PropList
              items={[
                { label: t("状态", "State"), value: STATE_LABEL[status?.state ?? ""]?.() ?? status?.state ?? "…" },
                { label: "Shell", value: status?.shell ?? "…", mono: true },
                {
                  label: t("工作区目录", "Workspace directory"),
                  value: status?.workspace_root || status?.allowed_directories?.[0] || "…",
                  mono: true,
                },
                {
                  label: t("鉴权", "Auth"),
                  value: status?.auth_enabled
                    ? t("已启用（Bearer）", "On (Bearer)")
                    : t("关闭（只填 URL 即可接入）", "Off (the URL alone connects)"),
                },
                { label: t("工具配置档", "Tool profile"), value: status?.tool_profile ?? "…", mono: true },
                { label: t("工作区数", "Workspaces"), value: status?.allowed_directories?.length ?? 0 },
              ]}
            />
          </Card>

          <Card
            title={t("文件锁明细", "Lock detail")}
            desc={
              <>
                {t(
                  "并发写同一个目录时，第二个调用者会等锁而不是覆盖对方。持有 是正在写文件的调用，等待 是被挡住的调用；两者都会随时间自己消失。",
                  "When two calls write the same directory the second waits for the lock instead of overwriting. Held is the call currently writing, Waiting is the one blocked; both clear themselves over time.",
                )}
              </>
            }
          >
            {lockRows.length === 0 ? (
              <EmptyState title={t("当前没有加锁，也没有等待者。", "No locks held and nobody waiting.")}>
                {t(
                  "多客户端同时写同一个目录时，这里会出现资源路径、调用名与已经等了多少。",
                  "When several clients write the same directory, the resource path, the call and how long it has waited show up here.",
                )}
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="token-table">
                  <thead>
                    <tr>
                      <th>{t("状态", "State")}</th>
                      <th>{t("资源", "Resource")}</th>
                      <th>{t("模式", "Mode")}</th>
                      <th>{t("调用", "Call")}</th>
                      <th className="num">{t("已持续", "For")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* Key includes the index: two waiters can legally queue on the
                        same resource (that is the whole point of the table), and a
                        kind+key key collided between them. */}
                    {lockRows.map((row, index) => (
                      <tr key={`${row.kind}-${row.key}-${index}`}>
                        <td>
                          {row.kind === "held"
                            ? <Chip tone="ok">{t("持有", "Held")}</Chip>
                            : <Chip tone="warn">{t("等待", "Waiting")}</Chip>}
                        </td>
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
              <span className="section-note" style={{ margin: 0 }}>
                {t("每 5 秒自动刷新。", "Refreshes every 5 seconds.")}
              </span>
            </div>
          </Card>

        </div>
      </div>
    </>
  );
}
