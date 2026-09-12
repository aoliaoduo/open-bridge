import type { ReactNode } from "react";

/**
 * Status chip — a dot plus a word plus a tinted background.
 *
 * The console had three unrelated ways of saying "state": `.badge.on/.off` for
 * the header and services, `.pill.ok/.dead/.warn` for tables, and bare coloured
 * text for activity rows. One component with a tone union means a new state
 * cannot invent a fourth look (and the dot carries the meaning even when the
 * label is a single word).
 */
export type Tone = "ok" | "warn" | "err" | "accent" | "idle";

export function Chip(
  { tone = "idle", children, title }: { tone?: Tone; children: ReactNode; title?: string },
) {
  return (
    <span className={`chip ${tone}`} title={title}>
      <span className="chip-dot" aria-hidden="true" />
      <span className="chip-text">{children}</span>
    </span>
  );
}
