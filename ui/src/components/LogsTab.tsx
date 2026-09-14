import { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../api";
import { Card } from "./Card";
import { Chip } from "./Chip";

type Level = "error" | "warn" | "info" | "";

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

/** Live bridge log via SSE (/api/logs/stream). */
export function LogsTab() {
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
      setNote((prev: string) => (prev.startsWith("连接已断开") ? "" : prev));
    };
    source.onerror = () => {
      setConnected(false);
      if (pausedRef.current) return;
      setNote("连接已断开，自动重连中……断线期间的日志行会缺失，完整审计在数据目录 audit.log。");
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
    <Card
      title="日志"
      desc="实时日志流（最近 800 行）。断线期间的行会缺失；完整审计在数据目录的 audit.log。"
      actions={
        <div className="btn-group">
          {errorCount > 0 ? <Chip tone="err">{errorCount} 条错误</Chip> : null}
          <span className={`live-dot ${dotState}`}>
            {!connected ? "已断开，重连中" : paused ? "已暂停" : "实时"}
          </span>
        </div>
      }
    >
      <div className="logbar">
        <button className="small" onClick={() => setPaused(v => !v)}>{paused ? "继续" : "暂停"}</button>
        <button className="small" onClick={() => setLines([])}>清空视图</button>
        <button
          className="small"
          onClick={() => {
            if (!lines.length) { setNote("还没有日志可复制。"); return; }
            void copyText(lines.join("\n")).then(() => setNote(`已复制 ${lines.length} 行。`));
          }}
        >
          复制日志
        </button>
        <span className="grow" />
        <span className="count">{lines.length} 行</span>
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
          <span className="t">等待日志…</span>
        ) : parsed.map((line, index) => (
          <div className={`log-line${line.level ? ` level-${line.level}` : ""}`} key={index}>
            <span className="log-level">{line.tag}</span>
            <span className="log-text">{line.text}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
