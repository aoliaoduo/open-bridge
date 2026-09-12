import type { ReactNode } from "react";

/**
 * Empty state: a sentence that says what the page would show, plus how to make
 * it show something.
 *
 * Empty pages used to be a single grey line of the same size and weight as the
 * table captions around them, so "nothing is wrong" and "nothing has happened
 * yet" looked identical — and neither told the operator what to do next.
 */
export function EmptyState(
  { title, children, action }: { title: string; children?: ReactNode; action?: ReactNode },
) {
  return (
    <div className="empty">
      <svg className="empty-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7.5 12 4l8 3.5v9L12 20l-8-3.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M4 7.5 12 11l8-3.5M12 11v9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <div className="empty-title">{title}</div>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}
