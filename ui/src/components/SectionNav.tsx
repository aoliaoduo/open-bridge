import { t } from "../i18n";

export interface SectionLink<T extends string = string> {
  /** id of the section element on the page. */
  id: T;
  /** Short label — deliberately not identical to the card's own heading, so a
   *  text query for one never matches both. */
  label: string;
}

/**
 * Sticky strip for switching between a page's sections.
 *
 * 设置's cards are real sub-pages now (each at its own path), so this strip is
 * a fully controlled tab bar: the parent owns which section is open and what a
 * click does (App pushes a history entry), and the strip renders whatever is
 * active. The old self-contained anchor-scroll version is gone — with real
 * sub-pages, scrolling within one long page would fight the address bar.
 *
 * Generic over the section id: the caller keeps its literal union end to end
 * (an item id flows back into onSelect typed, no string casts at the call site).
 */
export function SectionNav<T extends string>({ items, active, onSelect }: {
  items: SectionLink<T>[];
  /** The currently open section; the strip never tracks scroll or clicks itself. */
  active: T;
  /** Click handler — a route change for settings, or anything the page needs. */
  onSelect: (id: T) => void;
}) {
  return (
    <nav className="secnav" aria-label={t("设置分区", "Settings sections")}>
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          className={`secnav-item${active === item.id ? " active" : ""}`}
          aria-current={active === item.id ? "true" : undefined}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
