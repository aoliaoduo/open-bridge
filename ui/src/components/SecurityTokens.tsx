import { useState } from "react";
import type { Act, SettingsState, SettingsTokenRow } from "../api";
import { TTL_CHOICES } from "../../../src/bridge/config/settings-model.js";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";

interface Props {
  settings: SettingsState;
  act: Act;
  notify?: (text: string, isError?: boolean) => void;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function tokenPill(token: SettingsTokenRow) {
  if (token.revoked) return <Chip tone="err">{t("已吊销", "Revoked")}</Chip>;
  if (token.expired) return <Chip tone="err">{t("已过期", "Expired")}</Chip>;
  return <Chip tone="ok">{t("有效", "Valid")}</Chip>;
}

/** Personal-token CRUD is its own interaction boundary, including double-click guards. */
export function SecurityTokens({ settings, act, notify }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState(settings.defaultTtlSeconds);
  const [creating, setCreating] = useState(false);
  const [tokenBusy, setTokenBusy] = useState("");

  const tokenAction = async (id: string, action: Record<string, unknown>) => {
    if (tokenBusy) return;
    setTokenBusy(id);
    try {
      await act(action);
    } finally {
      setTokenBusy("");
    }
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

  return (
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
              <option key={choice.seconds} value={choice.seconds}>{t(choice.label, choice.labelEn)}</option>
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
              <option key={choice.seconds} value={choice.seconds}>{t(choice.label, choice.labelEn)}</option>
            ))}
          </select>
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
                          <button
                            className="small"
                            disabled={tokenBusy !== ""}
                            onClick={() => void tokenAction(token.id, { command: "rotateToken", id: token.id })}
                          >
                            {tokenBusy === token.id ? t("轮换中…", "Rotating…") : t("轮换", "Rotate")}
                          </button>
                          <ConfirmButton
                            label={t("吊销", "Revoke")}
                            disabled={tokenBusy !== ""}
                            onConfirm={() => void tokenAction(token.id, { command: "revokeToken", id: token.id })}
                          />
                        </>
                      )}
                      <ConfirmButton
                        label={t("删除", "Delete")}
                        disabled={tokenBusy !== ""}
                        onConfirm={() => void tokenAction(token.id, { command: "deleteToken", id: token.id })}
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
        <button
          className="small"
          disabled={settings.deadCount === 0 || tokenBusy !== ""}
          onClick={() => void tokenAction("__purge__", { command: "purgeTokens" })}
        >
          {t("清理失效令牌", "Purge dead tokens")}
        </button>
        <ConfirmButton
          label={t("吊销全部", "Revoke all")}
          disabled={tokenBusy !== ""}
          onConfirm={() => void tokenAction("__revoke_all__", { command: "revokeAll" })}
        />
        <span className="spacer" />
        <span className="section-note" style={{ margin: 0 }}>
          {t(`共 ${settings.tokens.length} 条`, `${settings.tokens.length} total`)}
        </span>
      </div>
    </Card>
  );
}
