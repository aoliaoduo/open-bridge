import { useEffect, useState } from "react";
import type { SettingsActionResult, SettingsState } from "../api";

interface Props {
  settings: SettingsState | null;
  act: (action: Record<string, unknown>) => Promise<unknown>;
  /** Invalid-input feedback: shows a toast instead of failing silently. */
  notify?: (text: string, isError?: boolean) => void;
}

/** Bounds mirror the server's CONFIG_SPEC (src/bridge/settings-model.ts) so a
 *  value the UI accepts never comes back as an inscrutable 400. */
const NUMBER_BOUNDS = {
  port: { min: 0, max: 65_535, label: "本地端口" },
  publicHealthTimeoutMs: { min: 3_000, max: 120_000, label: "公网健康检查" },
  holdTimeoutMs: { min: 0, max: 3_600_000, label: "占用上限" },
  waitTimeoutMs: { min: 0, max: 3_600_000, label: "等待上限" },
  logMaxBytes: { min: 0, max: 1_073_741_824, label: "单文件上限" },
} as const;

/**
 * One draft field: edits stay local until blur (or Enter). The previous
 * version called setConfig on EVERY keystroke — each one a config.json write,
 * and intermediate values (a half-typed port, a health timeout below its
 * minimum) fired error toasts on every key.
 *
 * Number fields validate on commit against the server's bounds: an invalid
 * value is REVERTED to the saved one with a toast, never silently kept — the
 * old behaviour left the input showing a value the config did not hold, and
 * the operator only found out on the next reload.
 */
function DraftField({
  value,
  onCommit,
  onInvalid,
  type = "text",
  min,
  max,
  step,
  placeholder,
  multiline = false,
}: {
  value: string;
  onCommit: (raw: string) => void;
  onInvalid?: () => void;
  type?: "text" | "number";
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** Render a <textarea>: HTML inputs strip newlines from their value, which
   *  silently merged the allowedDirectories list into one bogus path. */
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // Follow authoritative changes while the operator is not editing.
  useEffect(() => { setDraft(value); }, [value]);
  const commit = (): void => {
    if (draft === value) return;
    if (type === "number") {
      const n = Number(draft.trim());
      const bad = draft.trim() === ""
        || !Number.isInteger(n)
        || (min !== undefined && n < min)
        || (max !== undefined && n > max);
      if (bad) {
        onInvalid?.();
        setDraft(value);
        return;
      }
    }
    onCommit(draft);
  };
  if (multiline) {
    return (
      <textarea
        rows={4}
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <input
      type={type}
      min={min}
      max={max}
      step={step}
      value={draft}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
    />
  );
}

export function SettingsTab({ settings, act, notify }: Props) {
  const [domain, setDomain] = useState<string | null>(null);

  if (!settings) return <div className="card">加载中…</div>;
  const cfg = settings.config;
  const domainValue = domain ?? settings.configuredDomain;

  const setConfig = (key: string, value: unknown) => { void act({ command: "setConfig", key, value }); };

  /**
   * Commit a number the DraftField has already validated against NUMBER_BOUNDS
   * (it reverts and reports the rejection itself, via `invalidFor`). Re-checking
   * here would be a second copy of the same rule that can only ever agree.
   */
  const commitNumber = (key: keyof typeof NUMBER_BOUNDS, raw: string): void => {
    setConfig(key, Number(raw.trim()));
  };

  /** Rejection feedback for a DraftField; the revert is DraftField's own job. */
  const invalidFor = (key: keyof typeof NUMBER_BOUNDS) => (): void => {
    const { label, min, max } = NUMBER_BOUNDS[key];
    notify?.(`${label} 需要整数 ${min}–${max}，已还原为保存的值。`, true);
  };

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
            onClick={() => {
              // Reset the draft only on success: a rejected domain (bad
              // format) used to wipe the operator's typing along with the
              // toast, making them retype it from scratch.
              void act({ command: "saveDomain", domain: domainValue }).then(result => {
                if ((result as SettingsActionResult | null)?.ok) setDomain(null);
              });
            }}
          >
            保存域名
          </button>
        </div>
        <div className="row">
          <span className="label">ngrok 可执行文件</span>
          <DraftField
            value={cfg.ngrokExecutable}
            onCommit={raw => setConfig("ngrokExecutable", raw)}
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
          <DraftField
            type="number"
            min={NUMBER_BOUNDS.port.min}
            max={NUMBER_BOUNDS.port.max}
            value={String(cfg.port)}
            onCommit={raw => commitNumber("port", raw)}
            onInvalid={invalidFor("port")}
          />
          <span className="section-note" style={{ margin: 0 }}>0 = 自动选择空闲端口（重启 Bridge 生效）；失焦时保存</span>
        </div>
        <div className="row">
          <span className="label">公网健康检查</span>
          <DraftField
            type="number"
            min={NUMBER_BOUNDS.publicHealthTimeoutMs.min}
            max={NUMBER_BOUNDS.publicHealthTimeoutMs.max}
            step={1000}
            value={String(cfg.publicHealthTimeoutMs)}
            onCommit={raw => commitNumber("publicHealthTimeoutMs", raw)}
            onInvalid={invalidFor("publicHealthTimeoutMs")}
          />
          <span className="section-note" style={{ margin: 0 }}>毫秒（3000-120000）；失焦时保存</span>
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
          <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
            {/* A textarea, not an input: HTML value sanitization strips \n from
                text inputs, so the list silently merged into one bogus path
                the moment the operator edited and blurred the field. */}
            <DraftField
              multiline
              value={cfg.allowedDirectories.join("\n")}
              placeholder={"每行一个绝对目录，如\nC:\\projects\\shared"}
              onCommit={raw => setConfig("allowedDirectories", raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))}
            />
            <span className="section-note">每行一个绝对目录；失焦时保存</span>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Shell 与工具</h2>
        <div className="row">
          <span className="label">Shell 路径</span>
          <DraftField
            value={cfg.shellPath}
            placeholder="留空自动探测（Git Bash → pwsh → powershell）"
            onCommit={raw => setConfig("shellPath", raw)}
          />
        </div>
        <div className="row">
          <span className="label">Shell 参数</span>
          <DraftField
            value={cfg.shellArgs.join(" ")}
            placeholder="留空使用默认参数"
            onCommit={raw => setConfig("shellArgs", raw.trim() ? raw.trim().split(/\s+/) : [])}
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
              <DraftField
                type="number"
                min={NUMBER_BOUNDS.holdTimeoutMs.min}
                max={NUMBER_BOUNDS.holdTimeoutMs.max}
                value={String(settings.concurrency.holdTimeoutMs)}
                onCommit={raw => void act({
                  command: "setConcurrency",
                  enabled: true,
                  holdTimeoutMs: Number(raw.trim()),
                  waitTimeoutMs: settings.concurrency.waitTimeoutMs,
                })}
                onInvalid={invalidFor("holdTimeoutMs")}
              />
              <span className="section-note" style={{ margin: 0 }}>毫秒，0 = 不限；失焦时保存</span>
            </div>
            <div className="row">
              <span className="label">等待上限</span>
              <DraftField
                type="number"
                min={NUMBER_BOUNDS.waitTimeoutMs.min}
                max={NUMBER_BOUNDS.waitTimeoutMs.max}
                value={String(settings.concurrency.waitTimeoutMs)}
                onCommit={raw => void act({
                  command: "setConcurrency",
                  enabled: true,
                  holdTimeoutMs: settings.concurrency.holdTimeoutMs,
                  waitTimeoutMs: Number(raw.trim()),
                })}
                onInvalid={invalidFor("waitTimeoutMs")}
              />
              <span className="section-note" style={{ margin: 0 }}>毫秒，0 = 无限等待；失焦时保存</span>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>日志</h2>
        <div className="section-note">
          <span className="mono">bridge.log</span> 长到一个上限就轮转成{" "}
          <span className="mono">bridge.log.1</span>（只留上一代，和审计日志、服务日志同一套做法），
          旧的覆盖旧的，磁盘不再只涨不落。0 = 不轮转。重启 Bridge 生效。
        </div>
        <div className="row">
          <span className="label">单文件上限</span>
          <DraftField
            type="number"
            min={NUMBER_BOUNDS.logMaxBytes.min}
            max={NUMBER_BOUNDS.logMaxBytes.max}
            value={String(cfg.logMaxBytes)}
            onCommit={raw => commitNumber("logMaxBytes", raw)}
            onInvalid={invalidFor("logMaxBytes")}
          />
          <span className="section-note" style={{ margin: 0 }}>字节（默认 10485760 = 10 MiB，0 = 不轮转）；失焦时保存</span>
        </div>
      </div>
    </>
  );
}
