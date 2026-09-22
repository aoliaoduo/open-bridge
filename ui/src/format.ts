/**
 * Tiny presentation helpers shared by more than one page. Kept pure and
 * dependency-free so any component can import them without dragging in
 * runtime state.
 */
import { t } from "./i18n";

/** One error display, agreed on everywhere: prefer the Error's message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "空闲 2 分 13 秒" and friends — idleness is the whole point of the session table. */
// Formerly exported by SessionsPage for the 文件锁明细 card on the status page;
// both tables import this one formatter from here now.
export function idleLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 5) return t("刚刚", "just now");
  if (seconds < 60) return t(`${seconds} 秒`, `${seconds}s`);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t(`${minutes} 分 ${seconds % 60} 秒`, `${minutes}m ${seconds % 60}s`);
  const hours = Math.floor(minutes / 60);
  return t(`${hours} 小时 ${minutes % 60} 分`, `${hours}h ${minutes % 60}m`);
}
