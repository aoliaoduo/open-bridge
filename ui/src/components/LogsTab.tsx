import { useEffect, useMemo, useRef, useState } from "react";
import { copyText, type SettingsState } from "../api";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { Field } from "./Field";

type Level = "error" | "warn" | "info" | "";

/** Mirrors the server's CONFIG_SPEC bound (src/bridge/config-values.ts) so a
 *  value the UI accepts never comes back as an inscrutable 400. */
const LOG_MAX_BYTES = { min: 0, max: 1_073_741_824 } as const;

/**
 * Pull the level word out of a log line so the pane can colour it.
 *
 * The bridge writes one line per event; a wall of same-coloured text is exactly
 * the thing an operator scrolls past without reading. The level is looked for
 * anywhere in the line (not only at the start) because the prefix differs
 * between the log file, the SSE stream and the audit log.
 */
function parseLine(line: string): { level: Level; tag: string; text: string } {
  const match = /\b(ERROR|WARN|WARNING|INFO|DEBUG)\b/.exec(line.slice(0, 120));
  if (!match) return { level: "", tag: "", text: line };
  // Group 1 is a mandatory alternation, so it is always one of those five
  // words; "" (no tag) is the same answer this function gives for no match.
  const found = match[1] ?? "";
  const word = found === "WARNING" ? "WARN" : found === "DEBUG" ? "" : found;
  const level: Level = word === "ERROR" ? "error" : word === "WARN" ? "warn" : word === "INFO" ? "info" : "";
  return { level, tag: word, text: line };
}

/**
 * Live bridge log via SSE (/api/logs/stream), plus the rotation setting.
 *
 * Rotation used to be a 设置 sub-page called 日志轮转, one field away from the
 * only screen that shows what it governs. It sits here now for the same reason
 * the tool profile sits on 工具: the knob and the thing it acts on belong
 * together, and 设置 was collecting pages whose subject lived elsewhere.
 */
export function LogsTab({ settings, act, notify }: {
  settings?: SettingsState | null;
  act?: (action: Record<string, unknown>) => Promise<unknown>;
  notify?: (text: string, isError?: boolean) => void;
} = {}) {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [note, setNote] = useState("");
  const [connected, setConnected] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // True when the user is parked at the bottom; only then does new output
  // auto-scroll. Scrolling up to read history freezes the pane so the next
  // line does not yank them away from what they were reading. Resume on
  // scroll-back-to-bottom is automatic.
  const stickToBottomRef = useRef(true);
  // True while the note on screen is the one this component wrote about a
  // dropped connection, so reconnecting clears that note and nothing else.
  const autoNoteRef = useRef(false);

  useEffect(() => {
    const source = new EventSource("/api/logs/stream");
    source.onmessage = event => {
      try {
        const { line } = JSON.parse(event.data) as { line: string };
        if (pausedRef.current) return;
        setLines(prev => [...prev.slice(-800), line]);
      } catch { /* malformed frame */ }
    };
    // Surface disconnects: while the Bridge restarts, EventSource retries
    // silently and the page just looked frozen — the operator had no way to
    // know the quiet stretch was missing lines rather than a quiet log.
    source.onopen = () => {
      setConnected(true);
      // Compare against a flag, not against the text: the note is translated,
      // so matching its prefix would leave a stale "disconnected" banner on
      // screen for whichever language was not hard-coded here.
      // Read the ref BEFORE clearing it: the updater passed to setNote runs
      // later, during render, when the ref would already be false.
      const wasAuto = autoNoteRef.current;
      autoNoteRef.current = false;
      setNote((prev: string) => (wasAuto ? "" : prev));
    };
    source.onerror = () => {
      setConnected(false);
      if (pausedRef.current) return;
      autoNoteRef.current = true;
      setNote(t(
        "连接已断开，自动重连中……断线期间的日志行会缺失，完整审计在数据目录 audit.log。",
        "Disconnected, reconnecting… lines written while offline are lost; the full audit is in audit.log in the data directory.",
      ));
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (box && stickToBottomRef.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const parsed = useMemo(() => lines.map(parseLine), [lines]);
  const errorCount = parsed.filter(line => line.level === "error").length;

  const dotState = !connected ? "offline" : paused ? "paused" : "";

  return (
    <>
    <Card
      title={t("日志", "Logs")}
      desc={t(
        "实时日志流（最近 800 行）。断线期间的行会缺失；完整审计在数据目录的 audit.log。",
        "Live log stream (last 800 lines). Lines written while disconnected are lost; the full audit is in audit.log in the data directory.",
      )}
      actions={
        <div className="btn-group">
          {errorCount > 0 ? <Chip tone="err">{t(`${errorCount} 条错误`, `${errorCount} errors`)}</Chip> : null}
          <span className={`live-dot ${dotState}`}>
            {!connected
              ? t("已断开，重连中", "Disconnected, reconnecting")
              : paused ? t("已暂停", "Paused") : t("实时", "Live")}
          </span>
        </div>
      }
    >
      <div className="logbar">
        <button className="small" onClick={() => setPaused(v => !v)}>
          {paused ? t("继续", "Resume") : t("暂停", "Pause")}
        </button>
        <button className="small" onClick={() => setLines([])}>{t("清空视图", "Clear view")}</button>
        <button
          className="small"
          onClick={() => {
            if (!lines.length) { setNote(t("还没有日志可复制。", "No log lines to copy yet.")); return; }
            void copyText(lines.join("\n"))
              .then(() => setNote(t(`已复制 ${lines.length} 行。`, `Copied ${lines.length} lines.`)));
          }}
        >
          {t("复制日志", "Copy log")}
        </button>
        <span className="grow" />
        <span className="count">{t(`${lines.length} 行`, `${lines.length} lines`)}</span>
      </div>

      {note && <div className="section-note">{note}</div>}

      <div
        className="log-stream"
        ref={boxRef}
        onScroll={event => {
          // 16px slop so a half-pixel of anti-aliasing does not flip the
          // sticky state every render.
          const target = event.currentTarget;
          const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
          stickToBottomRef.current = distanceFromBottom < 16;
        }}
      >
        {parsed.length === 0 ? (
          // Reached only before the stream answers: the server now replays the
          // tail on connect, so an empty pane means a genuinely empty log.
          <span className="t">{t("等待日志…", "Waiting for logs…")}</span>
        ) : parsed.map((line, index) => (
          <div className={`log-line${line.level ? ` level-${line.level}` : ""}`} key={index}>
            <span className="log-level">{line.tag}</span>
            <span className="log-text">{line.text}</span>
          </div>
        ))}
      </div>
    </Card>

    {settings && act ? (
      <Card
        title={t("日志轮转", "Log rotation")}
        desc={
          <>
            <span className="mono">bridge.log</span>
            {t(
              " 长到一个上限就轮转成 ",
              " rotates into ",
            )}
            <span className="mono">bridge.log.1</span>
            {t(
              "（只留上一代，和审计日志、服务日志同一套做法），旧的覆盖旧的，磁盘不再只涨不落。0 = 不轮转。重启 Bridge 生效。",
              " once it reaches a size limit (one generation kept, same as the audit and service logs), so disk use stops growing forever. 0 disables rotation. Takes effect after a restart.",
            )}
          </>
        }
      >
        <div className="form-grid">
          <Field
            label={t("单文件上限", "Max file size")}
            hint={t(
              "字节（默认 10485760 = 10 MiB，0 = 不轮转）；失焦时保存。",
              "Bytes (default 10485760 = 10 MiB, 0 disables); saved on blur.",
            )}
          >
            <input
              type="number"
              min={LOG_MAX_BYTES.min}
              max={LOG_MAX_BYTES.max}
              defaultValue={String(settings.config.logMaxBytes)}
              key={settings.config.logMaxBytes}
              aria-label={t("单文件上限", "Max file size")}
              onBlur={event => {
                const raw = event.target.value.trim();
                const value = Number(raw);
                // Same rule as the server's CONFIG_SPEC: reject rather than
                // clamp, and put the saved value back so the box never shows
                // something the config does not hold.
                if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)
                  || value < LOG_MAX_BYTES.min || value > LOG_MAX_BYTES.max) {
                  event.target.value = String(settings.config.logMaxBytes);
                  notify?.(t(
                    `单文件上限需要整数 ${LOG_MAX_BYTES.min}–${LOG_MAX_BYTES.max}，已还原为保存的值。`,
                    `Max file size must be an integer between ${LOG_MAX_BYTES.min} and ${LOG_MAX_BYTES.max}; reverted to the saved value.`,
                  ), true);
                  return;
                }
                if (value === settings.config.logMaxBytes) return;
                void act({ command: "setConfig", key: "logMaxBytes", value });
              }}
            />
          </Field>
        </div>
      </Card>
    ) : null}
    </>
  );
}
