import type { ReactNode } from "react";

/**
 * KPI card: label, one big number, and the line that stops the number from
 * being ambiguous (单位、上限、配置档…).
 *
 * Borrowed outright from the reference dashboards: an operator glancing at the
 * console answers "is anything wrong?" from four large numbers, and only then
 * reads the tables. The old 实时状态 list showed the same values at 13px among
 * eight other rows.
 */
export function Stat(
  { label, value, hint, tone = "plain" }: {
    label: string;
    value: ReactNode;
    hint?: ReactNode;
    tone?: "plain" | "ok" | "warn" | "err" | "accent";
  },
) {
  return (
    <div className={`stat ${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-hint">{hint ?? "\u00a0"}</div>
    </div>
  );
}
