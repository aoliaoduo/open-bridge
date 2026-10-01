/**
 * Compatibility facade for the historical bridge/state import surface.
 *
 * New code should import the smallest owning module directly:
 * runtime-state, activity, endpoint, or mcp-result. Keeping this facade while
 * callers migrate makes the refactor behavior-preserving and prevents a large
 * import-only churn from obscuring functional changes.
 */
export * from "./activity-model.js";
export * from "./runtime-state.js";
export * from "./endpoint.js";
export * from "./activity.js";
export * from "./mcp-result.js";
