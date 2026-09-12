import type { ReactNode } from "react";

/**
 * Page header: the page name, the one line that says what it is for, and the
 * page's own actions on the right.
 *
 * The hint text already existed — it was buried in the tab's `title` attribute,
 * which only a mouse hover could reach. Putting it under the heading means the
 * answer to "what am I looking at" is on screen, and the actions live next to
 * the thing they act on instead of in a global strip.
 */
export function PageHeader(
  { title, hint, actions }: { title: string; hint: string; actions?: ReactNode },
) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        <p className="page-hint">{hint}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}
