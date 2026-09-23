import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App";
import { applyLang } from "./i18n";
import type {
  BridgeStatus,
  HealthReport,
  LockSnapshot,
  SessionView,
  OAuthConsoleView,
  SettingsActionResult,
  SettingsState,
  SettingsTunnelView,
  ToolCatalog,
  UsageStats,
} from "./api";
// Straight from the shared declaration, not restated here: the fixtures below
// run the SAME planner the server executes, which is also how this file proves
// the module bundles for the browser at all.
import { planTunnelAutoConfig, type TunnelFacts } from "../../src/bridge/tunnel/tunnel-plan.js";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  activity: vi.fn(),
  usage: vi.fn(),
  settings: vi.fn(),
  settingsAction: vi.fn(),
  tunnel: vi.fn(),
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
    tunnel: mocks.tunnel,
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
  mocks.tunnel.mockResolvedValue(tunnelView());
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
    ngrokAuthtokenMask: "",
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
  tailscaleDomain: "",
  tailscaleExecutable: "",
      port: 18080,
      publicHealthTimeoutMs: 20_000,
      autoReconnect: true,
      ngrokUseHttpProxy: true,
      toolProfile: "full",
      logMaxBytes: 10 * 1024 * 1024,
      "oauth.enabled": false,
      "oauth.allowedRedirectHosts": [],
    "sound.enabled": false,
    "sound.fileWaiting": "",
    "sound.fileFinished": "",
    },
    detected: {
      shells: [
        { value: "C:\\Program Files\\Git\\bin\\bash.exe", label: "Git Bash", available: true },
        { value: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", label: "PowerShell 7", available: true },
      ],
      ngrok: [{ value: "C:\\tools\\ngrok.exe", label: "PATH", available: true }],
    },
    notify: {
      enabled: true,

      configured: false,
      keyMask: "",
      serverUrl: "https://api.day.app",
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
      // Server stores this in SECONDS (RFC 7591). A milliseconds fixture would
      // silently mask the seconds-vs-milliseconds rendering bug.
      client_id_issued_at: Math.floor(Date.parse("2026-09-11T00:00:00Z") / 1000),
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

/**
 * Detection fixtures. The provider is what the card describes, so the same
 * facts are reused for both halves of every test.
 */
function tunnelFactsFixture(): TunnelFacts {
  return {
    ngrok: {
      installed: true,
      executable: "C:\\tools\\ngrok.exe",
      executableLabel: "PATH",
      authtokenSource: "ngrok-config",
      domains: ["demo.ngrok-free.app"],
      domainsError: null,
    },
    tailscale: {
      installed: true,
      executable: "C:\\Program Files\\Tailscale\\tailscale.exe",
      executableLabel: "默认安装目录",
      loggedIn: true,
      domain: "demo.tail9999.ts.net",
      online: true,
      mountPort: null,
      mountPublic: false,
    },
  };
}

/** /api/tunnel: the facts plus the plan the button would run for that provider. */
function tunnelView(provider = "ngrok", facts: TunnelFacts = tunnelFactsFixture()): SettingsTunnelView {
  return {
    facts,
    plan: planTunnelAutoConfig({
      provider,
      current: { ngrokExecutable: "", ngrokDomain: "", tailscaleExecutable: "" },
      authtokenStored: false,
      facts,
    }),
  };
}

/** Settings pinned to one tunnel provider — the card only renders that one. */
function withProvider(provider: string): SettingsState {
  return settingsState({ config: { ...settingsState().config, tunnelProvider: provider } });
}

const tabLink = (label: string): HTMLAnchorElement =>
  screen.getByRole("link", { name: label }) as HTMLAnchorElement;

describe("App shell", () => {
  test("renders every page link and opens on 状态", async () => {
    render(<App />);

    for (const label of ["状态", "会话", "工具", "体检", "服务", "日志", "统计", "安全", "设置"]) {
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

    // The rail button and the card heading are both "隧道" -- same as Shell,
    // and correct now that the heading no longer names one provider. Assert
    // on the card's own text instead of a title that legitimately appears
    // twice.
    expect(await screen.findByText(/隧道让公网上的客户端连到这台机器/)).toBeTruthy();
    expect(screen.queryByText("MCP 端点")).toBeNull();
    expect(window.location.pathname).toBe("/console/settings");
    // Settings sub-pages are real paths now: clicking the rail swaps the card
    // AND the URL, so the 并发 card is directly linkable and reloadable.
    fireEvent.click(screen.getByRole("button", { name: "并发" }));
    expect(await screen.findByText("占用上限")).toBeTruthy();
    expect(window.location.pathname).toBe("/console/settings/locks");
  });

  test("deep-links straight to a page from the URL", async () => {
    // The panel used to always start on 状态 no matter what the address bar
    // said; now the path decides.
    window.history.pushState({}, "", "/console/sessions");

    render(<App />);

    expect(await screen.findByText("客户端与活动")).toBeTruthy();
    expect(await screen.findByText("cursor/0.42")).toBeTruthy();
    // 「首次连接」/「调用数」: the two columns the table was missing.
    expect(await screen.findByText("连接 / 首次观察")).toBeTruthy();
    expect(await screen.findByText("调用数")).toBeTruthy();
    expect(await screen.findByText("47")).toBeTruthy();
  });

  test("falls back to 状态 for an unknown console path", async () => {
    window.history.pushState({}, "", "/console/nope");

    render(<App />);

    expect(await screen.findByText("MCP 端点")).toBeTruthy();
  });

  test("lists the locks that live sessions are holding", async () => {
    window.history.pushState({}, "", "/console/status");

    render(<App />);

    expect(await screen.findByText("文件锁明细")).toBeTruthy();
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

    // The topbar shortcut is gone; 体检 is reached from the nav like any other
    // page, and the page runs its own checks on open.
    fireEvent.click(screen.getByRole("link", { name: "体检" }));

    expect(await screen.findByText("体检结果")).toBeTruthy();
    // public-open is 提醒, not 异常: the summary must say so instead of crying
    // wolf about a state the operator may have chosen.
    expect(await screen.findByText("无异常，1 项提醒。")).toBeTruthy();
    expect(screen.getByText("提醒")).toBeTruthy();
    expect(mocks.health).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("公网连通")).toBeTruthy();

    // The exposure card moved to 安全; 体检 keeps only a pointer to it.
    fireEvent.click(await screen.findByRole("button", { name: "去安全页" }));
    expect(window.location.pathname).toBe("/console/security");
  });

  test("arms the gate from 安全 in one step", async () => {
    // The gate is the one action on the 安全 page that changes who can reach
    // the endpoint, so it is a two-step confirm and it must hand back the only
    // copy of the new token — into the mask, not just the toast.
    window.history.pushState({}, "", "/console/security");
    mocks.settingsAction.mockResolvedValue({
      ok: true,
      state: settingsState({ authEnabled: true, usableCount: 1 }),
      secret: { kind: "minted", id: "t9", label: "public-lock", secret: "ob_lock_value", ttl: "1 小时" },
      info: "Bearer 门禁已启用：已签发 1 个令牌并打开门禁，客户端必须在请求头带 Authorization: Bearer <令牌>。",
    } satisfies SettingsActionResult);

    render(<App />);
    await screen.findByText("个人令牌");

    fireEvent.click(screen.getByRole("button", { name: "签发令牌并启用门禁" }));
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

    fireEvent.click(tabLink("安全"));

    fireEvent.click(await screen.findByRole("button", { name: "轮换端点" }));

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
    fireEvent.click(tabLink("安全"));
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
    fireEvent.click(tabLink("安全"));
    fireEvent.click(await screen.findByRole("button", { name: "新建令牌" }));
    fireEvent.click(await screen.findByRole("button", { name: "创建" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Focus moves in an effect, which React flushes on its own schedule (it
    // landed after this synchronous assertion on ubuntu/node 24 in CI, which is
    // a timing artefact, not a behaviour change). The behaviour being pinned is
    // "the dialog takes focus", so wait for it instead of assuming one tick.
    await waitFor(() => expect(document.activeElement).toBe(dialog));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("ob_kbd_value")).toBeNull();
  });
});

test("the directory whitelist is a textarea: every line survives editing", async () => {
  // HTML value sanitization strips newlines from <input type="text">, so the
  // list silently collapsed into one bogus path the moment an operator edited
  // and blurred it. Two directories must come back as two.
  window.history.pushState({}, "", "/console/settings/files");
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
  window.history.pushState({}, "", "/console/settings/network");
  const { container } = render(<App />);
  await screen.findByText("公网健康检查");
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

test("security page can turn OAuth on, and the card shows who holds a credential", async () => {
  window.history.pushState({}, "", "/console/security");
  mocks.settings.mockResolvedValue(settingsState({
    config: { ...settingsState().config, "oauth.enabled": true, "oauth.allowedRedirectHosts": ["chatgpt.com"] },
  }));

  render(<App />);

  // The client list is live data (/api/oauth): without it the operator could
  // switch OAuth on from the console and still see nothing at all.
  expect(await screen.findByText("ChatGPT 连接器")).toBeTruthy();
  expect(screen.getByText(/已注册客户端 1 个/)).toBeTruthy();

  // The 注册时间 column must render the SECONDS value as a real date: the
  // pre-fix UI fed seconds straight into Date (milliseconds), so every row
  // read as January 1970.
  const oauthRow = screen.getByText("ChatGPT 连接器").closest("tr");
  expect(oauthRow?.textContent).toContain("2026");
  expect(oauthRow?.textContent).not.toContain("1970");

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

    // One toggle now, in the topbar, and it is an icon — so the current mode
    // lives in the accessible name rather than in text content. That is also
    // the property worth asserting: an icon-only control that does not
    // announce which mode it is in would be a regression of its own.
    const themeButton = () => screen.getByRole("button", { name: /主题：/ });
    // jsdom ships no matchMedia, so 跟随系统 resolves to the light palette.
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(themeButton().getAttribute("aria-label")).toBe("主题：跟随系统");

    fireEvent.click(themeButton());
    expect(themeButton().getAttribute("aria-label")).toBe("主题：浅色");
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(themeButton());
    expect(themeButton().getAttribute("aria-label")).toBe("主题：深色");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("openBridge.console.theme")).toBe("dark");

    fireEvent.click(themeButton());
    expect(themeButton().getAttribute("aria-label")).toBe("主题：跟随系统");
  });

  /**
   * 通知 grew to three cards and most visits change one switch, so the cards
   * fold. Two properties matter and neither is obvious from the markup:
   *
   * - a collapsed card still says enough to skip it, otherwise folding just
   *   trades scrolling for clicking;
   * - the state survives a reload, otherwise it is a toy.
   */
  test("notification cards fold, summarise, and remember", async () => {
    window.localStorage.clear();
    window.history.pushState({}, "", "/console/settings/notify");

    const { unmount } = render(<App />);
    const header = await screen.findByRole("button", { name: /手机（Bark）/ });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    // Open: the device key field is reachable. The same status summary that
    // the collapsed card shows must also be visible as a badge next to the
    // title, otherwise an operator who never folds the card has no way to
    // tell whether a key is configured.
    expect(screen.getByText("Bark 设备密钥")).toBeTruthy();
    expect(screen.getAllByText(/已配置|缺设备密钥|已关闭/).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Bark 设备密钥")).toBeNull();
    // Collapsed, it still answers "do I need to open this?".
    expect(header.textContent).toMatch(/已配置|缺设备密钥|已关闭/);

    // A reload must not silently reopen it.
    unmount();
    render(<App />);
    const again = await screen.findByRole("button", { name: /手机（Bark）/ });
    expect(again.getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * The "when we notify you" card is a description of the two fixed events,
   * not a settings row. Folding it would be a click that does nothing.
   */
  test("the explanation card has nothing to fold", async () => {
    window.history.pushState({}, "", "/console/settings/notify");
    render(<App />);
    // Explanation text is reachable without any fold target.
    expect(await screen.findByText(/一轮对话结束时提醒一次/)).toBeTruthy();
    // And there is no fold button on the explanation card — only the two
    // channel cards (Bark + Local sound) carry aria-expanded.
    expect(
      screen.queryByRole("button", { name: /什么时候提醒你/ }),
    ).toBeNull();
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
    expect(screen.getByText(/显示 1 \/ 共 2 项/)).toBeTruthy();
  });

  test("the 设置 rail marks the section it jumps to", async () => {
    window.history.pushState({}, "", "/console/settings");

    render(<App />);
    await screen.findByText(/隧道让公网上的客户端连到这台机器/);

    const item = screen.getByRole("button", { name: "并发" });
    expect(item.getAttribute("aria-current")).toBeNull();

    fireEvent.click(item);

    expect(item.getAttribute("aria-current")).toBe("true");
    // The target exists: a rail entry that scrolls nowhere is worse than none.
    expect(document.getElementById("set-locks")).toBeTruthy();
  });

  test("an English browser gets an English console, with nothing to click", async () => {
    // The language switch is gone: the browser already carries this answer and
    // a control that only restates it is a button nobody needs. What matters
    // now is that detection reaches every surface on the first paint.
    window.localStorage.clear();
    vi.stubGlobal("navigator", { languages: ["en-US"], language: "en-US" });
    applyLang();

    render(<App />);

    // Sidebar, breadcrumb and page header all follow, because they read the
    // same getters rather than holding strings captured at module load.
    expect(await screen.findByRole("link", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Health" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    // The tab name is not React-rendered, so it needs its own dependency.
    expect(document.title).toBe("Status · Open Bridge Console");

    // No language control is offered at all — neither label may appear as a button.
    expect(screen.queryByRole("button", { name: "中文" })).toBeNull();
    expect(screen.queryByRole("button", { name: "English" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Auto" })).toBeNull();

    vi.unstubAllGlobals();
  });

  test("a setting lives with the thing it governs, not in a settings drawer", async () => {
    // 工具集 decides what the tool catalog contains and 日志轮转 governs the log
    // pane, so both now sit on those pages. Asserting their ABSENCE from 设置
    // as well is the half that catches a copy left behind in two places.
    window.history.pushState({}, "", "/console/tools");
    render(<App />);

    const profile = await screen.findByLabelText("工具集");
    expect((profile as HTMLSelectElement).value).toBe("full");
    await screen.findByText("工具目录");

    cleanup();
    window.history.pushState({}, "", "/console/logs");
    render(<App />);

    expect(await screen.findByLabelText("单文件上限")).toBeTruthy();
    expect(await screen.findByDisplayValue("10485760")).toBeTruthy();

    cleanup();
    window.history.pushState({}, "", "/console/settings/shell");
    render(<App />);

    await screen.findByText("Shell 路径");
    expect(screen.queryByLabelText("工具集")).toBeNull();
    expect(screen.queryByLabelText("单文件上限")).toBeNull();
  });
  /**
   * The authtoken had no console entry at all: a first-time user with the
   * ngrok binary installed had to find `ngrok config add-authtoken` in a
   * terminal, which is exactly the step that stops someone who is not already
   * comfortable with a shell. The reserved-domain field sat right there
   * implying the rest was configured.
   */
  test("the ngrok authtoken can be saved from the tunnel page", async () => {
    // The authtoken field is ngrok-only now; the shared fixture runs provider
    // "none", so this test resolves settings shaped for ngrok instead.
    mocks.settings.mockResolvedValue(settingsState({ config: { ...settingsState().config, tunnelProvider: "ngrok" } }));
    render(<App />);
    await screen.findByText("MCP 端点");
    fireEvent.click(tabLink("设置"));
    await screen.findByText(/隧道让公网上的客户端连到这台机器/);
    // The authtoken is a manual knob now: the fold is where manual knobs live.
    fireEvent.click(screen.getByRole("button", { name: "高级设置（可执行文件、手动填写的值）" }));

    const field = screen.getByLabelText("Authtoken");
    fireEvent.change(field, { target: { value: "test-ngrok-authtoken" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Authtoken" }));

    await waitFor(() => {
      expect(mocks.settingsAction).toHaveBeenCalledWith({
        command: "saveNgrokAuthtoken",
        token: "test-ngrok-authtoken",
      });
    });
  });

  test("a stored authtoken shows as a mask and is not editable until 替换", async () => {
    // The field is ngrok-only now, so resolve settings shaped for ngrok with
    // the mask. The field must never render the real token: this page is
    // screen-shared and pasted into issues. Same discipline as the Bark key.
    mocks.settings.mockResolvedValue(settingsState({
      ngrokAuthtokenMask: "2abc…••••…45",
      config: { ...settingsState().config, tunnelProvider: "ngrok" },
    }));

    render(<App />);
    await screen.findByText("MCP 端点");
    fireEvent.click(tabLink("设置"));
    await screen.findByText(/隧道让公网上的客户端连到这台机器/);

    fireEvent.click(screen.getByRole("button", { name: "高级设置（可执行文件、手动填写的值）" }));
    const field = screen.getByDisplayValue("2abc…••••…45") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "保存 Authtoken" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "替换" }));
    expect((screen.getByPlaceholderText(/粘贴新的 authtoken/) as HTMLInputElement).readOnly).toBe(false);
  });

  /**
   * The tunnel card, reworked around one rule (choose, do not type) and one
   * shape (both providers render the same three parts). These tests pin the
   * three promises that rule makes: detection is shown before it is trusted,
   * the button is one click, and folding hides knobs without removing them.
   */
  test("the tunnel card shows what the machine has, and says what 自动配置 will write", async () => {
    mocks.settings.mockResolvedValue(withProvider("ngrok"));
    render(<App />);
    await screen.findByText("MCP 端点");
    fireEvent.click(tabLink("设置"));
    await screen.findByText(/隧道让公网上的客户端连到这台机器/);

    // Read-only reconnaissance, named by its source rather than a bland "ok".
    expect(await screen.findByText("ngrok：已安装（PATH）")).toBeTruthy();
    expect(screen.getByText("authtoken：可以从本机 ngrok 配置导入")).toBeTruthy();
    expect(screen.getByText("保留域名：1 个（可在上面选）")).toBeTruthy();

    // The reserved domain is a CHOICE, and its options are the account's.
    const domain = await screen.findByLabelText("公网地址") as HTMLSelectElement;
    expect([...domain.options].map(option => option.value)).toEqual(["", "demo.ngrok-free.app", "__manual__"]);

    // Nothing is written before it is announced: the plan is on the page.
    expect(screen.getByText(/将写入：ngrokExecutable=C:\\tools\\ngrok.exe/)).toBeTruthy();
  });

  test("一键自动配置 writes on one click and re-reads detection afterwards", async () => {
    mocks.settings.mockResolvedValue(withProvider("ngrok"));
    mocks.settingsAction.mockResolvedValue({
      ok: true,
      state: withProvider("ngrok"),
      info: "已写入：ngrok 可执行文件 = C:\\tools\\ngrok.exe。",
    });
    render(<App />);
    await screen.findByText("MCP 端点");
    fireEvent.click(tabLink("设置"));
    const button = await screen.findByRole("button", { name: "一键自动配置" });
    const before = mocks.tunnel.mock.calls.length;
    fireEvent.click(button);

    await waitFor(() => expect(mocks.settingsAction).toHaveBeenCalledWith({ command: "autoConfigureTunnel" }));
    // The outcome is reported, not silently applied.
    expect(await screen.findByText(/已写入：ngrok 可执行文件/)).toBeTruthy();
    // …and the card asks the machine again instead of showing a stale summary.
    await waitFor(() => expect(mocks.tunnel.mock.calls.length).toBeGreaterThan(before));
  });

  test("tailscale renders the same three parts, and the fold holds every manual knob", async () => {
    mocks.settings.mockResolvedValue(withProvider("tailscale"));
    mocks.tunnel.mockResolvedValue(tunnelView("tailscale"));
    render(<App />);
    await screen.findByText("MCP 端点");
    fireEvent.click(tabLink("设置"));
    await screen.findByText(/隧道让公网上的客户端连到这台机器/);

    // Same shape as ngrok's card: a status chip, the action row, the fold.
    expect(await screen.findByText("已登录 · demo.tail9999.ts.net")).toBeTruthy();
    expect(screen.getByText("443：还没有挂载任何服务")).toBeTruthy();
    expect(screen.getByRole("button", { name: "一键自动配置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "测试公网可达" })).toBeTruthy();

    // Folded means folded: no manual field is on screen until it is opened…
    expect(screen.queryByText("Tailscale 可执行文件")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "高级设置（可执行文件、手动填写的值）" }));
    // …but every one of them is still there, which is what "folded" promises.
    expect(screen.getByText("Tailscale 可执行文件")).toBeTruthy();
    expect(screen.getByText("公网域名")).toBeTruthy();
    expect(screen.getByText("隧道意外退出时自动重连")).toBeTruthy();
  });

  test("测试公网可达 runs the real checks and reports them in the card", async () => {
    mocks.settings.mockResolvedValue(withProvider("tailscale"));
    mocks.tunnel.mockResolvedValue(tunnelView("tailscale"));
    render(<App />);
    await screen.findByText("MCP 端点");
    fireEvent.click(tabLink("设置"));
    fireEvent.click(await screen.findByRole("button", { name: "测试公网可达" }));

    // The public leg is an actual request through the tunnel, so the card shows
    // that check's own verdict rather than the instance's opinion of itself.
    expect(await screen.findByText(/公网连通：HTTP 200/)).toBeTruthy();
    expect(screen.getByText(/公网上的客户端现在可以连到这个地址。/)).toBeTruthy();
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
    mocks.settings.mockResolvedValue(withProvider("ngrok"));
    window.history.pushState({}, "", "/console/settings");

    const { container } = render(<App />);
    await screen.findByText(/隧道让公网上的客户端连到这台机器/);
    // The tunnel switches moved behind 高级设置: folded, not gone.
    fireEvent.click(await screen.findByRole("button", { name: "高级设置（可执行文件、手动填写的值）" }));

    // Provider ngrok: autoReconnect plus the ngrok proxy switch.
    const switches = [...container.querySelectorAll("input.switch")] as HTMLInputElement[];
    expect(switches.length).toBe(2);
    expect(switches.every(input => input.type === "checkbox")).toBe(true);

    // And they still write the same config key they wrote as a plain checkbox.
    // Found by name, not by DOM order: which switch comes first is a layout
    // detail, which key a switch writes is the contract.
    const autoReconnect = switches.find(input => input.getAttribute("aria-label") === "隧道意外退出时自动重连");
    expect(autoReconnect?.checked).toBe(true);
    fireEvent.click(autoReconnect!);
    expect(mocks.settingsAction).toHaveBeenCalledWith({ command: "setConfig", key: "autoReconnect", value: false });
  });

  /**
   * Every switch used to sit inside a <label> wrapping its own caption, so
   * clicking the text toggled the setting. On a page that is mostly labelled
   * rows that turns a stray click near a setting into a silent config change
   * — the kind you discover later, by its consequences.
   *
   * The switch keeps an accessible name through aria-label, so this is a
   * smaller pointer target, not a less usable control.
   */
  test("a switch is toggled by the control, not by its caption", async () => {
    mocks.settings.mockResolvedValue(withProvider("ngrok"));
    window.history.pushState({}, "", "/console/settings");

    const { container } = render(<App />);
    await screen.findByText(/隧道让公网上的客户端连到这台机器/);
    fireEvent.click(await screen.findByRole("button", { name: "高级设置（可执行文件、手动填写的值）" }));

    const input = container.querySelector("input.switch") as HTMLInputElement;
    expect(input).toBeTruthy();
    // The accessible name has to survive: a bare checkbox announced as
    // "checkbox" would be a regression of its own.
    expect(input.getAttribute("aria-label")).toBeTruthy();

    // No ancestor <label> — that is what made the caption clickable.
    expect(input.closest("label")).toBeNull();

    const before = mocks.settingsAction.mock.calls.length;
    const caption = container.querySelector(".check-row .field-label") as HTMLElement;
    expect(caption).toBeTruthy();
    fireEvent.click(caption);
    expect(mocks.settingsAction.mock.calls.length).toBe(before);

    // The control itself still works.
    fireEvent.click(input);
    expect(mocks.settingsAction.mock.calls.length).toBe(before + 1);
  });
});

test("redirects the retired /console/tokens bookmark to 安全", async () => {
  // The 令牌 page moved to 安全; old bookmarks must land on the new
  // page instead of falling through to 状态.
  window.history.pushState({}, "", "/console/tokens");

  render(<App />);

  expect(await screen.findByText("个人令牌")).toBeTruthy();
});

describe("App shell: keyboard reach", () => {
  /**
   * Can the console be driven without a mouse?
   *
   * Asserted against the rendered DOM rather than by reading source. A grep
   * for Escape handlers flagged four files as missing one and all four were
   * false — they merely contained the word "dialog" in a comment. What the
   * keyboard can actually do is a property of the tree, so walk the tree.
   */
  test("every reachable control announces what it is", async () => {
    const { container } = render(<App />);
    await screen.findByText("MCP 端点");

    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
    ].join(",");
    const reachable = [...container.querySelectorAll<HTMLElement>(selector)];
    expect(reachable.length).toBeGreaterThan(5);

    // A control a screen reader cannot name is reachable but useless: the
    // user hears "button" and has to guess. Icon-only controls are the usual
    // offenders, which is why the theme toggle carries an aria-label.
    const unnamed = reachable.filter(el => {
      const text = (el.textContent ?? "").trim();
      // `title` is deliberately NOT accepted here. It shows a tooltip on hover
      // and screen readers treat it as a last resort — several announce
      // nothing at all when it is the only name. An icon-only control needs
      // aria-label. Dropping the theme button's aria-label while leaving its
      // title in place is exactly the regression this must catch.
      const label = el.getAttribute("aria-label") ?? "";
      const placeholder = el.getAttribute("placeholder") ?? "";
      return !text && !label && !placeholder;
    });
    expect(unnamed.map(el => el.outerHTML.slice(0, 70))).toEqual([]);
  });

  test("a click-only div never hides the only route to an action", async () => {
    const { container } = render(<App />);
    await screen.findByText("MCP 端点");

    // onClick on a div is legitimate for an overlay backdrop — Escape is the
    // keyboard path, covered above. It is only a defect when the div IS the
    // action. Anything else with onClick must be a real control.
    const divs = [...container.querySelectorAll<HTMLElement>("div,span")];
    const suspicious = divs.filter(el => {
      const cls = el.className || "";
      if (typeof cls === "string" && (cls.includes("scrim") || cls.includes("mask"))) return false;
      return el.hasAttribute("onclick");
    });
    expect(suspicious.map(el => el.outerHTML.slice(0, 70))).toEqual([]);
  });
});


describe("console audit regressions", () => {
  test.each([true, false])("saves a typed ngrok domain explicitly (reserved choices=%s)", async hasChoices => {
    window.history.pushState({}, "", "/console/settings/tunnel");
    const initial = withProvider("ngrok");
    mocks.settings.mockResolvedValue(initial);
    const facts = tunnelFactsFixture();
    if (!hasChoices) facts.ngrok.domains = [];
    mocks.tunnel.mockResolvedValue(tunnelView("ngrok", facts));
    mocks.settingsAction.mockResolvedValue({ ok: true, state: { ...initial, configuredDomain: "typed.example.test" } });
    render(<App />);
    if (hasChoices) {
      fireEvent.change(await screen.findByLabelText("公网地址"), { target: { value: "__manual__" } });
    }
    const input = await screen.findByLabelText("公网地址（手动填写）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: " typed.example.test " } });
    expect(mocks.settingsAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存域名" }));
    await waitFor(() => expect(mocks.settingsAction).toHaveBeenCalledWith({ command: "saveDomain", domain: "typed.example.test" }));
    await waitFor(() => expect(input.value).toBe("typed.example.test"));
    expect(mocks.settingsAction).toHaveBeenCalledTimes(1);
  });

  test("a saved custom domain remains visible after reloading the tunnel page", async () => {
    window.history.pushState({}, "", "/console/settings/tunnel");
    mocks.settings.mockResolvedValue({ ...withProvider("ngrok"), configuredDomain: "custom.example.test" });
    render(<App />);
    const input = await screen.findByLabelText("公网地址（手动填写）") as HTMLInputElement;
    expect(input.value).toBe("custom.example.test");
    expect((screen.getByLabelText("公网地址") as HTMLSelectElement).value).toBe("__manual__");
    expect(mocks.settingsAction).not.toHaveBeenCalled();
  });

  test("choosing the unset domain option explicitly clears a saved domain", async () => {
    window.history.pushState({}, "", "/console/settings/tunnel");
    const initial = { ...withProvider("ngrok"), configuredDomain: "demo.ngrok-free.app" };
    mocks.settings.mockResolvedValue(initial);
    mocks.settingsAction.mockResolvedValue({ ok: true, state: { ...initial, configuredDomain: "" } });
    render(<App />);
    const select = await screen.findByLabelText("公网地址") as HTMLSelectElement;
    expect(select.value).toBe("demo.ngrok-free.app");
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(mocks.settingsAction).toHaveBeenCalledWith({ command: "saveDomain", domain: "" }));
    expect(select.value).toBe("");
  });

  test("a domain save acknowledgement does not clear a newer typed draft", async () => {
    window.history.pushState({}, "", "/console/settings/tunnel");
    const initial = withProvider("ngrok");
    mocks.settings.mockResolvedValue(initial);
    let resolve!: (result: SettingsActionResult) => void;
    mocks.settingsAction.mockImplementationOnce(() => new Promise<SettingsActionResult>(done => { resolve = done; }));
    render(<App />);
    fireEvent.change(await screen.findByLabelText("公网地址"), { target: { value: "__manual__" } });
    const input = screen.getByLabelText("公网地址（手动填写）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "first.example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "保存域名" }));
    fireEvent.change(input, { target: { value: "newer.example.test" } });
    await act(async () => { resolve({ ok: true, state: { ...initial, configuredDomain: "first.example.test" } }); });
    expect(input.value).toBe("newer.example.test");
    expect(mocks.settingsAction).toHaveBeenCalledTimes(1);
  });

  test("a rejected domain stays editable and is not reported as saved", async () => {
    window.history.pushState({}, "", "/console/settings/tunnel");
    const initial = withProvider("ngrok");
    mocks.settings.mockResolvedValue(initial);
    mocks.settingsAction.mockResolvedValue({ ok: false, state: initial, error: "域名格式不对。" });
    render(<App />);
    fireEvent.change(await screen.findByLabelText("公网地址"), { target: { value: "__manual__" } });
    const input = screen.getByLabelText("公网地址（手动填写）") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not a hostname" } });
    fireEvent.click(screen.getByRole("button", { name: "保存域名" }));
    expect(await screen.findByText("域名格式不对。")).toBeTruthy();
    expect(input.value).toBe("not a hostname");
    await waitFor(() => expect((screen.getByRole("button", { name: "保存域名" }) as HTMLButtonElement).disabled).toBe(false));
  });

  test.each([false, true])("never claims public reach without a public probe (empty checks=%s)", async empty => {
    window.history.pushState({}, "", "/console/settings/tunnel");
    mocks.settings.mockResolvedValue(withProvider("ngrok"));
    const report: HealthReport = {
      exposure: "local",
      checks: empty ? [] : [
        { name: "tunnel", level: "ok", ok: true, detail: "未开启（仅本机可用）" },
        { name: "exposure", level: "ok", ok: true, detail: "local" },
      ],
    };
    mocks.health.mockResolvedValue(report);
    render(<App />);
    const button = await screen.findByRole("button", { name: "测试公网可达" });
    await act(async () => { fireEvent.click(button); });
    expect(screen.queryByText("公网上的客户端现在可以连到这个地址。")).toBeNull();
    expect(screen.queryByText("公网可达")).toBeNull();
    expect(screen.getByText("公网未验证")).toBeTruthy();
  });

  test("a failed public probe is not converted to an untested or reachable result", async () => {
    window.history.pushState({}, "", "/console/settings/tunnel");
    mocks.settings.mockResolvedValue(withProvider("ngrok"));
    mocks.health.mockResolvedValue({ exposure: "public-open", checks: [
      { name: "public", level: "fail", ok: false, detail: "HTTP 503" },
      { name: "exposure", level: "warn", ok: false, detail: "public-open" },
    ] } satisfies HealthReport);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "测试公网可达" }));
    expect(await screen.findByText("有问题")).toBeTruthy();
    expect(screen.getByText(/公网连通：HTTP 503/)).toBeTruthy();
    expect(screen.getByText(/public-open/)).toBeTruthy();
    expect(screen.queryByText("公网可达")).toBeNull();
  });

  test("modern activity is visible but has no fabricated session or disconnect action", async () => {
    window.history.pushState({}, "", "/console/sessions");
    mocks.sessions.mockResolvedValue({ sessions: [sessionView(), {
      id: "modern", client: "Modern MCP (stateless)", era: "modern", stateless: true, closable: false,
      connected_at: null, first_seen: "2026-09-11T01:02:03.000Z", last_used: "2026-09-11T01:03:03.000Z",
      idle_ms: 0, calls: null, todos: null, active_requests: 2,
    }], locks: lockSnapshot() });
    render(<App />);
    await screen.findByText("cursor/0.42");
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const modern = within(rows[2]!);
    expect(modern.queryByRole("button", { name: "断开" })).toBeNull();
    expect(modern.queryByRole("button", { name: "复制会话 ID" })).toBeNull();
    expect(modern.getByText(/首次观察/)).toBeTruthy();
    expect(modern.getByText("2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "断开" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "活跃 1" }));
    expect(screen.queryByText("cursor/0.42")).toBeNull();
    expect(mocks.closeSession).not.toHaveBeenCalled();
  });

  test("an unknown POST outcome leaves settings and the entered value on screen", async () => {
    window.history.pushState({}, "", "/console/settings/network");
    const error = "POST /api/settings/action → 响应不是有效 JSON (HTTP 200)；操作结果未知，请刷新核对。";
    mocks.settingsAction.mockRejectedValue(new Error(error));
    render(<App />);
    const field = await screen.findByDisplayValue("20000") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "25000" } });
    fireEvent.blur(field);
    expect(await screen.findByText(error)).toBeTruthy();
    expect(field.value).toBe("25000");
    expect(screen.getByText("公网健康检查")).toBeTruthy();
    expect(mocks.settingsAction).toHaveBeenCalledTimes(1);
  });
});


describe("ngrok empty-domain semantics", () => {
  test.each([true, false])("does not promise an unsupported random tunnel (choices=%s)", async hasChoices => {
    window.history.pushState({}, "", "/console/settings/tunnel");
    mocks.settings.mockResolvedValue(withProvider("ngrok"));
    const facts = tunnelFactsFixture();
    if (!hasChoices) facts.ngrok.domains = [];
    mocks.tunnel.mockResolvedValue(tunnelView("ngrok", facts));
    render(<App />);
    await screen.findByText("ngrok：已安装（PATH）");
    expect(screen.queryAllByText(/随机地址/)).toHaveLength(0);
    expect(screen.getByText(/留空时下次启动仅本机可用/)).toBeTruthy();
    if (hasChoices) {
      expect(screen.getByRole("option", { name: "未设置域名（下次启动仅本机）" })).toBeTruthy();
    }
  });
});
