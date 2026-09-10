import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";
import type { BridgeStatus, SettingsActionResult, SettingsState, UsageStats } from "./api";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  activity: vi.fn(),
  usage: vi.fn(),
  settings: vi.fn(),
  settingsAction: vi.fn(),
  bridgeStart: vi.fn(),
  bridgeStop: vi.fn(),
  bridgeRotate: vi.fn(),
  copyText: vi.fn(async () => undefined),
}));

vi.mock("./api", () => ({
  api: {
    status: mocks.status,
    activity: mocks.activity,
    usage: mocks.usage,
    settings: mocks.settings,
    settingsAction: mocks.settingsAction,
    bridgeStart: mocks.bridgeStart,
    bridgeStop: mocks.bridgeStop,
    bridgeRotate: mocks.bridgeRotate,
  },
  copyText: mocks.copyText,
  consoleToken: () => "test-token",
}));

/** LogsTab opens an SSE stream; jsdom ships no EventSource. */
class FakeEventSource {
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close(): void { this.closed = true; }
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  mocks.status.mockResolvedValue(bridgeStatus());
  mocks.activity.mockResolvedValue([]);
  mocks.usage.mockResolvedValue(usageStats());
  mocks.settings.mockResolvedValue(settingsState());
  mocks.settingsAction.mockResolvedValue({ ok: true, state: settingsState() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const fn of Object.values(mocks)) {
    if (typeof fn === "function" && "mockReset" in fn) (fn as { mockReset: () => void }).mockReset();
  }
});

function bridgeStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    state: "running",
    local_url: "http://127.0.0.1:18080/mcp/tok",
    mcp_url: "http://127.0.0.1:18080/mcp/tok",
    shell: "bash",
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

function settingsState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    running: true,
    statusText: "已就绪",
    mcpUrl: "http://127.0.0.1:18080/mcp/tok",
    configuredDomain: "",
    authEnabled: false,
    defaultTtlSeconds: 0,
    usableCount: 0,
    deadCount: 0,
    tokens: [],
    concurrency: { enabled: true, holdTimeoutMs: 300_000, waitTimeoutMs: 120_000 },
    config: {
      autoStart: false,
      unrestrictedFileAccess: true,
      allowedDirectories: [],
      tunnelProvider: "none",
      ngrokExecutable: "ngrok",
      shellPath: "",
      shellArgs: [],
      port: 18080,
      publicHealthTimeoutMs: 20_000,
      autoReconnect: true,
      ngrokUseHttpProxy: true,
      toolProfile: "full",
    },
    ...overrides,
  };
}

function usageStats(): UsageStats {
  return {
    started_at: new Date("2026-09-11T00:00:00Z").toISOString(),
    uptime_ms: 65_000,
    calls: 4,
    successes: 4,
    failures: 0,
    by_tool: { read_files: 3 },
    tracked_commands: 0,
    active_commands: 0,
  };
}

const tabButton = (label: string): HTMLButtonElement =>
  screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("App shell", () => {
  test("renders every tab and opens on 状态", async () => {
    render(<App />);

    for (const label of ["状态", "设置", "令牌", "日志", "统计"]) {
      expect(tabButton(label)).toBeTruthy();
    }
    // StatusTab owns the endpoint card, so its heading proves which tab is open.
    expect(await screen.findByText("MCP 端点")).toBeTruthy();
  });

  test("switching tabs swaps the panel", async () => {
    render(<App />);
    await screen.findByText("MCP 端点");

    fireEvent.click(tabButton("设置"));

    expect(await screen.findByText("隧道（ngrok）")).toBeTruthy();
    expect(screen.queryByText("MCP 端点")).toBeNull();
  });

  test("surfaces a settings failure as a toast", async () => {
    mocks.settings.mockRejectedValue(new Error("GET /api/settings → HTTP 403"));

    render(<App />);

    expect(await screen.findByText("GET /api/settings → HTTP 403")).toBeTruthy();
  });

  test("reports the running state in the header badge", async () => {
    render(<App />);
    expect(await screen.findByText("已就绪")).toBeTruthy();
  });

  test("reloads the console after a rotation invalidates its injected token", async () => {
    // The token is injected into the page server-side, so after a rotation the
    // in-page copy is stale and every later action would 403. Reloading is the
    // only way to pick up the fresh one, and without it the console was left
    // silently broken until the operator thought to refresh by hand.
    const reload = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", { configurable: true, value: { reload } });
    try {
      mocks.settingsAction.mockResolvedValue({
        ok: true,
        state: settingsState(),
        info: "MCP URL 已更新，旧链接立即失效。控制台正在重新加载。",
        reloadRequired: true,
      } satisfies SettingsActionResult);

      render(<App />);
      await screen.findByText("MCP 端点");

      fireEvent.click(screen.getByRole("button", { name: "轮换端点" }));

      expect(await screen.findByText(/控制台正在重新加载/)).toBeTruthy();
      await new Promise(resolve => setTimeout(resolve, 1400));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(window, "location", original);
    }
  });

  test("shows the one-time secret mask and dismisses it", async () => {
    // The mint response carries the only copy of the secret, so the shell must
    // present it until the operator confirms they saved it.
    mocks.settingsAction.mockResolvedValue({
      ok: true,
      state: settingsState({ usableCount: 1 }),
      secret: { kind: "minted", id: "t1", label: "integration", secret: "ob_secret_value", ttl: "永久" },
    } satisfies SettingsActionResult);

    render(<App />);
    await screen.findByText("MCP 端点");
    fireEvent.click(tabButton("令牌"));
    fireEvent.click(await screen.findByRole("button", { name: "新建令牌" }));

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));

    expect(await screen.findByText("令牌已创建")).toBeTruthy();
    expect(screen.getByText("ob_secret_value")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "我已保存" }));

    expect(screen.queryByText("ob_secret_value")).toBeNull();
  });
});
