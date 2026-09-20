import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StatsTab } from "./StatsTab";

/**
 * The activity buffer carries the ISO-8601 UTC instant — the same value the
 * audit log and `activity_log{action:"recent"}` report. The console is a
 * display surface: it shows local wall-clock time and must never print the raw
 * instant at the operator. (Formatting server-side inside record() is what
 * corrupted the machine contract in the first place.)
 */
const { usageMock, activityMock } = vi.hoisted(() => ({
  usageMock: vi.fn(async () => ({
    calls: 1,
    successes: 1,
    failures: 0,
    by_tool: {},
    active_commands: 0,
    tracked_commands: 0,
    started_at: "2026-09-20T10:00:00.000Z",
    uptime_ms: 65000,
  })),
  activityMock: vi.fn(async () => [
    { at: "2026-09-20T10:00:05.123Z", status: "completed", tool: "list_directory", message: "ok" },
  ]),
}));

vi.mock("../api", () => ({
  api: { usage: usageMock, activity: activityMock, settingsAction: vi.fn(async () => ({})) },
}));

afterEach(() => {
  cleanup();
  usageMock.mockClear();
  activityMock.mockClear();
});

describe("StatsTab activity time", () => {
  test("renders an ISO timestamp as local wall-clock time, not raw", async () => {
    render(<StatsTab />);
    const expected = new Date("2026-09-20T10:00:05.123Z").toLocaleTimeString();
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByText("2026-09-20T10:00:05.123Z")).toBeNull();
  });
});
