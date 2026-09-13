import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "./App";
import type {
  BridgeStatus,
  HealthReport,
  LockSnapshot,
  SessionView,
  OAuthConsoleView,
  SettingsActionResult,
  SettingsState,
  ToolCatalog,
  UsageStats,
} from "./api";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  activity: vi.fn(),
  usage: vi.fn(),
  settings: vi.fn(),
  settingsAction: vi.fn(),
  bridgeRotate: vi.fn(),
  services: vi.fn(),
  serviceAction: vi.fn(),
  sessions: vi.fn(),
  closeSession: vi.fn(),
  tools: vi.fn(),
  health: vi.fn(),
  oauth: vi.fn(),
  copyText: vi.fn(async () => undefined),
  reloadConsole: vi.fn(),
}));

vi.mock("./api", () => ({
  api: {
    status: mocks.status,
    activity: mocks.activity,
    usage: mocks.usage,
    settings: mocks.settings,
    settingsAction: mocks.settingsAction,
    bridgeRotate: mocks.bridgeRotate,
    services: mocks.services,
    serviceAction: mocks.serviceAction,
    sessions: mocks.sessions,
    closeSession: mocks.closeSession,
    tools: mocks.tools,
    health: mocks.health,
    oauth: mocks.oauth,
  },
  copyText: mocks.copyText,
  reloadConsole: mocks.reloadConsole,
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
  // Each test starts on 状态: the open page comes from the URL now, so a test
  // that pushed a path would otherwise leak into the next one.
  window.history.pushState({}, "", "/console/status");
  mocks.status.mockResolvedValue(bridgeStatus());
  mocks.activity.mockResolvedValue([]);
  mocks.usage.mockResolvedValue(usageStats());
  mocks.settings.mockResolvedValue(settingsState());
  mocks.settingsAction.mockResolvedValue({ ok: true, state: settingsState() });
  mocks.services.mockResolvedValue([]);
  mocks.sessions.mockResolvedValue({ sessions: [sessionView()], locks: lockSnapshot() });
  mocks.closeSession.mockResolvedValue({ closed: "session-1", sessions: [] });
  mocks.tools.mockResolvedValue(toolCatalog());
  mocks.health.mockResolvedValue(healthReport());
  mocks.oauth.mockResolvedValue(oauthConsoleView());
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
    active_sessions: 1,
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
    version: "9.9.9-test",
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
      logMaxBytes: 10 * 1024 * 1024,
      "oauth.enabled": false,
      "oauth.allowedRedirectHosts": [],
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

function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "a1b2c3d4e5f60718",
    client: "cursor/0.42",
    connected_at: new Date("2026-09-11T00:00:00Z").toISOString(),
    calls: 47,
    last_used: new Date("2026-09-11T00:00:00Z").toISOString(),
    idle_ms: 12_000,
    active_requests: 0,
    todos: 2,
    ...overrides,
  };
}

function lockSnapshot(): LockSnapshot {
  return {
    held: [{ key: "C:\\work", mode: "write", label: "write_file", held_ms: 1_500 }],
    waiting: [{ keys: ["C:\\work"], mode: "write", label: "edit_file", waited_ms: 900 }],
  };
}

function oauthConsoleView(): OAuthConsoleView {
  return {
    enabled: true,
    issuer: "http://127.0.0.1:18080",
    clients: [{
      client_id: "ob-0123456789abcdef",
      client_name: "ChatGPT 连接器",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      client_id_issued_at: Date.parse("2026-09-11T00:00:00Z"),
    }],
    counts: { clients: 1, activeAccessTokens: 2, activeRefreshTokens: 1 },
    ownerSource: "route_token",
  };
}

function toolCatalog(): ToolCatalog {
  return {
    profile: "full",
    count: 2,
    tools: [
      { name: "read_files", description: "Read one or more files.", core: true },
      { name: "start_process", description: "Start a long-running process.", core: false },
    ],
  };
}

function healthReport(): HealthReport {
  return {
    exposure: "public-open",
    checks: [
      { name: "instance", level: "ok", ok: true, detail: "state=running" },
      { name: "workspace", level: "ok", ok: true, detail: "C:\\work" },
      { name: "tools", level: "ok", ok: true, detail: "54 个（full）" },
      { name: "tunnel", level: "ok", ok: true, detail: "未开启（仅本机可用）" },
      { name: "public", level: "ok", ok: true, detail: "HTTP 200（312 ms）" },
      { name: "exposure", level: "warn", ok: false, detail: "public-open" },
    ],
  };
}

const tabLink = (label: string): HTMLAnchorElement =>
  screen.getByRole("link", { name: label }) as HTMLAnchorElement;

describe("App shell", () => {
  test("renders every page link and opens on 状态", async () => {
    render(<App />);

    for (const label of ["状态", "会话", "工具", "体检", "服务", "日志", "统计", "令牌", "设置"]) {
      expect(tabLink(label)).toBeTruthy();
    }
    // Links carry the page path, so a page can be bookmarked or opened elsewhere.
    expect(tabLink("会话").getAttribute("href")).toBe("/console/sessions");
    // StatusTab owns the endpoint card, so its heading proves which page is open.
    expect(await screen.findByText("MCP 端点")).toBeTruthy();
  });

  test("switching pages swaps the panel and moves the URL", async () => {
    render(<App />);
    await screen.findByText("MCP 端点");

    fireEvent.click(tabLink("设置"));

    expect(await screen.findByText("隧道（ngrok）")).toBeTruthy();
    expect(screen.queryByText("MCP 端点")).toBeNull();
    expect(window.location.pathname).toBe("/console/settings");
    // 日志 card: the rotation cap is editable and shows the value the server sent.
    expect(await screen.findByText("单文件上限")).toBeTruthy();
    expect(await screen.findByDisplayValue("10485760")).toBeTruthy();
  });

  test("deep-links straight to a page from the URL", async () => {
    // The panel used to always start on 状态 no matter what the address bar
    // said; now the path decides.
    window.history.pushState({}, "", "/console/sessions");

    render(<App />);

    expect(await screen.findByText("已连接的客户端")).toBeTruthy();
    expect(await screen.findByText("cursor/0.42")).toBeTruthy();
    // 「首次连接」/「调用数」: the two columns the table was missing.
    expect(await screen.findByText("首次连接")).toBeTruthy();
    expect(await screen.findByText("调用数")).toBeTruthy();
    expect(await screen.findByText("47")).toBeTruthy();
  });

  test("falls back to 状态 for an unknown console path", async () => {
    window.history.pushState({}, "", "/console/nope");

    render(<App />);

    expect(await screen.findByText("MCP 端点")).toBeTruthy();
  });

  test("lists the locks that live sessions are holding", async () => {
    window.history.pushState({}, "", "/console/sessions");

    render(<App />);

    expect(await screen.findByText("文件锁")).toBeTruthy();
    expect(await screen.findByText("write_file")).toBeTruthy();
    expect(await screen.findByText("edit_file")).toBeTruthy();
  });

  test("disconnects one session from 会话", async () => {
    // "谁在连我" is only useful with a way to act on it.
    window.history.pushState({}, "", "/console/sessions");
    mocks.closeSession.mockResolvedValue({ closed: "a1b2c3d4e5f60718", sessions: [] });

    render(<App />);
    await screen.findByText("cursor/0.42");

    fireEvent.click(screen.getByRole("button", { name: "断开" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认？" }));

    expect(mocks.closeSession).toHaveBeenCalledWith("a1b2c3d4e5f60718");
    expect(await screen.findByText(/已断开 a1b2c3d4/)).toBeTruthy();
  });

  test("shows what the instance advertises on 工具", async () => {
    render(<App />);
    await screen.findByText("MCP 端点");

    fireEvent.click(tabLink("工具"));

    expect(await screen.findByText("工具目录")).toBeTruthy();
    expect(await screen.findByText("read_files")).toBeTruthy();
    expect(await screen.findByText("共 2 个工具（核心 1 个）")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("过滤工具"), { target: { value: "process" } });
    expect(screen.queryByText("read_files")).toBeNull();
    expect(screen.getByText("start_process")).toBeTruthy();
  });

  test("runs the checks on 体检 and reports them", async () => {
    render(<App />);
    await screen.findByText("MCP 端点");

    fireEvent.click(screen.getByRole("button", { name: "一键体检" }));

    expect(await screen.findByText("体检结果")).toBeTruthy();
    // public-open is 提醒, not 异常: the summary must say so instead of crying
    // wolf about a state the operator may have chosen.
    expect(await screen.findByText("无异常，1 项提醒。")).toBeTruthy();
    expect(screen.getByText("提醒")).toBeTruthy();
    expect(mocks.health).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("公网连通")).toBeTruthy();
  });

  test("arms the second lock from 体检 in one step", async () => {
    // The lock is the one action on this page that changes who can reach the
    // endpoint, so it is a two-step confirm and it must hand back the only copy
    // of the new token — into the mask, not just the toast.
    window.history.pushState({}, "", "/console/health");
    mocks.settingsAction.mockResolvedValue({
      ok: true,
      state: settingsState({ authEnabled: true, usableCount: 1 }),
      secret: { kind: "minted", id: "t9", label: "public-lock", secret: "ob_lock_value", ttl: "1 小时" },
      info: "第二道锁已开启",
    } satisfies SettingsActionResult);

    render(<App />);
    await screen.findByText("体检结果");

    fireEvent.click(screen.getByRole("button", { name: "开启第二道锁" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认？" }));

    expect(mocks.settingsAction).toHaveBeenCalledWith({ command: "armPublicLock" });
    expect(await screen.findByText("令牌已创建")).toBeTruthy();
    expect(screen.getByText("ob_lock_value")).toBeTruthy();
  });

  test("shows the console path of the open page", async () => {
    render(<App />);

    expect(await screen.findByText("/console/status")).toBeTruthy();
  });

  test("names the browser tab after the open page", async () => {
    render(<App />);
    await screen.findByText("MCP 端点");
    expect(document.title).toBe("状态 · Open Bridge 控制台");

    fireEvent.click(tabLink("体检"));

    await screen.findByText("体检结果");
    expect(document.title).toBe("体检 · Open Bridge 控制台");
  });

  test("surfaces a settings failure as a toast", async () => {
    mocks.settings.mockRejectedValue(new Error("GET /api/settings → HTTP 403"));

    render(<App />);

    expect(await screen.findByText("GET /api/settings → HTTP 403")).toBeTruthy();
  });

  test("reports the running state in the header badge", async () => {
    render(<App />);
    expect(await screen.findByText("已就绪")).toBeTruthy();
    // The header chip answers "which build is this page from?" — the string
    // the server took from package.json.
    expect(screen.getByText("v9.9.9-test")).toBeTruthy();
  });

  test("reloads the console after a rotation invalidates its injected token", async () => {
    // The token is injected into the page server-side, so after a rotation the
    // in-page copy is stale and every later action would 403. Reloading is the
    // only way to pick up the fresh one, and without it the console was left
    // silently broken until the operator thought to refresh by hand.
    // Patching window.location is not reliable across jsdom versions and vitest
    // pools, so the component funnels the reload through reloadConsole and the
    // mock stands in for it here.
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
    expect(mocks.reloadConsole).toHaveBeenCalledTimes(1);
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
    fireEvent.click(tabLink("令牌"));
    fireEvent.click(await screen.findByRole("button", { name: "新建令牌" }));

    fireEvent.click(await screen.findByRole("button", { name: "创建" }));

    expect(await screen.findByText("令牌已创建")).toBeTruthy();
    expect(screen.getByText("ob_secret_value")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "我已保存" }));

    expect(screen.queryByText("ob_secret_value")).toBeNull();
  });

  test("the secret mask is a dialog: it takes focus and Escape dismisses it", async () => {
    // The mask only closed on a click before: no role, no focus, and no keyboard
    // way out of a modal that is showing a credential that will never be shown
    // again.
    mocks.settingsAction.mockResolvedValue({
      ok: true,
      state: settingsState({ usableCount: 1 }),
      secret: { kind: "minted", id: "t2", label: "keyboard", secret: "ob_kbd_value", ttl: "永久" },
    } satisfies SettingsActionResult);

    render(<App />);
    await screen.findByText("MCP 端点");
    fireEvent.click(tabLink("令牌"));
    fireEvent.click(await screen.findByRole("button", { name: "新建令牌" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("ob_kbd_value")).toBeNull();
  });
});

test("the directory whitelist is a textarea: every line survives editing", async () => {
  // HTML value sanitization strips newlines from <input type="text">, so the
  // list silently collapsed into one bogus path the moment an operator edited
  // and blurred it. Two directories must come back as two.
  window.history.pushState({}, "", "/console/settings");
  mocks.settings.mockResolvedValue(settingsState({
    config: {
      ...settingsState().config,
      unrestrictedFileAccess: false,
      allowedDirectories: ["C:\\work\\one", "C:\\work\\two"],
    },
  }));

  const { container } = render(<App />);
  await screen.findByText("每行一个绝对目录；失焦时保存");
  const area = container.querySelector("textarea") as HTMLTextAreaElement;
  expect(area).toBeTruthy();
  expect(area.value).toBe("C:\\work\\one\nC:\\work\\two");

  const edited = "C:\\work\\one\nC:\\work\\three";
  area.focus();
  fireEvent.input(area, { target: { value: edited } });
  fireEvent.change(area, { target: { value: edited } });
  // The textarea is controlled: if React did not take the edit, the commit on
  // blur has nothing to send and this is where that should be reported.
  expect(area.value).toBe(edited);
  act(() => { area.blur(); });

  expect(mocks.settingsAction).toHaveBeenCalledWith({
    command: "setConfig",
    key: "allowedDirectories",
    value: ["C:\\work\\one", "C:\\work\\three"],
  });
});

test("a number outside the server's bounds is refused with a toast, not saved", async () => {
  // The field used to keep whatever was typed while the config held something
  // else — the operator only found out on the next reload.
  window.history.pushState({}, "", "/console/settings");
  const { container } = render(<App />);
  await screen.findByText("单文件上限");
  const inputs = [...container.querySelectorAll("input[type=number]")] as HTMLInputElement[];
  const health = inputs.find(input => input.value === "20000");
  expect(health).toBeTruthy();

  fireEvent.change(health!, { target: { value: "42" } });
  fireEvent.blur(health!);

  expect(mocks.settingsAction).not.toHaveBeenCalledWith(
    expect.objectContaining({ command: "setConfig", key: "publicHealthTimeoutMs" }),
  );
  expect(await screen.findByText(/公网健康检查 需要整数 3000–120000/)).toBeTruthy();
  expect((health as HTMLInputElement).value).toBe("20000");
});

test("settings can turn OAuth on, and the card shows who holds a credential", async () => {
  window.history.pushState({}, "", "/console/settings");
  mocks.settings.mockResolvedValue(settingsState({
    config: { ...settingsState().config, "oauth.enabled": true, "oauth.allowedRedirectHosts": ["chatgpt.com"] },
  }));

  render(<App />);

  // The client list is live data (/api/oauth): without it the operator could
  // switch OAuth on from the console and still see nothing at all.
  expect(await screen.findByText("ChatGPT 连接器")).toBeTruthy();
  expect(screen.getByText(/已注册客户端 1 个/)).toBeTruthy();

  // And the switch writes the same config key the CLI does. Before this card
  // there was no way to turn OAuth on from the console at all — README said
  // otherwise.
  const toggle = screen.getByLabelText("启用 OAuth 2.1 授权服务器") as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  expect(mocks.settingsAction).toHaveBeenCalledWith({ command: "setConfig", key: "oauth.enabled", value: false });
});

describe("App shell: grouped navigation", () => {
  afterEach(() => {
    // Collapse and theme are remembered per browser; a test that toggles them
    // must not decide the state of the next one.
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  test("groups the pages instead of listing nine flat tabs", async () => {
    render(<App />);
    await screen.findByText("MCP 端点");

    // Group headings, in order. Queried by class rather than by text: the
    // breadcrumb repeats the group the open page belongs to, so a text query
    // would match two elements and say nothing about the ordering.
    const groups = [...document.querySelectorAll(".nav-group-label")].map(node => node.textContent);
    expect(groups).toEqual(["实例", "运维", "配置"]);
    // The open page is marked for assistive tech, not only by its tint.
    expect(tabLink("状态").getAttribute("aria-current")).toBe("page");
    expect(tabLink("会话").getAttribute("aria-current")).toBeNull();
  });

  test("collapses to an icon rail and remembers the choice", async () => {
    render(<App />);
    await screen.findByText("MCP 端点");

    fireEvent.click(screen.getByRole("button", { name: "收起导航" }));

    expect(document.querySelector(".shell")?.className).toContain("nav-collapsed");
    // The labels stay in the DOM (visually clipped), so the links keep their
    // accessible names while the rail is narrow.
    expect(tabLink("会话")).toBeTruthy();
    expect(window.localStorage.getItem("openBridge.console.nav.collapsed")).toBe("1");

    fireEvent.click(screen.getByRole("button", { name: "展开导航" }));
    expect(document.querySelector(".shell")?.className).not.toContain("nav-collapsed");
    expect(window.localStorage.getItem("openBridge.console.nav.collapsed")).toBe("0");
  });

  test("cycles the colour theme and writes it on the document", async () => {
    render(<App />);
    await screen.findByText("MCP 端点");

    const themeButton = screen.getByRole("button", { name: /主题：/ });
    // jsdom ships no matchMedia, so 跟随系统 resolves to the light palette.
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(themeButton);
    expect(screen.getByRole("button", { name: "主题：浅色" })).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "主题：浅色" }));
    expect(screen.getByRole("button", { name: "主题：深色" })).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("openBridge.console.theme")).toBe("dark");

    fireEvent.click(screen.getByRole("button", { name: "主题：深色" }));
    expect(screen.getByRole("button", { name: "主题：跟随系统" })).toBeTruthy();
  });
});

describe("App shell: in-page filtering and rails", () => {
  test("filters the sessions table in place", async () => {
    // 会话 grew past the point where "which client is this" was answerable by
    // eye, so the table filters instead of making the operator scan.
    window.history.pushState({}, "", "/console/sessions");
    mocks.sessions.mockResolvedValue({
      sessions: [
        sessionView(),
        sessionView({ id: "ffffffffffffffff", client: "claude/1.0", calls: 2, idle_ms: 90_000 }),
      ],
      locks: lockSnapshot(),
    });

    render(<App />);
    expect(await screen.findByText("cursor/0.42")).toBeTruthy();
    expect(screen.getByText("claude/1.0")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("过滤会话"), { target: { value: "claude" } });

    expect(screen.queryByText("cursor/0.42")).toBeNull();
    expect(screen.getByText("claude/1.0")).toBeTruthy();
    expect(screen.getByText(/显示 1 \/ 共 2 个会话/)).toBeTruthy();
  });

  test("the 设置 rail marks the section it jumps to", async () => {
    window.history.pushState({}, "", "/console/settings");

    render(<App />);
    await screen.findByText("隧道（ngrok）");

    const item = screen.getByRole("button", { name: "日志轮转" });
    expect(item.getAttribute("aria-current")).toBeNull();

    fireEvent.click(item);

    expect(item.getAttribute("aria-current")).toBe("true");
    // The target exists: a rail entry that scrolls nowhere is worse than none.
    expect(document.getElementById("set-logs")).toBeTruthy();
    expect(document.getElementById("set-oauth")).toBeTruthy();
  });
});

describe("App shell: card detail layer", () => {
  test("explains each card in place instead of in a tooltip", async () => {
    render(<App />);

    // The sentence used to live in the tab's title attribute; a card header puts
    // it on screen.
    expect(await screen.findByText(/把这个 URL 填进 MCP 客户端/)).toBeTruthy();
    // Property rows: the reachability answer sits next to the URL it describes.
    expect(await screen.findByText("客户端可达")).toBeTruthy();
    expect(screen.getByText("仅本机")).toBeTruthy();
  });

  test("copies an identifier from the row it belongs to", async () => {
    window.history.pushState({}, "", "/console/sessions");

    render(<App />);
    const button = await screen.findByRole("button", { name: "复制会话 ID" });
    fireEvent.click(button);

    expect(mocks.copyText).toHaveBeenCalledWith("a1b2c3d4e5f60718");
    // The button confirms itself, so a toast is not the only evidence of which
    // row went to the clipboard.
    expect(await screen.findByRole("button", { name: "复制会话 ID（已复制）" })).toBeTruthy();
  });

  test("shows skeletons instead of a bare 读取中 while a page loads", async () => {
    mocks.tools.mockReturnValue(new Promise(() => undefined));
    window.history.pushState({}, "", "/console/tools");

    const { container } = render(<App />);
    await screen.findByText("工具目录");

    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  test("renders booleans as switches that are still checkboxes", async () => {
    window.history.pushState({}, "", "/console/settings");

    const { container } = render(<App />);
    await screen.findByText("隧道（ngrok）");

    const switches = [...container.querySelectorAll("input.switch")] as HTMLInputElement[];
    expect(switches.length).toBeGreaterThanOrEqual(3);
    expect(switches.every(input => input.type === "checkbox")).toBe(true);

    // And they still write the same config key they wrote as a plain checkbox.
    const autoReconnect = switches.find(input => input.checked);
    expect(autoReconnect).toBeTruthy();
    fireEvent.click(autoReconnect!);
    expect(mocks.settingsAction).toHaveBeenCalledWith({ command: "setConfig", key: "autoReconnect", value: false });
  });
});
