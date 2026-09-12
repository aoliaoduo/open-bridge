import { useEffect, useMemo, useState } from "react";
import { api, type ToolCatalog, type ToolView } from "../api";
import { CardHead } from "./CardHead";
import { Chip } from "./Chip";
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/**
 * Rough token weight of one catalog entry, CJK-aware.
 *
 * Tool definitions are resident in the client's context for the whole
 * conversation, so the catalog is a recurring cost, not a one-off. The console
 * is the only place the operator can see that number without instrumenting a
 * client — and when a description grows, the column says which tool grew.
 */
const estimateTokens = (value: string): number => {
  let cjk = 0;
  for (const char of value) if (char >= "\u4e00" && char <= "\u9fff") cjk += 1;
  return Math.round(cjk + (value.length - cjk) / 4);
};

const toolWeight = (tool: ToolView): number =>
  estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, core: tool.core }));

/**
 * 工具 — what this instance actually advertises over MCP.
 *
 * `tool_count` said "54" and nothing else; the profile switch, the host-capability
 * filter that removes editor-only tools, and the catalog itself were only visible
 * by asking a client. This page renders exactly what `tools/list` returns.
 */
export function ToolsPage({ notify }: { notify?: (text: string, isError?: boolean) => void } = {}) {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [onlyCore, setOnlyCore] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.tools()
      .then(value => { if (alive) setCatalog(value); })
      .catch(error => { if (alive) setNote(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.tools ?? []).filter(tool =>
      (!onlyCore || tool.core)
      && (!needle
        || tool.name.toLowerCase().includes(needle)
        || tool.description.toLowerCase().includes(needle)));
  }, [catalog, onlyCore, query]);

  const coreCount = (catalog?.tools ?? []).filter(tool => tool.core).length;
  const totalTokens = (catalog?.tools ?? []).reduce((sum, tool) => sum + toolWeight(tool), 0);
  const heaviest = [...(catalog?.tools ?? [])].sort((a, b) => toolWeight(b) - toolWeight(a)).slice(0, 5);

  return (
    <div className="card">
      <CardHead
        title="工具目录"
        desc={
          <>
            这份清单就是 <span className="mono">tools/list</span> 实际返回的内容：先按工具配置档过滤，再剔除本机不支持的工具
            （独立版没有编辑器，所以 <span className="mono">get_diagnostics</span> / <span className="mono">lsp</span> 不会出现）。
          </>
        }
        actions={
          catalog ? (
            <div className="btn-group">
              <Chip tone="accent">配置档 {catalog.profile}</Chip>
              <span className="section-note" style={{ margin: 0 }}>
                共 {catalog.count} 个工具（核心 {coreCount} 个）
              </span>
              {/* Its own chip, not appended to the count line: the count is a
                  fact about the instance, the estimate is a fact about the
                  context budget, and they change for different reasons. */}
              <Chip tone="idle" title="整个目录常驻客户端上下文的估算开销（CJK 按 1 token/字，其余按 4 字符/token）">
                ≈ {totalTokens.toLocaleString()} tokens
              </Chip>
            </div>
          ) : null
        }
      />

      {catalog === null ? (
        <Skeleton lines={5} />
      ) : (
        <>
          <div className="toolbar">
            <label className="search">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.7" />
                <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                placeholder="按名称或说明过滤…"
                value={query}
                onChange={event => setQuery(event.target.value)}
                aria-label="过滤工具"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                className="switch"
                checked={onlyCore}
                onChange={event => setOnlyCore(event.target.checked)}
              />
              只看核心
            </label>
            <span className="grow" />
            <span className="count">显示 {visible.length} 个</span>
          </div>

          {visible.length === 0 ? (
            <EmptyState title="没有匹配的工具。">换个关键词，或取消「只看核心」。</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>说明</th>
                    <th className="num">≈tokens</th>
                    <th className="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(tool => (
                    <tr key={tool.name}>
                      <td className="mono name">{tool.name}</td>
                      <td>{tool.core ? <Chip tone="ok">核心</Chip> : <Chip>扩展</Chip>}</td>
                      <td className="muted">{tool.description || "—"}</td>
                      <td className="num muted" title="这个条目常驻客户端上下文的估算开销（CJK 按 1 token/字，其余按 4 字符/token）">
                        {toolWeight(tool)}
                      </td>
                      <td className="actions">
                        <span className="row-actions">
                          <CopyButton
                            value={tool.name}
                            label="复制名称"
                            onCopied={() => notify?.(`已复制工具名 ${tool.name}`)}
                          />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {catalog && (
        <div className="card-foot" style={{ display: "block" }}>
          <div className="section-note" style={{ marginBottom: 4 }}>
            这一列是每个条目常驻客户端上下文的估算开销（CJK 按 1 token/字，其余按 4 字符/token）。
            最重的 5 个：{heaviest.map(tool => `${tool.name} ${toolWeight(tool)}`).join(" · ")}。
            描述预算 200 字符；长篇说明在 <span className="mono">docs/tools.md</span>。
          </div>
        </div>
      )}
      {note && <div className="section-note">{note}</div>}
    </div>
  );
}
