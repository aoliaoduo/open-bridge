import { useEffect, useRef, useState } from "react";
import { copyText } from "../api";

/** Live bridge log via SSE (/api/logs/stream). */
export function LogsTab() {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [note, setNote] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

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
      setNote((prev: string) => (prev.startsWith("连接已断开") ? "" : prev));
    };
    source.onerror = () => {
      if (pausedRef.current) return;
      setNote("连接已断开，自动重连中……断线期间的日志行会缺失，完整审计在数据目录 audit.log。");
    };
    return () => source.close();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  return (
    <div className="card">
      <h2>日志</h2>
      <div className="toolbar">
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
      <div className="section-note">
        {note || "实时日志流（最近 800 行；完整审计在数据目录的 audit.log）"}
      </div>
      <div className="log-stream" ref={boxRef}>
        {lines.length === 0 ? <span className="t">等待日志…</span> : lines.map((line, index) => <div key={index}>{line}</div>)}
      </div>
    </div>
  );
}
