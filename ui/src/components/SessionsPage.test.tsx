import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SessionsPage } from "./SessionsPage";
import type { SessionView } from "../api";

const { sessionsMock, closeSessionMock } = vi.hoisted(() => ({
  sessionsMock: vi.fn(),
  closeSessionMock: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { sessions: sessionsMock, closeSession: closeSessionMock },
}));

const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: "sess_abcdefgh",
  client: "cursor/0.42",
  connected_at: new Date().toISOString(),
  last_used: new Date().toISOString(),
  idle_ms: 0,
  active_requests: 0,
  calls: 2,
  todos: 0,
  ...over,
} as SessionView);

afterEach(() => {
  cleanup();
  sessionsMock.mockReset();
  closeSessionMock.mockReset();
  vi.useRealTimers();
});

describe("SessionsPage", () => {
  test("a recovered poll clears the error note", async () => {
    // One transient failure used to pin the error banner to the page forever:
    // the success branch updated the table but never cleared the note, so a
    // single 503 during a Bridge restart outlived the recovery that fixed it.
    sessionsMock
      .mockRejectedValueOnce(new Error("GET /api/sessions failed"))
      .mockResolvedValue({ sessions: [session()] });

    vi.useFakeTimers();
    render(<SessionsPage />);

    // Mount poll (not timer-driven): flush microtasks, the failure shows the note.
    await act(async () => {});
    expect(screen.getByText(/\/api\/sessions/i)).toBeTruthy();

    // The next poll succeeds: the table refreshes AND the note goes away.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText("cursor/0.42")).toBeTruthy();
    expect(screen.queryByText(/\/api\/sessions/i)).toBeNull();
  });
});
