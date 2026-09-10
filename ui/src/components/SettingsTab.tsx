import { useState } from "react";
import type { SettingsState } from "../api";

interface Props {
  settings: SettingsState | null;
  act: (action: Record<string, unknown>) => Promise<unknown>;
}

export function SettingsTab({ settings, act }: Props) {
  const [domain, setDomain] = useState<string | null>(null);

  if (!settings) return <div className="card">加载中…</div>;
  const cfg = settings.config;
  const domainValue = domain ?? settings.configuredDomain;

  const setConfig = (key: string, value: unknown) => { void act({ command: "setConfig", key, value }); };

  return (
    <>
      <div className="card">
        <h2>隧道（ngrok）</h2>
        <div className="row">
          <span className="label">提供商</span>
          <select value={cfg.tunnelProvider} onChange={e => setConfig("tunnelProvider", e.target.value)}>
            <option value="ngrok">ngrok</option>
            <option value="none">none（仅本地）</option>
          </select>
        </div>
        <div className="row">
          <span className="label">预留域名</span>
          <input
            type="text"
            value={domainValue}
            placeholder="example.ngrok-free.dev"
            onChange={e => setDomain(e.target.value)}
          />
          <button
            className="small"
            disabled={domain === null}
            onClick={() => { void act({ command: "saveDomain", domain: domainValue }).then(() => setDomain(null)); }}
          >
            保存域名
          </button>
        </div>
        <div className="row">
          <span className="label">ngrok 可执行文件</span>
          <input
            type="text"
            value={cfg.ngrokExecutable}
            onChange={e => setConfig("ngrokExecutable", e.target.value)}
          />
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={cfg.autoReconnect} onChange={e => setConfig("autoReconnect", e.target.checked)} />
            隧道意外退出时自动重连
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.ngrokUseHttpProxy} onChange={e => setConfig("ngrokUseHttpProxy", e.target.checked)} />
            ngrok 继承系统代理
          </label>
        </div>
      </div>

      <div className="card">
        <h2>网络</h2>
        <div className="row">
          <span className="label">本地端口</span>
          <input
            type="number" min={0} max={65535}
            value={cfg.port}
            onChange={e => setConfig("port", Number(e.target.value))}
          />
          <span className="section-note" style={{ margin: 0 }}>0 = 自动选择空闲端口（重启 Bridge 生效）</span>
        </div>
        <div className="row">
          <span className="label">公网健康检查</span>
          <input
            type="number" min={3000} max={120000} step={1000}
            value={cfg.publicHealthTimeoutMs}
            onChange={e => setConfig("publicHealthTimeoutMs", Number(e.target.value))}
          />
          <span className="section-note" style={{ margin: 0 }}>毫秒（3000-120000）</span>
        </div>
      </div>

      <div className="card">
        <h2>文件访问</h2>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={cfg.unrestrictedFileAccess} onChange={e => setConfig("unrestrictedFileAccess", e.target.checked)} />
            允许访问项目根之外的路径（个人本机推荐）
          </label>
        </div>
        {!cfg.unrestrictedFileAccess && (
          <div className="row">
            <textarea
              placeholder={"每行一个绝对目录，如\nC:\\projects\\shared"}
              value={cfg.allowedDirectories.join("\n")}
              onChange={e => setConfig("allowedDirectories", e.target.value.split("\n").map(s => s.trim()).filter(Boolean))}
            />
          </div>
        )}
      </div>

      <div className="card">
        <h2>Shell 与工具</h2>
        <div className="row">
          <span className="label">Shell 路径</span>
          <input
            type="text"
            value={cfg.shellPath}
            placeholder="留空自动探测（Git Bash → pwsh → powershell）"
            onChange={e => setConfig("shellPath", e.target.value)}
          />
        </div>
        <div className="row">
          <span className="label">Shell 参数</span>
          <input
            type="text"
            value={cfg.shellArgs.join(" ")}
            placeholder="留空使用默认参数"
            onChange={e => setConfig("shellArgs", e.target.value.trim() ? e.target.value.trim().split(/\s+/) : [])}
          />
        </div>
        <div className="row">
          <span className="label">工具集</span>
          <select value={cfg.toolProfile} onChange={e => setConfig("toolProfile", e.target.value)}>
            <option value="full">full（全部工具）</option>
            <option value="core">core（精简常用）</option>
          </select>
        </div>
      </div>

      <div className="card">
        <h2>并发锁</h2>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              checked={settings.concurrency.enabled}
              onChange={e => void act({
                command: "setConcurrency",
                enabled: e.target.checked,
                holdTimeoutMs: settings.concurrency.holdTimeoutMs,
                waitTimeoutMs: settings.concurrency.waitTimeoutMs,
              })}
            />
            串行化可能产生竞争的工具调用
          </label>
        </div>
        {settings.concurrency.enabled && (
          <>
            <div className="row">
              <span className="label">占用上限</span>
              <input
                type="number" min={0}
                value={settings.concurrency.holdTimeoutMs}
                onChange={e => void act({
                  command: "setConcurrency",
                  enabled: true,
                  holdTimeoutMs: Number(e.target.value),
                  waitTimeoutMs: settings.concurrency.waitTimeoutMs,
                })}
              />
              <span className="section-note" style={{ margin: 0 }}>毫秒，0 = 不限</span>
            </div>
            <div className="row">
              <span className="label">等待上限</span>
              <input
                type="number" min={0}
                value={settings.concurrency.waitTimeoutMs}
                onChange={e => void act({
                  command: "setConcurrency",
                  enabled: true,
                  holdTimeoutMs: settings.concurrency.holdTimeoutMs,
                  waitTimeoutMs: Number(e.target.value),
                })}
              />
              <span className="section-note" style={{ margin: 0 }}>毫秒，0 = 无限等待</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
