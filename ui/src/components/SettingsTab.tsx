import { useEffect, useState } from "react";
import { type SettingsActionResult, type SettingsState } from "../api";
import { CardHead } from "./CardHead";
import { Field } from "./Field";
import { SectionNav } from "./SectionNav";
import { Skeleton } from "./Skeleton";

interface Props {
  settings: SettingsState | null;
  act: (action: Record<string, unknown>) => Promise<unknown>;
  /** Invalid-input feedback: shows a toast instead of failing silently. */
  notify?: (text: string, isError?: boolean) => void;
}

/**
 * 设置 card order, mirrored by the section rail under the page header. Ids are
 * explicit strings rather than titles run through a slugifier: a reworded
 * heading must not silently break every anchor on the page.
 */
const SETTINGS_SECTIONS = [
  { id: "set-tunnel", label: "隧道" },
  { id: "set-network", label: "端口" },
  { id: "set-files", label: "目录" },
  { id: "set-shell", label: "Shell" },
  { id: "set-locks", label: "并发" },
  { id: "set-logs", label: "日志轮转" },
];

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
export function DraftField({
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

/** A switch field: label on top, the switch plus its current state under it. */
function SwitchField(
  { label, hint, checked, onChange }: {
    label: string;
    hint?: string;
    checked: boolean;
    onChange: (next: boolean) => void;
  },
) {
  return (
    <div className="field">
      <label className="check">
        <input type="checkbox" className="switch" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span className="field-label">{label}</span>
      </label>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function SettingsTab({ settings, act, notify }: Props) {
  const [domain, setDomain] = useState<string | null>(null);

  if (!settings) return <div className="card"><Skeleton lines={4} /></div>;
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
      <SectionNav items={SETTINGS_SECTIONS} />

      <div className="card" id="set-tunnel">
        <CardHead
          title="隧道（ngrok）"
          desc="隧道让公网上的客户端连到这台机器；不开隧道时只有本机能访问。"
        />
        <div className="form-grid">
          <Field label="提供商" hint="none 表示只用本机回环地址，适合纯本机客户端。">
            <select value={cfg.tunnelProvider} onChange={e => setConfig("tunnelProvider", e.target.value)}>
              <option value="ngrok">ngrok</option>
              <option value="none">none（仅本地）</option>
            </select>
          </Field>

          <div className="field">
            <span className="field-label">预留域名</span>
            <span className="field-control">
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
            </span>
            <span className="field-hint">留空则使用 ngrok 分配的随机地址；改动后需要重启隧道。</span>
          </div>

          <Field label="ngrok 可执行文件" hint="留空则使用 PATH 里的 ngrok。">
            <DraftField
              value={cfg.ngrokExecutable}
              placeholder="ngrok"
              onCommit={raw => setConfig("ngrokExecutable", raw)}
            />
          </Field>

          <SwitchField
            label="隧道意外退出时自动重连"
            hint="伴随进程退出时按退避重试，不需要人工点重新启动。"
            checked={cfg.autoReconnect}
            onChange={next => setConfig("autoReconnect", next)}
          />
          <SwitchField
            label="ngrok 继承系统代理"
            hint="公司网络需要走代理时打开；直连环境关掉更快。"
            checked={cfg.ngrokUseHttpProxy}
            onChange={next => setConfig("ngrokUseHttpProxy", next)}
          />
        </div>
      </div>

      <div className="card" id="set-network">
        <CardHead title="网络" desc="本机监听端口与公网健康检查的超时。" />
        <div className="form-grid">
          <Field label="本地端口" hint="0 = 自动选择空闲端口（重启 Bridge 生效）；失焦时保存。">
            <DraftField
              type="number"
              min={NUMBER_BOUNDS.port.min}
              max={NUMBER_BOUNDS.port.max}
              value={String(cfg.port)}
              onCommit={raw => commitNumber("port", raw)}
              onInvalid={invalidFor("port")}
            />
          </Field>
          <Field label="公网健康检查" hint="毫秒（3000–120000）；失焦时保存。">
            <DraftField
              type="number"
              min={NUMBER_BOUNDS.publicHealthTimeoutMs.min}
              max={NUMBER_BOUNDS.publicHealthTimeoutMs.max}
              step={1000}
              value={String(cfg.publicHealthTimeoutMs)}
              onCommit={raw => commitNumber("publicHealthTimeoutMs", raw)}
              onInvalid={invalidFor("publicHealthTimeoutMs")}
            />
          </Field>
        </div>
      </div>

      <div className="card" id="set-files">
        <CardHead
          title="文件访问"
          desc="默认允许访问项目根之外的路径（个人本机推荐）；关掉之后只有下面列出的目录可读写。"
        />
        <SwitchField
          label="允许访问项目根之外的路径"
          checked={cfg.unrestrictedFileAccess}
          onChange={next => setConfig("unrestrictedFileAccess", next)}
        />
        {!cfg.unrestrictedFileAccess && (
          <div className="field">
            <span className="field-label">允许的目录</span>
            <span className="field-control">
              {/* A textarea, not an input: HTML value sanitization strips \n from
                  text inputs, so the list silently merged into one bogus path
                  the moment the operator edited and blurred the field. */}
              <DraftField
                multiline
                value={cfg.allowedDirectories.join("\n")}
                placeholder={"每行一个绝对目录，如\nC:\\projects\\shared"}
                onCommit={raw => setConfig("allowedDirectories", raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))}
              />
            </span>
            <span className="field-hint">每行一个绝对目录；失焦时保存</span>
          </div>
        )}
      </div>

      <div className="card" id="set-shell">
        <CardHead title="Shell 与工具" desc="命令通过哪个 shell 执行，以及这台实例对外公布哪些工具。" />
        <div className="form-grid">
          <Field label="Shell 路径" hint="留空自动探测（Git Bash → pwsh → powershell）。">
            <DraftField
              value={cfg.shellPath}
              placeholder="留空自动探测（Git Bash → pwsh → powershell）"
              onCommit={raw => setConfig("shellPath", raw)}
            />
          </Field>
          <Field label="Shell 参数" hint="留空使用默认参数。">
            <DraftField
              value={cfg.shellArgs.join(" ")}
              placeholder="留空使用默认参数"
              onCommit={raw => setConfig("shellArgs", raw.trim() ? raw.trim().split(/\s+/) : [])}
            />
          </Field>
          <Field label="工具集" hint="core 只公布常用工具，客户端看到的清单更短。">
            <select value={cfg.toolProfile} onChange={e => setConfig("toolProfile", e.target.value)}>
              <option value="full">full（全部工具）</option>
              <option value="core">core（精简常用）</option>
            </select>
          </Field>
        </div>
      </div>

      <div className="card" id="set-locks">
        <CardHead
          title="并发锁"
          desc="并发写同一个目录时让第二个调用者等待，而不是互相覆盖。"
        />
        <SwitchField
          label="串行化可能产生竞争的工具调用"
          checked={settings.concurrency.enabled}
          onChange={next => void act({
            command: "setConcurrency",
            enabled: next,
            holdTimeoutMs: settings.concurrency.holdTimeoutMs,
            waitTimeoutMs: settings.concurrency.waitTimeoutMs,
          })}
        />
        {settings.concurrency.enabled && (
          <div className="form-grid">
            <Field label="占用上限" hint="毫秒，0 = 不限；失焦时保存。">
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
            </Field>
            <Field label="等待上限" hint="毫秒，0 = 无限等待；失焦时保存。">
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
            </Field>
          </div>
        )}
      </div>

      <div className="card" id="set-logs">
        <CardHead
          title="日志"
          desc={
            <>
              <span className="mono">bridge.log</span> 长到一个上限就轮转成 <span className="mono">bridge.log.1</span>
              （只留上一代，和审计日志、服务日志同一套做法），旧的覆盖旧的，磁盘不再只涨不落。0 = 不轮转。重启 Bridge 生效。
            </>
          }
        />
        <div className="form-grid">
          <Field label="单文件上限" hint="字节（默认 10485760 = 10 MiB，0 = 不轮转）；失焦时保存。">
            <DraftField
              type="number"
              min={NUMBER_BOUNDS.logMaxBytes.min}
              max={NUMBER_BOUNDS.logMaxBytes.max}
              value={String(cfg.logMaxBytes)}
              onCommit={raw => commitNumber("logMaxBytes", raw)}
              onInvalid={invalidFor("logMaxBytes")}
            />
          </Field>
        </div>
      </div>

    </>
  );
}
