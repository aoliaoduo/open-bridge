import type { ReactNode } from "react";

export interface PropItem {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

/**
 * Property rows: muted label on the left, value on the right, hairline between.
 *
 * Replaces the old label/value rows whose label column was 120px wide and whose
 * values sat in the same weight and size as everything else — a settings or
 * status card read as a wall of text instead of a list of facts. The hairlines
 * (rather than a box per row) are what lets a card hold eight facts without
 * eight borders.
 */
export function Props({ items }: { items: PropItem[] }) {
  return (
    <div className="props">
      {items.map(item => (
        <div className="prop" key={item.label}>
          <span className="prop-label">{item.label}</span>
          <span className={`prop-value${item.mono ? " mono" : ""}`}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}
