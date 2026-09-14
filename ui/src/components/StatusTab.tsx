import { useEffect, useRef, useState } from "react";
import { api, type BridgeStatus } from "../api";
import type { LockSnapshot } from "../api";
import { EXPOSURE_META } from "../exposure";
import { t } from "../i18n";
import type { RouteId } from "../routes";
import { Card } from "./Card";
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
    ...locks.held.map(lock => ({ kind: "held" as const, key: lock.key, mode: lock.mode ?? "", label: lock.label ?? "", ms: lock.held_ms ?? 0 })),
    ...locks.waiting.map(lock => ({ kind: "waiting" as const, key: (lock.keys ?? []).join(" , "), mode: lock.mode ?? "", label: lock.label ?? "", ms: lock.waited_ms ?? 0 })),
  ];

  return (
    <>
      {/* The four numbers an operator checks first. 实时状态 below used to carry
          the same values at body-text size among eight other rows. */}
      <div className="stats">
        <Stat
          label={t("会话", "Sessions")}
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
              "把这个 URL 填进 MCP 客户端（ChatGPT 连接器、Claude、Cursor 等）。它是地址。公网状态下请配合安全页的门禁使用。",
              "Paste this URL into an MCP client (ChatGPT connectors, Claude, Cursor…). It is the address. When public, pair it with the gate on the Security page.",
            )}
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
                  {onOpen ? (
                    <button type="button" className="small" onClick={() => onOpen("security")}>
                      {t("去安全页", "Open Security")}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </Card>

          <Card
            title={t("实例生命周期", "Instance lifecycle")}
            desc={t(
              "实例由终端窗口掌握：打开终端即启动，关闭终端即停止（一键启动脚本就是这个语义）。",
              "The terminal window owns the instance: opening it starts the bridge, closing it stops the bridge (that is what the one-click script does).",
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
            <div className="section-note">
              {t(
                "因此本页没有「启动 / 停止 / 重启」按钮：停止会一并关掉这个页面，按钮既点不到也不可靠。体检只做探测，不影响进程本身。",
                "That is why this page has no start/stop/restart buttons: stopping would also close this page, so the button could neither be clicked nor trusted. 体检 only probes; it never touches the process.",
              )}
            </div>
            {/* This used to be a 健康检查 button running a second, separate
                implementation: this page called the healthCheck settings action
                (runHealthCheck) while 体检 calls /api/health, which computes its
                own checks. Two code paths answering the same question, one of
                them reporting a flat pass/fail where the other grades each
                check and really sends a request through the tunnel. Kept the
                thorough one and made this a link to it. */}
            <div className="btn-group">
              <button type="button" className="small" disabled={!running} onClick={() => onOpen?.("health")}>
                {t("去体检页", "Open 体检")}
              </button>
            </div>
            <div className="section-note" style={{ marginBottom: 0 }}>
              {t(
                "体检会真的去请求：本机端点、公网隧道（若已开启），并在鉴权开启时确认匿名请求确实被拒；每项单独给出结论。",
                "体检 makes real requests: the local endpoint, the public tunnel if one is up, and — when auth is on — a check that an anonymous request is actually refused. Each check is graded on its own.",
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
