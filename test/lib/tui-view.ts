import type { TuiStateView } from "../../src/console/tui/snapshot.js";

/**
 * The neutral TuiStateView skeleton behind the TUI unit suites: every field
 * buildSnapshot reads, filled with inert defaults (empty maps, no traffic).
 * Each suite spreads its own increments on top, so the data an assertion names
 * stays visible in the file that asserts it.
 */
export function tuiView(increments: Partial<TuiStateView> = {}): TuiStateView {
  return {
    port: 0,
    routeToken: "",
    tunnelUrl: "",
    tunnelRole: "none",
    stopping: false,
    sessions: new Map(),
    commands: new Map(),
    services: new Map(),
    activity: [],
    usage: { startedAt: 0, calls: 0, successes: 0, failures: 0 },
    runtimeUsage: { calls: 0, successes: 0, failures: 0 },
    todos: [],
    ...increments,
  };
}
