/** Shared audit status vocabulary; no bridge state or host dependencies. */
export const ACTIVITY_STATUSES = ["running", "completed", "error", "progress", "warning"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/** Callers retain their own fallback for unrecognised legacy values. */
export function isActivityStatus(value: unknown): value is ActivityStatus {
  return ACTIVITY_STATUSES.some(status => status === value);
}
