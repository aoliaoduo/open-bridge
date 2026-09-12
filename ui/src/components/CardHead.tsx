import type { ReactNode } from "react";

/**
 * Card header: title, the sentence that explains the card, and its actions on
 * the right.
 *
 * The old cards put the title in a full-width grey line and then dropped the
 * buttons into a separate row below it, so every card spent two rows saying
 * "here is what this is" and "here is what you can do with it" before showing
 * anything. One header row does both, which is what the reference dashboards
 * do with their card headers — and it is why their cards feel denser without
 * being smaller.
 */
export function CardHead(
  { title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode },
) {
  return (
    <div className="card-head">
      <div className="card-head-text">
        <h2>{title}</h2>
        {desc ? <p className="card-desc">{desc}</p> : null}
      </div>
      {actions ? <div className="card-head-actions">{actions}</div> : null}
    </div>
  );
}
