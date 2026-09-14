import { useCallback, useEffect, useState } from "react";
import { api, type HealthCheck, type HealthReport } from "../api";
import type { RouteId } from "../routes";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { Skeleton } from "./Skeleton";
import { Stat } from "./Stat";

const LABELS: Record<string, () => string> = {
  instance: () => t("实例", "Instance"),
  workspace: () => t("工作区", "Workspace"),
  tools: () => t("工具目录", "Tool catalog"),
  // The build check arrived after this map did, so the row rendered the raw
  // English name on a page where every other row is labelled.
  build: () => t("构建", "Build"),
  tunnel: () => t("隧道", "Tunnel"),
  public: () => t("公网连通", "Public reachability"),
  exposure: () => t("暴露面", "Exposure"),
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
  { onOpen }: { onOpen?: (id: RouteId) => void },
) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

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
  const total = (report?.checks ?? []).length;
  const passed = (report?.checks ?? []).filter(check => levelOf(check) === "ok").length;
  const failed = (report?.checks ?? []).filter(check => levelOf(check) === "fail").length;
  const warned = (report?.checks ?? []).filter(check => levelOf(check) === "warn").length;
  // 异常 is a defect; 提醒 is a risk the operator may be choosing on purpose
  // (public-open with no Bearer gate). Both were 异常 before, which made every
  // healthy instance look broken.
  const summary = failed > 0
    ? t(`${failed} 项异常。`, `${failed} failing.`)
    : warned > 0 ? t(`无异常，${warned} 项提醒。`, `No failures, ${warned} to look at.`)
      : t("全部通过。", "All checks passed.");
  const meterTone = failed > 0 ? "err" : warned > 0 ? "warn" : "ok";

  return (
    <>
      {report ? (
        <div className="stats three">
          <Stat
            label={t("检查通过", "Passed")}
            value={passed}
            hint={t(`共 ${total} 项检查`, `${total} checks in total`)}
            tone="ok"
          />
          <Stat
            label={t("需要留意", "Worth a look")}
            value={warned}
            hint={warned > 0
              ? t("风险，未必是故障", "A risk, not necessarily a fault")
              : t("没有需要留意的项", "Nothing to look at")}
            tone={warned > 0 ? "warn" : "plain"}
          />
          <Stat
            label={t("失败项", "Failing")}
            value={failed}
            hint={failed > 0 ? t("需要处理", "Needs attention") : t("没有失败项", "No failures")}
            tone={failed > 0 ? "err" : "plain"}
          />
        </div>
      ) : null}

      <Card
        title={t("体检结果", "Health report")}
        desc={
          <>
            {t("「公网连通」会用真实请求穿过隧道访问 ", "Public reachability makes a real request through the tunnel to ")}
            <span className="mono">/healthz</span>
            {t(
              "（6 秒超时），所以它比别的项慢；隧道没开时会跳过并标注为仅本机。",
              " (6s timeout), so it is slower than the rest; with no tunnel it is skipped and marked local-only.",
            )}
          </>
        }
        actions={
          <div className="btn-group">
            {report && <span className="section-note" style={{ margin: 0 }}>{summary}</span>}
            <button type="button" className="primary small" disabled={busy} onClick={() => void run()}>
              {busy ? t("体检中…", "Checking…") : t("重新体检", "Run again")}
            </button>
          </div>
        }
      >
        {report === null ? <Skeleton lines={4} /> : (
          <>
            <div className="meter">
              <div className="meter-track">
                <div
                  className={`meter-fill ${meterTone}`}
                  style={{ width: `${total ? Math.round((passed / total) * 100) : 0}%` }}
                />
              </div>
              <span className="meter-label">{t(`${passed} / ${total} 项已通过`, `${passed} / ${total} passed`)}</span>
            </div>
            <div className="table-wrap">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>{t("结果", "Result")}</th>
                    <th>{t("检查项", "Check")}</th>
                    <th>{t("详情", "Detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.checks.map(check => (
                    <tr key={check.name}>
                      <td>
                        {levelOf(check) === "ok" && <Chip tone="ok">{t("通过", "Pass")}</Chip>}
                        {levelOf(check) === "warn" && <Chip tone="warn">{t("提醒", "Warn")}</Chip>}
                        {levelOf(check) === "fail" && <Chip tone="err">{t("异常", "Fail")}</Chip>}
                      </td>
                      <td className="name">{LABELS[check.name]?.() ?? check.name}</td>
                      <td className="mono wrap">{check.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <div className="card section-note">
        {t("暴露面详情与加固去「安全」页。", "Exposure detail and hardening live on the Security page.")}
        {onOpen ? (
          <button type="button" className="small" onClick={() => onOpen("security")}>
            {t("去安全页", "Open Security")}
          </button>
        ) : null}
      </div>

      {note && <div className="card section-note">{note}</div>}
    </>
  );
}
