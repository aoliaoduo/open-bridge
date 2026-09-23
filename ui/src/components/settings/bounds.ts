import { t } from "../../i18n";

/** Bounds mirror the server's CONFIG_SPEC (src/bridge/config/settings-model.ts) so a
 *  value the UI accepts never comes back as an inscrutable 400. */
export const NUMBER_BOUNDS = {
  port: { min: 0, max: 65_535, label: () => t("本地端口", "Local port") },
  publicHealthTimeoutMs: { min: 3_000, max: 120_000, label: () => t("公网健康检查", "Public health check") },
  holdTimeoutMs: { min: 0, max: 3_600_000, label: () => t("占用上限", "Hold ceiling") },
  waitTimeoutMs: { min: 0, max: 3_600_000, label: () => t("等待上限", "Wait ceiling") },
} as const;

/**
 * Rejection feedback for a DraftField; the revert is DraftField's own job.
 * The two numeric sections (network, locks) share it so the toast wording
 * stays one sentence everywhere.
 */
export function invalidBounds(notify?: (text: string, isError?: boolean) => void):
  (key: keyof typeof NUMBER_BOUNDS) => () => void {
  return key => () => {
    const { label, min, max } = NUMBER_BOUNDS[key];
    notify?.(t(
      `${label()} 需要整数 ${min}–${max}，已还原为保存的值。`,
      `${label()} must be an integer between ${min} and ${max}; reverted to the saved value.`,
    ), true);
  };
}
