import { useEffect, useState } from "react";
import { api, type OAuthConsoleView } from "../api";
import { errorMessage } from "../format";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { DraftField } from "./settings/DraftField";
import { Skeleton } from "./Skeleton";

interface Props {
  enabled: boolean;
  hosts: string[];
  setConfig: (key: string, value: unknown) => void;
}

export function SecurityOAuthCard({ enabled, hosts, setConfig }: Props) {
  return (
    <Card
      title={t("OAuth 2.1（可选）", "OAuth 2.1 (optional)")}
      desc={t(
        "给客户端发它自己的凭据，而不是让所有人共用地址里的路由令牌。",
        "Give each client credentials of its own instead of everyone sharing the route token in the URL.",
      )}
    >
      <div className="field">
        <span className="check-row">
          <input
            type="checkbox"
            className="switch"
            checked={enabled}
            onChange={e => setConfig("oauth.enabled", e.target.checked)}
            aria-label={t("启用 OAuth 2.1 授权服务器", "Enable the OAuth 2.1 authorization server")}
          />
          <span className="field-label">{t("启用 OAuth 2.1 授权服务器", "Enable the OAuth 2.1 authorization server")}</span>
        </span>
        <span className="field-hint">
          {enabled
            ? t(
              "已开启 — /mcp 需要 OAuth 凭据：能走标准流程的客户端会先收到 401（这不是故障，正是它开始授权的信号），"
                + "注册后拿到属于它自己的、可单独吊销的凭据。已经持有令牌的客户端不受影响：Authorization: Bearer 或 ?token= 照常通过。",
              "On — /mcp requires OAuth credentials. A client that speaks the standard flow gets a 401 first (not a fault: that is its cue to start authorizing), "
                + "then registers and receives its own separately revocable credentials. Clients that already hold a token are unaffected: Authorization: Bearer and ?token= still pass.",
            )
            : t(
              "默认关闭 — 客户端在地址里带路由令牌即可接入。打开后，只认 URL 的客户端会收到 401 并要求走 OAuth；"
                + "带不了头的那类客户端可以改用 ?token=<令牌> 的地址，或者不改、继续关着。",
              "Off by default — the route token in the URL is enough to connect. Turn it on and URL-only clients get a 401 asking them to do OAuth; "
                + "clients that cannot send headers can switch to a ?token=<token> address, or you can simply leave this off.",
            )}
        </span>
      </div>
      {enabled && <OAuthPanel hosts={hosts} setConfig={setConfig} />}
    </Card>
  );
}

function OAuthPanel({ hosts, setConfig }: {
  hosts: string[];
  setConfig: (key: string, value: unknown) => void;
}) {
  const [view, setView] = useState<OAuthConsoleView | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    void api.oauth()
      .then(value => { if (alive) setView(value); })
      .catch(error => { if (alive) setNote(errorMessage(error)); });
    return () => { alive = false; };
  }, []);

  return (
    <>
      <div className="field">
        <span className="field-label">{t("允许的回调主机", "Allowed redirect hosts")}</span>
        <span className="field-control">
          <DraftField
            multiline
            value={hosts.join("\n")}
            placeholder={t("允许的回调主机，每行一个，如\nchatgpt.com", "Allowed redirect hosts, one per line, e.g.\nchatgpt.com")}
            onCommit={raw => setConfig("oauth.allowedRedirectHosts", raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))}
          />
        </span>
        <span className="field-hint">
          {t(
            "注册时按主机名精确匹配；localhost / 127.0.0.1 / [::1] 永远放行；留空 = 只用内置名单；失焦时保存",
            "Matched exactly by hostname at registration; localhost / 127.0.0.1 / [::1] always pass; empty = built-in list only; saved on blur",
          )}
        </span>
      </div>

      {view === null ? (
        <Skeleton lines={2} />
      ) : (
        <>
          <div className="props">
            <div className="prop">
              <span className="prop-label">{t("在用凭据", "Credentials in use")}</span>
              <span className="prop-value">
                {t(
                  `已注册客户端 ${view.counts.clients} 个 · 在用访问令牌 ${view.counts.activeAccessTokens} 个 · 刷新令牌 ${view.counts.activeRefreshTokens} 个`,
                  `${view.counts.clients} registered clients · ${view.counts.activeAccessTokens} active access tokens · ${view.counts.activeRefreshTokens} refresh tokens`,
                )}
              </span>
            </div>
            <div className="prop">
              <span className="prop-label">{t("签发者", "Issuer")}</span>
              <span className="prop-value mono">{view.issuer}</span>
            </div>
            <div className="prop">
              <span className="prop-label">{t("业主来源", "Owner source")}</span>
              <span className="prop-value">
                <Chip tone="idle">
                  {view.ownerSource === "env" ? t("环境变量", "Environment variable") : t("路由令牌", "Route token")}
                </Chip>
              </span>
            </div>
          </div>
          {note ? <div className="section-note">{note}</div> : null}
          {view.clients.length === 0 ? (
            <div className="section-note" style={{ marginBottom: 0 }}>
              {t(
                "还没有客户端注册；第一个走标准流程的客户端连上来时会自动注册。",
                "No clients registered yet; the first one that speaks the standard flow registers itself.",
              )}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>{t("客户端", "Client")}</th>
                    <th>{t("回调地址", "Redirect URI")}</th>
                    <th className="num">{t("注册时间", "Registered")}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.clients.map(client => (
                    <tr key={client.client_id}>
                      <td className="name">{client.client_name ?? client.client_id}</td>
                      <td className="mono wrap">{client.redirect_uris.join("\n")}</td>
                      <td className="num muted">{new Date(client.client_id_issued_at * 1000).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
