import { useState } from "react";
import type { SettingsActionResult, SettingsState, SettingsTokenRow } from "../api";
import { ConfirmButton } from "./ConfirmButton";

interface Props {
  settings: SettingsState;
  act: (action: Record<string, unknown>) => Promise<SettingsActionResult | null>;
}

const TTL_CHOICES: Array<{ seconds: number; label: string }> = [
  { seconds: 0, label: "永久（不过期）" },
  { seconds: 3600, label: "1 小时" },
  { seconds: 86400, label: "1 天" },
  { seconds: 604800, label: "7 天" },
  { seconds: 2592000, label: "30 天" },
  { seconds: 7776000, label: "90 天" },
];

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

export function TokensTab({ settings, act }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState(settings.defaultTtlSeconds);

  const create = async () => {
    const result = await act({ command: "createToken", label, ttlSeconds: ttl });
    if (result?.ok) {
      setShowForm(false);
      setLabel("");
    }
  };

  const tokenPill = (token: SettingsTokenRow) => {
    if (token.revoked) return <span className="pill dead">已吊销</span>;
    if (token.expired) return <span className="pill dead">已过期</span>;
    return <span className="pill ok">有效</span>;
  };

  return (
    <>
      <div className="card">
        <h2>Bearer 鉴权</h2>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.authEnabled}
              onChange={e => void act({ command: "setAuthEnabled", enabled: e.target.checked })}
            />
            要求 /mcp 端点携带令牌
          </label>
          <span className="section-note" style={{ margin: 0 }}>
            {settings.authEnabled
              ? "已开启 — 客户端必须发送 Authorization: Bearer <token>"
              : "默认关闭 — URL 里的路由令牌是唯一凭证"}
          </span>
        </div>
        <div className="row">
          <span className="label">新令牌默认有效期</span>
          <select value={settings.defaultTtlSeconds} onChange={e => void act({ command: "setDefaultTtl", seconds: Number(e.target.value) })}>
            {TTL_CHOICES.map(choice => (
              <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <h2>令牌（{settings.usableCount} 有效 · {settings.deadCount} 失效）</h2>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="small" onClick={() => setShowForm(v => !v)}>
            {showForm ? "收起" : "新建令牌"}
          </button>
        </div>

        {showForm && (
          <div className="row" style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: 12 }}>
            <input type="text" placeholder="标签（如 chatgpt-web）" value={label} onChange={e => setLabel(e.target.value)} />
            <select value={ttl} onChange={e => setTtl(Number(e.target.value))}>
              {TTL_CHOICES.map(choice => (
                <option key={choice.seconds} value={choice.seconds}>{choice.label}</option>
              ))}
            </select>
            <button className="primary small" onClick={() => void create()}>创建</button>
          </div>
        )}

        {settings.tokens.length === 0 ? (
          <div className="section-note">还没有令牌。开启鉴权前必须先创建至少一个。</div>
        ) : (
          <table className="token-table">
            <thead>
              <tr>
                <th>标签</th>
                <th>ID</th>
                <th>状态</th>
                <th>创建</th>
                <th>过期</th>
                <th>使用</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {settings.tokens.map(token => (
                <tr key={token.id} className={token.revoked || token.expired ? "dead" : ""}>
                  <td>{token.label}</td>
                  <td className="mono">{token.id}</td>
                  <td>{tokenPill(token)}</td>
                  <td>{fmtDate(token.created_at)}</td>
                  <td>{token.expires_at ? fmtDate(token.expires_at) : "永久"}</td>
                  <td>{token.use_count}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {!token.revoked && !token.expired && (
                      <>
                        <button className="small" onClick={() => void act({ command: "rotateToken", id: token.id })}>轮换</button>
                        {" "}
                        <ConfirmButton label="吊销" onConfirm={() => void act({ command: "revokeToken", id: token.id })} />
                        {" "}
                      </>
                    )}
                    <ConfirmButton label="删除" onConfirm={() => void act({ command: "deleteToken", id: token.id })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="row" style={{ marginTop: 12 }}>
          <button className="small" disabled={settings.deadCount === 0} onClick={() => void act({ command: "purgeTokens" })}>
            清理失效令牌
          </button>
          <ConfirmButton label="吊销全部" onConfirm={() => void act({ command: "revokeAll" })} />
        </div>
      </div>
    </>
  );
}
