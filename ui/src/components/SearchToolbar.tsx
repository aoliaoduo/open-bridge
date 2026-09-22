import type { ReactNode } from "react";

/**
 * The filter bar the catalog pages share: magnifier + text input on the left,
 * the match count on the right. Whatever a page adds in between (the tools
 * page's core-only switch) comes through `children`.
 */
export function SearchToolbar({ query, onQuery, placeholder, label, count, children }: {
  query: string;
  onQuery: (next: string) => void;
  /** Shown while the input is empty. */
  placeholder: string;
  /** The input's accessible name. */
  label: string;
  /** The right-aligned "显示 …" readout. */
  count: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="toolbar">
      <label className="search">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="1.7" />
          <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={event => onQuery(event.target.value)}
          aria-label={label}
        />
      </label>
      {children}
      <span className="grow" />
      <span className="count">{count}</span>
    </div>
  );
}

/** Needle filter shared by the search-backed lists: an empty needle passes all. */
export function matchesNeedle(needle: string, ...fields: string[]): boolean {
  if (!needle) return true;
  return fields.some(field => field.toLowerCase().includes(needle));
}
