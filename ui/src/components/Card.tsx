import type { ReactNode } from "react";
import { CardHead } from "./CardHead";

/**
 * Card: the .card frame + optional header in one shot.
 *
 * The 9 pages all used to spell `<div className="card"><CardHead .../>{...}</div>`
 * by hand; consolidating here keeps the spacing token (card padding, header
 * bottom margin) in one place and lets the page focus on the body content.
 */
export function Card({ id, title, desc, actions, children }: {
  /** Optional anchor target; used by 设置页's section rail. */
  id?: string;
  title: string;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card" id={id}>
      <CardHead title={title} desc={desc} actions={actions} />
      {children}
    </div>
  );
}
