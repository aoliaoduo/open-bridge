import { useCallback, useEffect, useState } from "react";
import { api, type HealthCheck, type HealthReport, type SettingsActionResult } from "../api";
import { CardHead } from "./CardHead";
import { Chip } from "./Chip";
import { ConfirmButton } from "./ConfirmButton";
import { Props as PropList } from "./Props";
import { Skeleton } from "./Skeleton";
import { Stat } from "./Stat";

const LABELS: Record<string, string> = {
  instance: "实例",
  workspace: "工作区",
  tools: "工具目录",
  // The build check arrived after this map did, so the row rendered the raw
  // English name on a page where every other row is labelled.
  build: "构建",
  tunnel: "隧道",
  public: "公网连通",
  exposure: "暴露面",
};

const EXPOSURE_TEXT: Record<string, { text: string; tone: "ok" | "warn" }> = {
  local: { text: "仅本机：/api 与 /console 只认回环地址，即使隧道开着也不会把它们暴露出去。", tone: "ok" },
  "public-open": {
    text: "公网可达且未开启鉴权：拿到这个 URL 的人都能读写文件、执行命令。"
      + "要收紧就点下面的「开启第二道锁」（签发令牌 + 打开 Bearer，一步完成），或先轮换端点。",
    tone: "warn",
  },
  "public-authed": { text: "公网可达，但每个请求都要带 Bearer 令牌。", tone: "ok" },
};

/** Older servers sent only `ok`; treat a missing level as ok/fail. */
function levelOf(check: HealthCheck): "ok" | "warn" | "fail" {
  return check.level ?? (check.ok ? "ok" : "fail");
}

/**
 * 体检 — one click,逐项结果.
 *
 * The 状态 page's 健康检查 button only parked a sentence in the activity log, and
 * "公网地址可用" was the instance's own opinion of itself. This page runs the
 * checks server-side and, for the public leg, really does send a request through
 * the tunnel — the only way to know a client could connect.
 */
export function HealthPage(
  { act }: { act: (action: Record<string, unknown>) => Promise<SettingsActionResult | null> },
) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [arming, setArming] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setNote("");
    try {
      setReport(await api.health());
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
    setBusy(false);
  }, []);

  useEffect(() => { void run(); }, [run]);

  // One action instead of the old two trips (mint on 令牌, copy, then flip the
  // switch on 设置). The secret comes back once and the shell shows it in the
  // mask, so this page only has to re-run the checks afterwards: the 暴露面 row
  // should flip to public-authed without the operator reloading anything.
  const arm = async () => {
    setArming(true);
    const result = await act({ command: "armPublicLock" });
    if (result?.ok) await run();
    setArming(false);
  };

  const exposure = EXPOSURE_TEXT[report?.exposure ?? ""];
  const total = (report?.checks ?? []).length;
  const passed = (report?.checks ?? []).filter(check => levelOf(check) === "ok").length;
  const failed = (report?.checks ?? []).filter(check => levelOf(check) === "fail").length;
  const warned = (report?.checks ?? []).filter(check => levelOf(check) === "warn").length;
  // 异常 is a defect; 提醒 is a risk the operator may be choosing on purpose
  // (public-open with no Bearer gate). Both were 异常 before, which made every
  // healthy instance look broken.
  const summary = failed > 0 ? `${failed} 项异常。` : warned > 0 ? `无异常，${warned} 项提醒。` : "全部通过。";
  const meterTone = failed > 0 ? "err" : warned > 0 ? "warn" : "ok";

  return (
    <>
      {report ? (
        <div className="stats three">
          <Stat label="检查通过" value={passed} hint={`共 ${total} 项检查`} tone="ok" />
          <Stat label="需要留意" value={warned} hint={warned > 0 ? "风险，未必是故障" : "没有需要留意的项"} tone={warned > 0 ? "warn" : "plain"} />
          <Stat label="失败项" value={failed} hint={failed > 0 ? "需要处理" : "没有失败项"} tone={failed > 0 ? "err" : "plain"} />
        </div>
      ) : null}

      <div className="card">
        <CardHead
          title="体检结果"
          desc={
            <>
              「公网连通」会用真实请求穿过隧道访问 <span className="mono">/healthz</span>（6 秒超时），
              所以它比别的项慢；隧道没开时会跳过并标注为仅本机。
            </>
          }
          actions={
            <div className="btn-group">
              {report && <span className="section-note" style={{ margin: 0 }}>{summary}</span>}
              <button type="button" className="primary small" disabled={busy} onClick={() => void run()}>
                {busy ? "体检中…" : "重新体检"}
              </button>
            </div>
          }
        />

        {report === null ? (
          busy ? <Skeleton lines={4} /> : <Skeleton lines={4} />
        ) : (
          <>
            <div className="meter">
              <div className="meter-track">
                <div
                  className={`meter-fill ${meterTone}`}
                  style={{ width: `${total ? Math.round((passed / total) * 100) : 0}%` }}
                />
              </div>
              <span className="meter-label">{passed} / {total} 项已通过</span>
            </div>
            <div className="table-wrap">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>结果</th>
                    <th>检查项</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {report.checks.map(check => (
                    <tr key={check.name}>
                      <td>
                        {levelOf(check) === "ok" && <Chip tone="ok">通过</Chip>}
                        {levelOf(check) === "warn" && <Chip tone="warn">提醒</Chip>}
                        {levelOf(check) === "fail" && <Chip tone="err">异常</Chip>}
                      </td>
                      <td className="name">{LABELS[check.name] ?? check.name}</td>
                      <td className="mono wrap">{check.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <CardHead title="暴露面" desc="这个实例现在能被谁访问，以及要不要加第二道锁。" />
        {exposure ? (
          <>
            <PropList
              items={[
                { label: "当前状态", value: <Chip tone={exposure.tone === "warn" ? "warn" : "ok"}>{report?.exposure}</Chip> },
                { label: "含义", value: exposure.text },
              ]}
            />
            {report?.exposure === "public-open" && (
              <div className="card-foot">
                <ConfirmButton
                  className="primary"
                  disabled={arming}
                  label={arming ? "开启中…" : "开启第二道锁"}
                  onConfirm={() => void arm()}
                />
                <span className="section-note" style={{ margin: 0 }}>
                  明文令牌只显示这一次；开启后只填 URL 的客户端会立刻连不上，随时可在「令牌」页关掉。
                </span>
              </div>
            )}
            {report?.exposure === "public-authed" && (
              <div className="card-foot">
                <span className="section-note" style={{ margin: 0 }}>
                  第二道锁在开着：客户端必须带 Bearer 令牌。要恢复「只填 URL」的用法，去「令牌」页关掉那个开关。
                </span>
              </div>
            )}
          </>
        ) : (
          <Skeleton lines={2} />
        )}
      </div>

      {note && <div className="card section-note">{note}</div>}
    </>
  );
}
