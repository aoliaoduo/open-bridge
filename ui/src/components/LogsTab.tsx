import { useEffect, useRef, useState } from "react";

/** Live bridge log via SSE (/api/logs/stream). */
export function LogsTab() {
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
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
    return () => source.close();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines]);

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="small" onClick={() => setPaused(v => !v)}>{paused ? "继续" : "暂停"}</button>
        <button className="small" onClick={() => setLines([])}>清空视图</button>
        <span className="section-note" style={{ margin: 0 }}>
          实时日志流（最近 800 行；完整审计在数据目录的 audit.log）
        </span>
      </div>
      <div className="log-stream" ref={boxRef}>
        {lines.length === 0 ? <span className="t">等待日志…</span> : lines.map((line, index) => <div key={index}>{line}</div>)}
      </div>
    </>
  );
}
