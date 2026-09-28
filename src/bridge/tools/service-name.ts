/** Canonical service name used by storage, per-service queues and lock keys. */
export function normalizeServiceName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Group matching is trim-normalized but remains case-sensitive. */
export function normalizeServiceGroup(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Resource locks deliberately over-serialize service-name case variants. */
export function serviceLockName(value: unknown): string {
  return normalizeServiceName(value).toLowerCase();
}
