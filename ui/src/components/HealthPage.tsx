import { useCallback, useEffect, useState } from "react";
import { api, type HealthReport } from "../api";

const LABELS: Record<string, string> = {
  instance: "实例",
  workspace: "工作区",
  tools: "工具目录",
  tunnel: "隧道",
  public: "公网连通",
  exposure: "暴露面",
};

const EXPOSURE_TEXT: Record<string, { text: string; tone: "ok" | "dead" | "warn" }> = {
  local: { text: "仅本机：/api 与 /console 只认回环地址，即使隧道开着也不会把它们暴露出去。", tone: "ok" },
  "public-open": {
    text: "公网可达且未开启鉴权：拿到这个 URL 的人都能读写文件、执行命令。要收紧可以轮换端点，或在「令牌」页开启 Bearer 鉴权。",
    tone: "warn",
  },
  "public-authed": { text: "公网可达，但每个请求都要带 Bearer 令牌。", tone: "ok" },
};

/**
 * 体检 — one click,逐项结果.
 *
 * The 状态 page's 健康检查 button only parked a sentence in the activity log, and
 * "公网地址可用" was the instance's own opinion of itself. This page runs the
 * checks server-side and, for the public leg, really does send a request through
 * the tunnel — the only way to know a client could connect.
 */
export function HealthPage() {
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

  const exposure = EXPOSURE_TEXT[report?.exposure ?? ""];
  const failed = (report?.checks ?? []).filter(check => !check.ok).length;

  return (
    <>
      <div className="card">
        <h2>体检结果</h2>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void run()}>
            {busy ? "体检中…" : "重新体检"}
          </button>
          {report && (
            <span className="section-note" style={{ margin: 0 }}>
              {failed === 0 ? "全部通过。" : `${failed} 项异常。`}
            </span>
          )}
        </div>
        <div className="section-note">
          「公网连通」这一项会用真实请求穿过隧道访问 <span className="mono">/healthz</span>（6 秒超时），
          所以它花的时间比别的项长；隧道没开时会跳过并标注为仅本机。
        </div>

        {report === null ? (
          <div className="section-note">{busy ? "体检中…" : "读取中…"}</div>
        ) : (
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
                  <td>{check.ok ? <span className="pill ok">通过</span> : <span className="pill dead">异常</span>}</td>
                  <td>{LABELS[check.name] ?? check.name}</td>
                  <td className="mono">{check.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>暴露面</h2>
        {exposure ? (
          <div className="row">
            <span className={`pill ${exposure.tone === "warn" ? "dead" : "ok"}`}>{report?.exposure}</span>
            <span>{exposure.text}</span>
          </div>
        ) : (
          <div className="section-note">读取中…</div>
        )}
      </div>

      {note && <div className="card section-note">{note}</div>}
    </>
  );
}
