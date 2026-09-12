import type { ReactNode } from "react";

/**
 * Form field: label above the control, hint below it.
 *
 * 设置 was built from `label / control` rows — label in a 120px column, control
 * floating to its right — which is compact when every control is one line and
 * unreadable when the hint text has to go somewhere. Stacking is what the
 * reference forms do, and it gives long Chinese hints a place to live.
 *
 * `generatedId()` is not needed: callers pass the label text and the control is
 * wrapped in a <label>, so clicking the label focuses the control without an
 * id/htmlFor pair to keep in sync.
 */
export function Field(
  { label, hint, children, span }: { label: ReactNode; hint?: ReactNode; children: ReactNode; span?: boolean },
) {
  return (
    <label className={`field${span ? " span2" : ""}`}>
      <span className="field-label">{label}</span>
      <span className="field-control">{children}</span>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}
