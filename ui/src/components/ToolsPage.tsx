import { useEffect, useMemo, useState } from "react";
import { api, type SettingsState, type ToolCatalog } from "../api";
import { errorMessage } from "../format";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { Field } from "./Field";
import { SearchToolbar, matchesNeedle } from "./SearchToolbar";
import { Skeleton } from "./Skeleton";

/**
 * 工具 — what this instance actually advertises over MCP.
 *
 * `tool_count` said "54" and nothing else; the profile switch, the host-capability
 * filter that removes editor-only tools, and the catalog itself were only visible
 * by asking a client. This page renders exactly what `tools/list` returns.
 *
 * The profile selector lives here rather than under 设置 › Shell. It decides
 * which tools this very list contains, so the setting and its effect belong on
 * one screen: change it and the catalog below is what changed. Filed under a
 * shell-and-tools settings card, it was a switch with no visible consequence.
 */
export function ToolsPage({ notify, settings, act }: {
  notify?: (text: string, isError?: boolean) => void;
  /** For the profile switch below; null while the first load is in flight. */
  settings?: SettingsState | null;
  act?: (action: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");
  const [onlyCore, setOnlyCore] = useState(false);

  // Keyed on the profile, not mounted once: the selector below writes
  // toolProfile, and the server filters this very catalog by it. With an empty
  // dependency list the page kept showing the pre-switch list -- the one screen
  // built to make the setting's effect visible was the screen that hid it, and
  // a list that did not move reads as "the switch did nothing".
  const profileSetting = settings?.config.toolProfile;
  useEffect(() => {
    let alive = true;
    void api.tools()
      .then(value => { if (alive) { setCatalog(value); setNote(""); } })
      .catch(error => { if (alive) setNote(errorMessage(error)); });
    return () => { alive = false; };
  }, [profileSetting]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.tools ?? []).filter(tool =>
      (!onlyCore || tool.core)
      && matchesNeedle(needle, tool.name, tool.description));
  }, [catalog, onlyCore, query]);

  const coreCount = (catalog?.tools ?? []).filter(tool => tool.core).length;

  return (
    <>
    {settings && act ? (
      <Card
        title={t("对外公布的工具集", "Advertised tool set")}
        desc={t(
          "决定下面这份清单包含哪些工具；改完客户端要重新连接才能看到。",
          "Decides which tools the catalog below contains; clients must reconnect to see a change.",
        )}
      >
        <div className="form-grid">
          <Field
            label={t("工具集", "Tool set")}
            hint={t(
              "core 只公布常用工具，客户端看到的清单更短。",
              "core advertises only the common tools, giving clients a shorter list.",
            )}
          >
            <select
              value={settings.config.toolProfile}
              aria-label={t("工具集", "Tool set")}
              onChange={event => { void act({ command: "setConfig", key: "toolProfile", value: event.target.value }); }}
            >
              <option value="full">{t("full（全部工具）", "full (every tool)")}</option>
              <option value="core">{t("core（精简常用）", "core (the common ones)")}</option>
            </select>
          </Field>
        </div>
      </Card>
    ) : null}

    <Card
      title={t("工具目录", "Tool catalog")}
      desc={
        <>
          {t("这份清单就是 ", "This list is exactly what ")}
          <span className="mono">tools/list</span>
          {t(" 实际返回的内容，按工具配置档过滤。", " returns, filtered by the tool profile.")}
        </>
      }
      actions={
        catalog ? (
          <div className="btn-group">
            <Chip tone="accent">{t("配置档", "Profile")} {catalog.profile}</Chip>
            <span className="section-note" style={{ margin: 0 }}>
              {t(
                `共 ${catalog.count} 个工具（核心 ${coreCount} 个）`,
                `${catalog.count} tools (${coreCount} core)`,
              )}
            </span>
          </div>
        ) : null
      }
    >
      {catalog === null ? (
        note
          ? <div className="section-note" role="alert">{note}</div>
          : <Skeleton lines={5} />
      ) : (
        <>
          <SearchToolbar
            query={query}
            onQuery={setQuery}
            placeholder={t("按名称或说明过滤…", "Filter by name or description…")}
            label={t("过滤工具", "Filter tools")}
            count={t(`显示 ${visible.length} 个`, `${visible.length} shown`)}
          >
            <span className="check-row">
              <input
                type="checkbox"
                className="switch"
                checked={onlyCore}
                onChange={event => setOnlyCore(event.target.checked)}
                aria-label={t("只看核心", "Core only")}
              />
              {t("只看核心", "Core only")}
            </span>
          </SearchToolbar>

          {visible.length === 0 ? (
            <EmptyState title={t("没有匹配的工具。", "No matching tools.")}>
              {t("换个关键词，或取消「只看核心」。", "Try another keyword, or clear the core-only filter.")}
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>{t("名称", "Name")}</th>
                    <th>{t("类型", "Kind")}</th>
                    <th>{t("说明", "Description")}</th>
                    <th className="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(tool => (
                    <tr key={tool.name}>
                      <td className="mono name">{tool.name}</td>
                      <td>{tool.core ? <Chip tone="ok">{t("核心", "Core")}</Chip> : <Chip>{t("扩展", "Extended")}</Chip>}</td>
                      <td className="muted">{tool.description || "—"}</td>
                      <td className="actions">
                        <span className="row-actions">
                          <CopyButton
                            value={tool.name}
                            label={t("复制名称", "Copy name")}
                            onCopied={() => notify?.(t(`已复制工具名 ${tool.name}`, `Copied tool name ${tool.name}`))}
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
      {note && catalog !== null && <div className="section-note" role="alert">{note}</div>}
    </Card>
    </>
  );
}
