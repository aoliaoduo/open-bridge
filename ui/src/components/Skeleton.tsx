/**
 * Loading placeholders.
 *
 * "读取中…" told the operator nothing about what was coming; a few skeleton
 * bars of the right shape make the wait legible and stop the layout from
 * jumping when the data lands.
 */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className={`skeleton ${index === 0 ? "tall w60" : index % 2 ? "w80" : "w40"}`} />
      ))}
    </div>
  );
}
