import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CardHead } from "./CardHead";

/**
 * Card: the .card frame + optional header in one shot.
 *
 * The 9 pages all used to spell `<div className="card"><CardHead .../>{...}</div>`
 * by hand; consolidating here keeps the spacing token (card padding, header
 * bottom margin) in one place and lets the page focus on the body content.
 *
 * `collapsibleId` opts a card into being foldable. It is opt-in rather than
 * automatic because folding only earns its keep where a card is long and
 * visited rarely — 通知 grew three cards deep and most visits change one
 * switch. A card you read top to bottom every time is worse behind a click.
 */
export function Card({ id, title, desc, actions, children, collapsibleId, summary }: {
  /** Optional anchor target; used by 设置页's section rail. */
  id?: string;
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /**
   * Stable key for remembering the open/closed state. Passing it is what
   * makes the card foldable at all.
   */
  collapsibleId?: string;
  /**
   * One line shown while collapsed. Must answer "do I need to open this?" —
   * a summary that only repeats the title turns the fold into pure cost.
   */
  summary?: ReactNode;
}) {
  const storageKey = collapsibleId ? `openBridge.console.card.${collapsibleId}` : "";
  // Default open. A first-time operator should see everything; folding is a
  // convenience earned after they know the page, and the state persists from
  // the first time they use it.
  const [open, setOpen] = useState<boolean>(() => {
    if (!storageKey) return true;
    try {
      return window.localStorage.getItem(storageKey) !== "0";
    } catch {
      // Private mode, disabled storage: fall back to open rather than hiding
      // controls someone cannot then unhide.
      return true;
    }
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, open ? "1" : "0");
    } catch { /* not remembering is survivable; failing to render is not */ }
  }, [storageKey, open]);

  const toggle = useCallback(() => setOpen(value => !value), []);

  if (!collapsibleId) {
    const headActions = summary
      ? <>{actions}<span className="card-summary-badge">{summary}</span></>
      : actions;
    return (
      <div className="card" id={id}>
        <CardHead title={title} desc={desc} actions={headActions} />
        {children}
      </div>
    );
  }

  return (
    <div className={`card card-foldable${open ? "" : " collapsed"}`} id={id}>
      {/* The whole header is the hit area: a fold target the size of a chevron
          is a target people miss. The button wraps only the title row, so
          `actions` stay independently clickable. */}
      <button type="button" className="card-fold" onClick={toggle} aria-expanded={open}>
        <svg className="fold-caret" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="card-fold-text">
          <span className="card-fold-title">{title}</span>
          {!open && summary ? <span className="card-fold-summary">{summary}</span> : null}
        </span>
      </button>
      {open ? (
        <>
          {desc ? <p className="card-desc">{desc}</p> : null}
          {actions ? <div className="card-head-actions">{actions}</div> : null}
          {summary ? <div className="card-head-actions"><span className="card-summary-badge">{summary}</span></div> : null}
          {children}
        </>
      ) : null}
    </div>
  );
}
