import { useEffect, useState } from "react";
import {
  api,
  type OAuthConsoleView,
  type SettingsActionResult,
  type SettingsState,
  type SettingsTokenRow,
} from "../api";
// The TTL whitelist is the server's contract (settings-model.ts): restating it
// here let the two drift — this list offered "90 天" (7776000 s), which the
// server's whitelist rejects, so both selects answered 400 forever. Import,
// never restate.
import { TTL_CHOICES } from "../../../src/bridge/settings-model.js";
import { EXPOSURE_META } from "../exposure";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";
import { Props as PropList } from "./Props";
import { DraftField } from "./SettingsTab";
import { Skeleton } from "./Skeleton";

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

interface Props {
  settings: SettingsState;
  act: (action: Record<string, unknown>) => Promise<SettingsActionResult | null>;
  /** Copy feedback goes through the shell toast, like every other copy path. */
  notify?: (text: string, isError?: boolean) => void;
}

/**
 * The 安全 page: everything that answers "who can reach this instance" in one
 * place — the exposure overview, the Bearer gate, personal tokens, and the
 * OAuth 2.1 server. The cards moved here verbatim (体检's exposure card, the
 * old 令牌 page, 设置's OAuth card); only the assembly is new.
 */
export function SecurityPage({ settings, act, notify }: Props) {
  const cfg = settings.config;
  // Only `exposure` is read from this, and /api/status carries it for ~40ms
  // while /api/health costs ~480ms without a tunnel and a full public round
  // trip with one. The overview was waiting on a health check to render one
  // word. Kept as a HealthReport-shaped value so the render below is
  // unchanged; the extra checks it used to carry were never displayed here.
  const [report, setReport] = useState<{ exposure: string } | null>(null);
  const [note, setNote] = useState("");
  const [arming, setArming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState(settings.defaultTtlSeconds);
  const [creating, setCreating] = useState(false);

  const exposure = EXPOSURE_META[report?.exposure ?? ""];

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const status = await api.status();
        if (alive) setReport({ exposure: String(status.exposure ?? "local") });
      } catch (error) {
        if (alive) setNote(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    return () => { alive = false; };
  }, []);

  const arm = async () => {
    if (arming) return;
    setArming(true);
    try {
      const result = await act({ command: "armPublicLock" });
      // The gate flips the exposure public-open → public-authed: re-read it so
      // the overview above stops describing the state we just left.
      if (result?.ok) {
        try {
          const status = await api.status();
          setReport({ exposure: String(status.exposure ?? "local") });
        } catch (error) {
          setNote(error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      setArming(false);
    }
  };

  const rotate = async () => {
    if (rotating) return;
    setRotating(true);
    try {
      // A rotation invalidates the console's own injected token, so the shell
      // reloads the page on success — there is nothing to refresh by hand.
      await act({ command: "rotateEndpoint" });
    } finally {
      setRotating(false);
    }
  };

  const setConfig = (key: string, value: unknown) => {
    void act({ command: "setConfig", key, value });
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const result = await act({ command: "createToken", label, ttlSeconds: ttl });
      if (result?.ok) {
        setShowForm(false);
        setLabel("");
      }
    } finally {
      setCreating(false);
    }
  };

  const tokenPill = (token: SettingsTokenRow) => {
    if (token.revoked) return <Chip tone="err">{t("已吊销", "Revoked")}</Chip>;
    if (token.expired) return <Chip tone="err">{t("已过期", "Expired")}</Chip>;
    return <Chip tone="ok">{t("有效", "Valid")}</Chip>;
  };

  return (
    <>
      <Card
        title={t("总览", "Overview")}
        desc={t(
          "这个实例现在能被谁访问：地址、暴露等级，以及两道门的开关。",
          "Who can reach this instance right now: the address, the exposure level and both gates.",
        )}
      >
        {report === null ? (
          <Skeleton lines={3} />
        ) : (
          <PropList
            items={[
              { label: t("当前状态", "Current state"), value: <Chip tone={exposure?.tone ?? "idle"}>{report.exposure}</Chip> },
              { label: t("含义", "Meaning"), value: exposure?.text() ?? "—" },
              {
                label: t("地址", "Address"),
                value: (
                  <span className="row-actions">
                    <span className="mono">{settings.mcpUrl}</span>
                    <CopyButton
                      value={settings.mcpUrl}
                      label={t("复制地址", "Copy address")}
                      onCopied={() => notify?.(t("MCP 地址已复制。", "MCP URL copied."))}
                    />
                  </span>
                ),
              },
              {
                label: t("Bearer 门禁", "Bearer gate"),
                value: (
                  <Chip tone={settings.authEnabled ? "ok" : "idle"}>
                    {settings.authEnabled ? t("已开启", "On") : t("已关闭", "Off")}
                  </Chip>
                ),
              },
              {
                label: "OAuth 2.1",
                value: (
                  <Chip tone={cfg["oauth.enabled"] ? "ok" : "idle"}>
                    {cfg["oauth.enabled"] ? t("已开启", "On") : t("已关闭", "Off")}
                  </Chip>
                ),
              },
              {
                label: t("操作", "Actions"),
                value: (
                  <button
                    type="button"
                    className="small icon-text"
                    disabled={rotating || !settings.running}
                    onClick={() => void rotate()}
                    title={t(
                      "换掉 MCP 地址里的路由令牌，旧地址立即失效（控制台会自动重载）",
                      "Replace the route token in the MCP URL; the old address stops working immediately (the console reloads itself)",
                    )}
                  >
                    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M19 5v5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M18.4 10a7 7 0 1 0 .2 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </svg>
                    {rotating ? t("轮换中…", "Rotating…") : t("轮换端点", "Rotate endpoint")}
                  </button>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title={t("Bearer 门禁", "Bearer gate")}
        desc={t(
          "打开后，/mcp 的每个请求都必须带 Bearer 令牌；只填 URL 连不上。",
          "Once on, every request to /mcp must carry a Bearer token; the URL alone will not connect.",
        )}
      >
        <div className="form-grid">
          <div className="field">
            <span className="field-label">{t("Bearer 门禁", "Bearer gate")}</span>
            <span className="field-control">
              <span className="check-row">
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.authEnabled}
                  onChange={e => void act({ command: "setAuthEnabled", enabled: e.target.checked })}
                  aria-label={t("Bearer 门禁", "Bearer gate")}
                />
                <span>{settings.authEnabled ? t("已开启（Bearer）", "On (Bearer)") : t("已关闭", "Off")}</span>
              </span>
            </span>
            <span className="field-hint">
              {settings.authEnabled
                ? t("已开启：请求必须带 Bearer 令牌。", "On: requests must carry a Bearer token.")
                : t("已关闭：只填 URL 即可接入。", "Off: the URL alone is enough to connect.")}
            </span>
          </div>
          <div className="field">
            <span className="field-label">{t("一步完成", "One step")}</span>
            <span className="field-control">
              <ConfirmButton
                className="primary"
                disabled={arming}
                label={arming ? t("启用中…", "Enabling…") : t("签发令牌并启用门禁", "Mint a token and enable the gate")}
                onConfirm={() => void arm()}
              />
            </span>
            <span className="field-hint">
              {t("已有可用令牌时会复用，不多发；明文只显示一次。", "Reuses a usable token if there is one; the plaintext is shown once.")}
            </span>
          </div>
        </div>
      </Card>

      <Card
        title={t("个人令牌", "Personal tokens")}
        desc={t(
          "发给客户端的钥匙：可设有效期，可单独吊销/轮换。明文只在创建那一刻显示一次；轮换会立即作废旧值，吊销则直接作废。",
          "The keys you hand to clients: each can expire and be revoked or rotated on its own. The plaintext appears once at creation; rotating invalidates the old value immediately, revoking kills it outright.",
        )}
        actions={
          <div className="btn-group">
            <Chip tone={settings.usableCount > 0 ? "ok" : "idle"}>
              {t(`${settings.usableCount} 有效`, `${settings.usableCount} valid`)}
            </Chip>
            <Chip tone={settings.deadCount > 0 ? "warn" : "idle"}>
              {t(`${settings.deadCount} 失效`, `${settings.deadCount} dead`)}
            </Chip>
            <button type="button" className="small primary" onClick={() => setShowForm(v => !v)}>
              {showForm ? t("收起", "Close") : t("新建令牌", "New token")}
            </button>
          </div>
        }
      >
        <div className="field">
          <span className="field-label">{t("新令牌默认有效期", "Default lifetime for new tokens")}</span>
          <span className="field-control">
            <select
              aria-label={t("新令牌默认有效期", "Default lifetime for new tokens")}
              value={settings.defaultTtlSeconds}
              onChange={e => void act({ command: "setDefaultTtl", seconds: Number(e.target.value) })}
            >
              {TTL_CHOICES.map(choice => (
                <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>
              ))}
            </select>
          </span>
          <span className="field-hint">
            {t("只影响之后新建的令牌；已有令牌的到期时间不变。", "Applies to tokens created later; existing expiry dates do not change.")}
          </span>
        </div>

        {showForm && (
          <div className="form-inline">
            <input
              type="text"
              placeholder={t("标签（如 chatgpt-web）", "Label (e.g. chatgpt-web)")}
              value={label}
              onChange={e => setLabel(e.target.value)}
              aria-label={t("令牌标签", "Token label")}
            />
            <select value={ttl} onChange={e => setTtl(Number(e.target.value))} aria-label={t("令牌有效期", "Token lifetime")}>
              {TTL_CHOICES.map(choice => (
                <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>
              ))}
            </select>
            {/* Disabled while in flight: a double click minted two tokens and
                the one-time plaintext of the first was overwritten — an
                unauthenticated-forever token nobody could ever use. */}
            <button className="primary small" disabled={creating} onClick={() => void create()}>
              {creating ? t("创建中…", "Creating…") : t("创建", "Create")}
            </button>
          </div>
        )}

        {settings.tokens.length === 0 ? (
          <div className="section-note" style={{ marginBottom: 0 }}>
            {t(
              "还没有令牌。用上面的「签发令牌并启用门禁」一步完成，或先在这里新建一个。",
              "No tokens yet. Use the one-step button above, or create one here first.",
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="token-table">
              <thead>
                <tr>
                  <th>{t("标签", "Label")}</th>
                  <th>ID</th>
                  <th>{t("状态", "State")}</th>
                  <th>{t("创建", "Created")}</th>
                  <th>{t("过期", "Expires")}</th>
                  <th className="num">{t("使用", "Uses")}</th>
                  <th className="actions">{t("操作", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {settings.tokens.map(token => (
                  <tr key={token.id} className={token.revoked || token.expired ? "dead" : ""}>
                    <td className="name">{token.label}</td>
                    <td className="mono">
                      <span className="row-actions">
                        {token.id}
                        <CopyButton
                          value={token.id}
                          label={t("复制令牌 ID", "Copy token ID")}
                          onCopied={() => notify?.(t("令牌 ID 已复制。", "Token ID copied."))}
                        />
                      </span>
                    </td>
                    <td>{tokenPill(token)}</td>
                    <td className="muted">{fmtDate(token.created_at)}</td>
                    <td className="muted">{token.expires_at ? fmtDate(token.expires_at) : t("永久", "Never")}</td>
                    <td className="num">{token.use_count}</td>
                    <td className="actions">
                      <span className="row-actions">
                        {!token.revoked && !token.expired && (
                          <>
                            <button className="small" onClick={() => void act({ command: "rotateToken", id: token.id })}>
                              {t("轮换", "Rotate")}
                            </button>
                            <ConfirmButton
                              label={t("吊销", "Revoke")}
                              onConfirm={() => void act({ command: "revokeToken", id: token.id })}
                            />
                          </>
                        )}
                        <ConfirmButton
                          label={t("删除", "Delete")}
                          onConfirm={() => void act({ command: "deleteToken", id: token.id })}
                        />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="card-foot">
          <button className="small" disabled={settings.deadCount === 0} onClick={() => void act({ command: "purgeTokens" })}>
            {t("清理失效令牌", "Purge dead tokens")}
          </button>
          <ConfirmButton label={t("吊销全部", "Revoke all")} onConfirm={() => void act({ command: "revokeAll" })} />
          <span className="spacer" />
          <span className="section-note" style={{ margin: 0 }}>
            {t(`共 ${settings.tokens.length} 条`, `${settings.tokens.length} total`)}
          </span>
        </div>
      </Card>

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
              checked={cfg["oauth.enabled"]}
              onChange={e => setConfig("oauth.enabled", e.target.checked)}
              aria-label={t("启用 OAuth 2.1 授权服务器", "Enable the OAuth 2.1 authorization server")}
            />
            <span className="field-label">{t("启用 OAuth 2.1 授权服务器", "Enable the OAuth 2.1 authorization server")}</span>
          </span>
          {/* The consequence belongs next to the switch: turning this on is what
              makes the URL stop being enough, and that is a decision, not a bug
              report waiting in a client's logs. */}
          <span className="field-hint">
            {cfg["oauth.enabled"]
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
        {cfg["oauth.enabled"] && <OAuthPanel hosts={cfg["oauth.allowedRedirectHosts"]} setConfig={setConfig} />}
      </Card>

      {note && <div className="card section-note">{note}</div>}
    </>
  );
}

/**
 * The live half of the OAuth card: who is registered and how many credentials
 * are out there (GET /api/oauth). Read-only on purpose — the server exposes no
 * digest or secret here, and revocation is the client's own `/oauth/revoke`.
 * Without it the operator could switch OAuth on and then see nothing at all:
 * the console was the one surface with no way to tell who holds a credential.
 */
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
      .catch(error => { if (alive) setNote(error instanceof Error ? error.message : String(error)); });
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
                      {/* Server stores the registration time in SECONDS (RFC 7591);
                          the Date constructor wants milliseconds — without the
                          * 1000 every row read as January 1970. */}
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
