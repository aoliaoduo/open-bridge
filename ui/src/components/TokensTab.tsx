import { useState } from "react";
import type { SettingsActionResult, SettingsState, SettingsTokenRow } from "../api";
// The TTL whitelist is the server's contract (settings-model.ts): restating it
// here let the two drift — this list offered "90 天" (7776000 s), which the
// server's whitelist rejects, so both selects answered 400 forever. Import,
// never restate.
import { TTL_CHOICES } from "../../../src/bridge/settings-model.js";
import { CardHead } from "./CardHead";
import { Chip } from "./Chip";
import { ConfirmButton } from "./ConfirmButton";
import { CopyButton } from "./CopyButton";

interface Props {
  settings: SettingsState;
  act: (action: Record<string, unknown>) => Promise<SettingsActionResult | null>;
  /** Copy feedback goes through the shell toast, like every other copy path. */
  notify?: (text: string, isError?: boolean) => void;
}

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

export function TokensTab({ settings, act, notify }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState(settings.defaultTtlSeconds);
  const [creating, setCreating] = useState(false);

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
    if (token.revoked) return <Chip tone="err">已吊销</Chip>;
    if (token.expired) return <Chip tone="err">已过期</Chip>;
    return <Chip tone="ok">有效</Chip>;
  };

  return (
    <>
      <div className="card">
        <CardHead
          title="Bearer 鉴权"
          desc="默认关闭：URL 里的路由令牌就是唯一凭证。开启后客户端必须额外发送 Authorization: Bearer <token>。"
        />
        <div className="form-grid">
          <div className="field">
            <span className="field-label">要求 /mcp 端点携带令牌</span>
            <span className="field-control">
              <label className="check">
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.authEnabled}
                  onChange={e => void act({ command: "setAuthEnabled", enabled: e.target.checked })}
                />
                <span>{settings.authEnabled ? "已开启（Bearer）" : "已关闭（仅凭 URL）"}</span>
              </label>
            </span>
            <span className="field-hint">开启前先建一个令牌，否则只填 URL 的客户端会立刻连不上。</span>
          </div>
          <div className="field">
            <span className="field-label">新令牌默认有效期</span>
            <span className="field-control">
              <select
                aria-label="新令牌默认有效期"
                value={settings.defaultTtlSeconds}
                onChange={e => void act({ command: "setDefaultTtl", seconds: Number(e.target.value) })}
              >
                {TTL_CHOICES.map(choice => (
                  <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>
                ))}
              </select>
            </span>
            <span className="field-hint">只影响之后新建的令牌；已有令牌的到期时间不变。</span>
          </div>
        </div>
      </div>

      <div className="card">
        <CardHead
          title="令牌"
          desc="明文只在创建那一刻显示一次；轮换会立即作废旧值，吊销则直接作废。"
          actions={
            <div className="btn-group">
              <Chip tone={settings.usableCount > 0 ? "ok" : "idle"}>{settings.usableCount} 有效</Chip>
              <Chip tone={settings.deadCount > 0 ? "warn" : "idle"}>{settings.deadCount} 失效</Chip>
              <button type="button" className="small primary" onClick={() => setShowForm(v => !v)}>
                {showForm ? "收起" : "新建令牌"}
              </button>
            </div>
          }
        />

        {showForm && (
          <div className="toolbar" style={{ border: "1px dashed var(--border-strong)", borderRadius: 8, padding: 12 }}>
            <input type="text" placeholder="标签（如 chatgpt-web）" value={label} onChange={e => setLabel(e.target.value)} aria-label="令牌标签" />
            <select value={ttl} onChange={e => setTtl(Number(e.target.value))} aria-label="令牌有效期">
              {TTL_CHOICES.map(choice => (
                <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>
              ))}
            </select>
            {/* Disabled while in flight: a double click minted two tokens and
                the one-time plaintext of the first was overwritten — an
                unauthenticated-forever token nobody could ever use. */}
            <button className="primary small" disabled={creating} onClick={() => void create()}>
              {creating ? "创建中…" : "创建"}
            </button>
          </div>
        )}

        {settings.tokens.length === 0 ? (
          <div className="section-note" style={{ marginBottom: 0 }}>
            还没有令牌。开启鉴权前必须先创建至少一个。
          </div>
        ) : (
          <div className="table-wrap">
            <table className="token-table">
              <thead>
                <tr>
                  <th>标签</th>
                  <th>ID</th>
                  <th>状态</th>
                  <th>创建</th>
                  <th>过期</th>
                  <th className="num">使用</th>
                  <th className="actions">操作</th>
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
                          label="复制令牌 ID"
                          onCopied={() => notify?.("令牌 ID 已复制。")}
                        />
                      </span>
                    </td>
                    <td>{tokenPill(token)}</td>
                    <td className="muted">{fmtDate(token.created_at)}</td>
                    <td className="muted">{token.expires_at ? fmtDate(token.expires_at) : "永久"}</td>
                    <td className="num">{token.use_count}</td>
                    <td className="actions">
                      <span className="row-actions">
                        {!token.revoked && !token.expired && (
                          <>
                            <button className="small" onClick={() => void act({ command: "rotateToken", id: token.id })}>轮换</button>
                            <ConfirmButton label="吊销" onConfirm={() => void act({ command: "revokeToken", id: token.id })} />
                          </>
                        )}
                        <ConfirmButton label="删除" onConfirm={() => void act({ command: "deleteToken", id: token.id })} />
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
            清理失效令牌
          </button>
          <ConfirmButton label="吊销全部" onConfirm={() => void act({ command: "revokeAll" })} />
          <span className="spacer" />
          <span className="section-note" style={{ margin: 0 }}>共 {settings.tokens.length} 条</span>
        </div>
      </div>
    </>
  );
}
