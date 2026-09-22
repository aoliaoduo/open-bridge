import type { RouteId } from "../routes";
import { t } from "../i18n";

/**
 * The「去安全页」button both the status and health pages put next to an
 * exposure warning. The sentence around it differs per page; the way out is
 * the same one.
 */
export function SecurityCta({ onOpen }: { onOpen?: (id: RouteId) => void }) {
  if (!onOpen) return null;
  return (
    <button type="button" className="small" onClick={() => onOpen("security")}>
      {t("去安全页", "Open Security")}
    </button>
  );
}
