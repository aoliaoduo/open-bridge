import { useState } from "react";

export interface SectionLink {
  /** id of the section element on the page. */
  id: string;
  /** Short label — deliberately not identical to the card's own heading, so a
   *  text query for one never matches both. */
  label: string;
}

/**
 * Sticky section rail for a long settings page.
 *
 * 设置 grew to seven cards (隧道、网络、文件访问、Shell、并发、日志、OAuth) and the
 * only way to reach the last one was to scroll past the rest. The references
 * solve this two ways — a side sub-nav or a sticky secondary tab strip; the
 * strip needs no layout change here and survives narrow windows, where a side
 * rail would eat the content width.
 *
 * It tracks its own selection rather than the scroll position: a scroll spy
 * would need IntersectionObserver (absent under jsdom) and would fight the
 * smooth scroll it just started.
 */
export function SectionNav({ items }: { items: SectionLink[] }) {
  const [active, setActive] = useState(items[0]?.id ?? "");

  const go = (id: string): void => {
    setActive(id);
    // Optional call: jsdom has no scrollIntoView, and a click in a test must
    // still switch the active item instead of throwing.
    document.getElementById(id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  return (
    <nav className="secnav" aria-label="设置分区">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          className={`secnav-item${active === item.id ? " active" : ""}`}
          aria-current={active === item.id ? "true" : undefined}
          onClick={() => go(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
