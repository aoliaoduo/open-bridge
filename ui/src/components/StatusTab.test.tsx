import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StatusTab } from "./StatusTab";
import type { BridgeStatus } from "../api";

const { statusMock, copyTextMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  copyTextMock: vi.fn(async () => undefined),
}));

vi.mock("../api", () => ({
  api: { status: statusMock },
  copyText: copyTextMock,
}));

afterEach(() => {
  cleanup();
  statusMock.mockReset();
  copyTextMock.mockClear();
});

function bridgeStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    state: "running",
    local_url: "http://127.0.0.1:18080/mcp/local-token",
    shell: "C:/Program Files/Git/bin/bash.exe",
    allowed_directories: [],
    active_sessions: 0,
    active_commands: 0,
    tool_profile: "full",
    tool_count: 54,
    auth_enabled: false,
    locks: { held: 0, waiting: 0 },
    ...overrides,
  };
}

function renderTab() {
  const act = vi.fn(async () => null);
  render(<StatusTab act={act} onRefresh={async () => undefined} />);
  return { act };
}

const button = (label: string): HTMLButtonElement =>
  screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("StatusTab endpoint card", () => {
  test("shows the resolved mcp_url from the server", async () => {
    statusMock.mockResolvedValue(bridgeStatus({
      mcp_url: "https://example.ngrok-free.dev/mcp/live",
      public_url: "https://example.ngrok-free.dev/mcp/live",
    }));

    renderTab();

    expect(await screen.findByText("https://example.ngrok-free.dev/mcp/live")).toBeTruthy();
  });

  test("falls back to local_url when the server sends no mcp_url", async () => {
    // Guards the contract for an older Bridge that predates mcp_url.
    statusMock.mockResolvedValue(bridgeStatus());

    renderTab();

    expect(await screen.findByText("http://127.0.0.1:18080/mcp/local-token")).toBeTruthy();
  });

  test("marks a tunnel URL as public", async () => {
    statusMock.mockResolvedValue(bridgeStatus({
      mcp_url: "https://example.ngrok-free.dev/mcp/live",
      public_url: "https://example.ngrok-free.dev/mcp/live",
    }));

    renderTab();

    expect(await screen.findByText(/公网隧道地址/)).toBeTruthy();
  });

  test("marks a loopback URL as local-only", async () => {
    // public_url is absent while no tunnel is published, so the note must not
    // claim the address is reachable from outside this machine.
    statusMock.mockResolvedValue(bridgeStatus());

    renderTab();

    expect(await screen.findByText(/仅本机可访问/)).toBeTruthy();
  });

  test("disables both copy actions while stopped", async () => {
    statusMock.mockResolvedValue(bridgeStatus({
      state: "stopped",
      local_url: undefined,
      mcp_url: undefined,
    }));

    renderTab();

    expect(await screen.findByText("（未运行）")).toBeTruthy();
    expect(button("复制 URL").disabled).toBe(true);
    expect(button("复制接入提示词").disabled).toBe(true);
  });

  test("offers the onboarding prompt once the Bridge is running", async () => {
    statusMock.mockResolvedValue(bridgeStatus());

    const { act } = renderTab();

    const promptButton = await screen.findByRole("button", { name: "复制接入提示词" });
    expect((promptButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(promptButton);

    // The console delegates the copy to the shared settings action.
    expect(act).toHaveBeenCalledWith({ command: "copyPrompt" });
  });
});
