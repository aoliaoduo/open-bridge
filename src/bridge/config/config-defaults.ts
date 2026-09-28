/**
 * Backward-compatible import home for canonical configuration defaults.
 *
 * The actual catalog now lives in config-spec.ts so defaults, key enumeration
 * and MCP schema cannot drift independently.
 */
export { CONFIG_DEFAULTS } from "./config-spec.js";
