import { useEffect, useMemo, useState } from "react";
import { api, type SkillCatalog } from "../api";
import { t } from "../i18n";
import { Card } from "./Card";
import { Chip } from "./Chip";
import { CopyButton } from "./CopyButton";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";

/**
 * 技能 — what `list_skills` discovers for this instance.
 *
 * The skill library was tool-only: an operator configuring a skill had to ask
 * the AI (or run the tool) to learn whether their SKILL.md was even seen. This
 * page renders exactly what list_skills re-reads from disk on every call —
 * same source, so the page cannot drift from what a client actually gets.
 * Reading a skill's contents stays a read_files call; the page is a catalog,
 * deliberately contents-free like the tool result.
 */
export function SkillsPage({ notify }: {
  notify?: (text: string, isError?: boolean) => void;
} = {}) {
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [note, setNote] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    void api.skills()
      .then(value => { if (alive) { setCatalog(value); setNote(""); } })
      .catch(error => { if (alive) setNote(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.skills ?? []).filter(skill =>
      !needle
      || skill.name.toLowerCase().includes(needle)
      || skill.description.toLowerCase().includes(needle));
  }, [catalog, query]);

  return (
    <Card
      title={t("技能库", "Skill library")}
      desc={t(
        "每次调用都从磁盘重新扫描：工作区 skills/、.agents/skills/、.claude/skills/、数据目录与 ~/.agents/skills/。",
        "Re-scanned from disk on every call: the workspace skills/, .agents/skills/ and .claude/skills/ folders, the data directory, and ~/.agents/skills/.",
      )}
      actions={
        catalog ? (
          <div className="btn-group">
            <Chip tone="accent">{t(`共 ${catalog.count} 个技能`, `${catalog.count} skills`)}</Chip>
            <span className="section-note" style={{ margin: 0 }}>
              {t("与 list_skills 工具同源", "Same source as the list_skills tool")}
            </span>
          </div>
        ) : null
      }
    >
      {catalog === null ? (
        note
          ? <div className="section-note" role="alert">{note}</div>
          : <Skeleton lines={4} />
      ) : (
        <>
          {catalog.skills.length > 0 && (
            <div className="toolbar">
              <label className="search">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.7" />
                  <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
                <input
                  type="text"
                  placeholder={t("按名称或说明过滤…", "Filter by name or description…")}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  aria-label={t("过滤技能", "Filter skills")}
                />
              </label>
              <span className="grow" />
              <span className="count">{t(`显示 ${visible.length} 个`, `${visible.length} shown`)}</span>
            </div>
          )}

          {visible.length === 0 ? (
            catalog.skills.length === 0 ? (
              <EmptyState title={t("还没有发现任何技能。", "No skills discovered yet.")}>
                {t(
                  "在上述任一目录放一个含 SKILL.md 的文件夹（目录里写 name 与 description），刷新即见。",
                  "Put a folder containing a SKILL.md (with name and description) into one of the scanned directories and it shows up on refresh.",
                )}
              </EmptyState>
            ) : (
              <EmptyState title={t("没有匹配的技能。", "No matching skills.")}>
                {t("换个关键词再试。", "Try another keyword.")}
              </EmptyState>
            )
          ) : (
            <div className="table-wrap">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>{t("名称", "Name")}</th>
                    <th>{t("说明", "Description")}</th>
                    <th>{t("来源", "Source")}</th>
                    <th className="actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(skill => (
                    <tr key={skill.path}>
                      <td className="mono name">{skill.name}</td>
                      <td className="muted">{skill.description || "—"}</td>
                      <td>
                        <span className="row-actions">
                          <span className="mono section-note" style={{ margin: 0 }}>{skill.dir}</span>
                          {skill.outside_workspace && <Chip>{t("工作区外", "Outside workspace")}</Chip>}
                        </span>
                      </td>
                      <td className="actions">
                        <span className="row-actions">
                          <CopyButton
                            value={skill.path}
                            label={t("复制路径", "Copy path")}
                            onCopied={() => notify?.(t(`已复制路径 ${skill.path}`, `Copied path ${skill.path}`))}
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
  );
}
