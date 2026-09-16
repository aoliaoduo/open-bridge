/**
 * Open Bridge Desktop —— 桌面壳主进程（第一阶段：薄壳）。
 *
 * 壳不重新实现桥的任何能力：桥以子进程 `open-bridge serve` 存在，壳负责
 * 生（启动、健康等待、崩溃重启）、老（托盘常驻）、病（异常退出感知）、
 * 死（退出时优雅关闭）。窗口本体仍是 dist/ui 的 console —— 未来 codex 式
 * agent 工作台从 preload 暴露的 `obDesktop` 接口长出来，壳的结构不变。
 *
 * 选址端口而不是读 runtime 记录：壳选择端口并以 `--port` 显式传给子进程，
 * 避免与 CLI 并发的 read-then-act；唯在「该工作区已有实例在跑」时不打架，
 * 而是附着（attach）过去 —— 同一片地面，一盏灯亮着就不要再点一盏。
 */

import { app, BrowserWindow, Tray, Menu, dialog, nativeImage, clipboard, ipcMain } from "electron";
import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（开发时 desktop/ 的上级）；打包后桥被收进 resources。 */
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");

/** 崩溃重启节奏：与桥内 RECONNECT_DELAYS 同一套呼吸。 */
const RESTART_DELAYS_MS = [1000, 2000, 5000, 15000];
const HEALTH_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;

/** 壳自己的持久配置：只记用户选的工作区目录。 */
function configPath() {
  return path.join(app.getPath("userData"), "desktop-config.json");
}

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    if (parsed && typeof parsed.workspace === "string" && parsed.workspace.trim()) {
      return { workspace: parsed.workspace };
    }
  } catch { /* 首启或损坏：落回默认 */ }
  return { workspace: os.homedir() };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
  } catch { /* 配置写不进也不该致命 */ }
}

/** 桥 CLI 入口：开发态=仓库的 bin/；打包态=resources/bridge/bin/。 */
function bridgeBinPath() {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, "bridge", "bin", "open-bridge.js")
    : path.join(REPO_ROOT, "bin", "open-bridge.js");
  return candidate;
}

function bridgeDistExists() {
  const distCli = app.isPackaged
    ? path.join(process.resourcesPath, "bridge", "dist", "cli.js")
    : path.join(REPO_ROOT, "dist", "cli.js");
  return fs.existsSync(distCli);
}

function logDir() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 子进程输出尾部落盘：出问题时用户能给我们的只有这一个文件。 */
function openLogStream() {
  const file = path.join(logDir(), "bridge.log");
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.renameSync(file, `${file}.1`); // 只留一代，审计风格同 appendAuditEntry
    }
  } catch { /* 轮换失败就继续追加，比截断温和 */ }
  return fs.createWriteStream(file, { flags: "a" });
}

/** 选个空闲回环端口：listen(0) 拿地即还，竞态窗口对本地桥可接受。 */
function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function healthzOnce(port) {
  return new Promise(resolve => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/healthz", timeout: 1500 },
      res => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.once("error", () => resolve(false));
    req.once("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitHealthy(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthzOnce(port)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

/**
 * 该工作区是否已有实例：扫数据 home 下的 runtime-*.json，root 命中即之。
 * 数据 home 的默认解析与 CLI 相同（~/.open-bridge；Windows 上若有 APPDATA
 * 注册则用之），两者都探一遍，读不到就当作没有 —— 附着失败永远落回自启。
 */
function findExistingInstance(root) {
  const homes = [path.join(os.homedir(), ".open-bridge")];
  if (process.env.APPDATA) homes.push(path.join(process.env.APPDATA, "open-bridge"));
  for (const home of homes) {
    let files = [];
    try {
      files = fs.readdirSync(home).filter(name => /^runtime.*\.json$/.test(name));
    } catch { continue; }
    for (const name of files) {
      try {
        const info = JSON.parse(fs.readFileSync(path.join(home, name), "utf8"));
        if (
          info && typeof info.port === "number" &&
          typeof info.root === "string" &&
          path.resolve(info.root) === path.resolve(root)
        ) {
          return { port: info.port, pid: typeof info.pid === "number" ? info.pid : 0 };
        }
      } catch { /* 单条损坏不影响其余 */ }
    }
  }
  return undefined;
}

/** 壳内唯一的桥运行时句柄。 */
const bridge = {
  child: null,          // 自管子进程；附着已有实例时为 null
  attachedPort: 0,      // 附着到的端口（child 为 null 时有意义）
  port: 0,
  routeToken: "",       // 从子进程横幅捕获的 MCP 路由令牌；附着模式永远拿不到
  publicMcpUrl: "",     // 横幅里的公网 MCP URL（隧道起来才有）；配对网页 AI 就靠它

  restarting: false,
  crashCount: 0,
  intentionalStop: false,
  logStream: null,
};

function currentPort() {
  return bridge.child ? bridge.port : bridge.attachedPort;
}

async function startBridge(workspace) {
  if (bridge.child || bridge.attachedPort) return;
  const existing = findExistingInstance(workspace);
  if (existing && (await healthzOnce(existing.port))) {
    bridge.attachedPort = existing.port;
    publishStatus();
    return;
  }
  if (!bridgeDistExists()) return; // 由 openWindow 前的守卫提示构建
  bridge.logStream = openLogStream();
  bridge.routeToken = ""; // 新实例的横幅会给新令牌，别让上一个活着时的留在壳里
  bridge.publicMcpUrl = "";
  const port = await pickPort();
  bridge.port = port;
  const child = fork(bridgeBinPath(), ["serve", "--port", String(port)], {
    cwd: workspace,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  bridge.child = child;
  child.stdout?.on("data", chunk => {
    bridge.logStream?.write(chunk);
    // 路由令牌只在桥自报的启动横幅里出现一次，壳要替工作台看住它。
    const line = chunk.toString("utf8");
    if (!bridge.routeToken) {
      const hit = line.match(/mcp\/([0-9a-fA-F]{16,})/);
      if (hit) bridge.routeToken = hit[1];
    }
    if (!bridge.publicMcpUrl) {
      const pub = line.match(/公网 MCP URL:\s*(https:\/\/\S+\/mcp\/[0-9a-fA-F]+)/);
      if (pub) bridge.publicMcpUrl = pub[1];
    }
  });
  child.stderr?.on("data", chunk => bridge.logStream?.write(chunk));
  // 必须先挂退出监听再等健康：子进程若在等待期内死掉，后挂的 once("exit")
  // 永远不会补发，bridge.child 会卡在非空 —— 重启永远排不上、stop 也等空。
  child.once("exit", (code, signal) => {
    bridge.logStream?.write(`\n[desktop] bridge exited code=${String(code)} signal=${String(signal)}\n`);
    bridge.child = null;
    if (bridge.intentionalStop) return;
    scheduleRestart(workspace);
  });
  const healthy = await waitHealthy(port, HEALTH_TIMEOUT_MS);
  if (!healthy && bridge.child) {
    // 起不来多半是被已有实例占了锁（两实例同目录竞态），最后再认一次附着。
    const late = findExistingInstance(workspace);
    if (late && (await healthzOnce(late.port))) {
      stopBridge();
      bridge.attachedPort = late.port;
    }
  }
  publishStatus();
}

function scheduleRestart(workspace) {
  if (bridge.restarting || app.isQuitting) return;
  const attempt = bridge.crashCount;
  if (attempt >= RESTART_DELAYS_MS.length) {
    publishStatus(); // 托盘菜单此时提供「重启服务」
    return;
  }
  bridge.restarting = true;
  bridge.crashCount += 1;
  const delay = RESTART_DELAYS_MS[attempt];
  setTimeout(() => {
    bridge.restarting = false;
    void startBridge(workspace);
  }, delay);
}

function stopBridge() {
  bridge.intentionalStop = true;
  const child = bridge.child;
  bridge.attachedPort = 0;
  if (!child) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 已死 */ } }, STOP_TIMEOUT_MS);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

async function restartBridge(workspace) {
  await stopBridge();
  bridge.intentionalStop = false;
  bridge.crashCount = 0;
  await startBridge(workspace);
  publishStatus();
}

// ---- 窗口 -------------------------------------------------------------------

let mainWindow = null;

async function openWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (!bridgeDistExists()) {
    dialog.showErrorBox(
      "Open Bridge 尚未构建",
      "找不到 dist/cli.js。请先在仓库根目录执行 npm run build，再启动桌面壳。",
    );
    return;
  }
  // 工作台先开、桥后到也行：渲染层自己会拉状态/工具，失败显化成错误泡。
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0e14",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DESKTOP_DIR, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  await mainWindow.loadFile(path.join(DESKTOP_DIR, "workbench", "index.html"));
}

// ---- 旧版监控控制台（/console，桥自己 host 的那个）与它是两扇窗 --------

let consoleWindow = null;

function openConsoleWindow() {
  const port = currentPort();
  if (!port) {
    dialog.showErrorBox("桥服务未运行", "本地服务还没起来，控制台无源可接。");
    return;
  }
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.show();
    consoleWindow.focus();
    return;
  }
  consoleWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  consoleWindow.on("closed", () => { consoleWindow = null; });
  void consoleWindow.loadURL(`http://127.0.0.1:${port}/console`);
}

// ---- 托盘 -------------------------------------------------------------------

let tray = null;

function statusLine() {
  const port = currentPort();
  if (port) return bridge.child ? `服务运行中 · 端口 ${port}` : `附着到已运行实例 · 端口 ${port}`;
  if (bridge.restarting) return "服务重启中…";
  return "服务未运行";
}

function buildTrayMenu(workspace) {
  return Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    { type: "separator" },
    { label: "打开工作台", click: () => { void openWindow(); } },
    { label: "打开控制台（监控）", click: () => { void openConsoleWindow(); } },
    { label: "重启服务", click: () => { void restartBridge(workspace); } },
    {
      label: "更换工作区文件夹…",
      click: async () => {
        const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
        if (picked.canceled || !picked.filePaths[0]) return;
        workspace = picked.filePaths[0];
        saveConfig({ workspace });
        await restartBridge(workspace);
      },
    },
    { type: "separator" },
    { label: "退出（停止本地服务）", click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function publishStatus() {
  if (!tray) return;
  tray.setToolTip(`Open Bridge — ${statusLine()}`);
  tray.setContextMenu(buildTrayMenu(currentWorkspace));
}

function trayIcon() {
  const iconPath = path.join(DESKTOP_DIR, "icon.png");
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image;
  } catch { /* 无图标时退化为空图 */ }
  return nativeImage.createEmpty();
}

// ---- 工作台 IPC：本地商店、项目、LLM、经壳转发的 MCP -----------------------------

/** 本地桥 MCP 会话：惰性握手，会话失效重握一次。 */
const mcpState = { sessionId: "", tools: [], ready: false };

function bridgeMcpUrl() {
  const targetPort = currentPort();
  if (!targetPort) throw new Error("本地桥服务未运行。");
  if (!bridge.routeToken) {
    throw new Error("拿不到路由令牌：此实例不是壳启动的（附着模式）。托盘「重启服务」让壳接管后再用工具。");
  }
  return `http://127.0.0.1:${targetPort}/mcp/${bridge.routeToken}`;
}

async function parseMcpBody(resp) {
  const ctype = resp.headers.get("content-type") || "";
  const body = await resp.text();
  if (ctype.includes("text/event-stream")) {
    const out = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try { out.push(JSON.parse(payload)); } catch { /* 非整行，忽略 */ }
    }
    return out;
  }
  try { return [JSON.parse(body)]; } catch { return []; }
}

function mcpPost(payload) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (mcpState.sessionId) headers["Mcp-Session-Id"] = mcpState.sessionId;
  return fetch(bridgeMcpUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300000),
  });
}

async function ensureMcp() {
  if (mcpState.ready && mcpState.sessionId) return;
  const initResp = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "open-bridge-desktop", version: "0.1.0" },
    },
  });
  const sid = initResp.headers.get("mcp-session-id");
  if (!sid) throw new Error(`MCP 握手失败（HTTP ${initResp.status}）`);
  mcpState.sessionId = sid;
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listResp = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const msgs = await parseMcpBody(listResp);
  const listed = msgs.flatMap(msg => (msg.result && Array.isArray(msg.result.tools)) ? msg.result.tools : []);
  if (!listed.length) throw new Error("MCP 工具列表为空：桥可能还在启动。再试一次。");
  // 描述截到 400 字符：桥的工具文档详尽，整本喂给模型不划算。
  mcpState.tools = listed.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: String(tool.description || "").slice(0, 400),
      parameters: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" },
    },
  }));
  mcpState.ready = true;
}

function mcpReset() {
  mcpState.sessionId = "";
  mcpState.tools = [];
  mcpState.ready = false;
}

/** 桥的活动日志直取（/api/activity 是 loopback 门，不走 MCP 会话，轮询成本低）。 */
async function fetchActivity() {
  const targetPort = currentPort();
  if (!targetPort) return [];
  try {
    const resp = await fetch(`http://127.0.0.1:${targetPort}/api/activity`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data.activity) ? data.activity : [];
  } catch {
    return [];
  }
}

async function mcpCallRemote(name, args) {
  await ensureMcp();
  const call = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: { name, arguments: args && typeof args === "object" && args !== null ? args : {} },
  };
  let resp = await mcpPost(call);
  if (resp.status === 400 || resp.status === 404) {
    // 桥重启/会话被逐出：重握一次再发；再错就是真错。
    mcpReset();
    await ensureMcp();
    resp = await mcpPost(call);
  }
  const msgs = await parseMcpBody(resp);
  const result = msgs.flatMap(msg => (msg.result ? [msg.result] : []))[0];
  if (!result) {
    const rpcError = msgs.flatMap(msg => (msg.error ? [msg.error.message] : []))[0];
    throw new Error(rpcError || `MCP 调用 ${name} 无结果（HTTP ${resp.status}）`);
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const textBits = (Array.isArray(result.content) ? result.content : [])
    .filter(item => item && item.type === "text")
    .map(item => item.text || "");
  if (result.isError) {
    throw new Error(textBits.join("\n").slice(0, 500) || `工具 ${name} 报错`);
  }
  return textBits.join("\n");
}

/* LLM 段已移除：agent 由网页 AI 经 MCP 驱动，桌面端不做本地 API 循环（聚焦）。 */

function registerWorkbenchIpc() {

  ipcMain.handle("ob:choose-workspace", async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return picked.canceled ? null : (picked.filePaths[0] || null);
  });
  ipcMain.handle("ob:set-workspace", async (_event, dirPath) => {
    if (typeof dirPath !== "string" || !dirPath.trim()) {
      throw new Error("set-workspace：需要非空目录路径。");
    }
    currentWorkspace = dirPath;
    saveConfig({ workspace: currentWorkspace });
    bridge.routeToken = "";
    mcpReset();
    await restartBridge(currentWorkspace);
    publishStatus();
    return { workspace: currentWorkspace, port: currentPort() };
  });
  ipcMain.handle("ob:open-console", () => { void openConsoleWindow(); });
  ipcMain.handle("mcp:tools", async () => {
    await ensureMcp();
    return mcpState.tools;
  });
  ipcMain.handle("mcp:call", async (_event, name, args) => {
    if (typeof name !== "string" || !name.trim()) throw new Error("mcp:call：需要工具名。");
    return mcpCallRemote(name.trim(), args);
  });
  ipcMain.handle("ob:activity", () => fetchActivity());
  ipcMain.handle("ob:copy-text", (_event, text) => {
    if (typeof text === "string" && text) clipboard.writeText(text);
  });
}

// ---- 生命周期 ----------------------------------------------------------------

let currentWorkspace = os.homedir();
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => { void openWindow(); });

  app.whenReady().then(async () => {
    currentWorkspace = loadConfig().workspace;
    tray = new Tray(trayIcon());
    tray.on("double-click", () => { void openWindow(); });

    ipcMain.handle("ob:restart", () => restartBridge(currentWorkspace));
    ipcMain.handle("ob:status", () => {
      const loopPort = currentPort();
      return {
        port: loopPort,
        attached: !bridge.child && Boolean(bridge.attachedPort),
        workspace: currentWorkspace,
        logFile: path.join(logDir(), "bridge.log"),
        versions: { electron: process.versions.electron, node: process.versions.node },
        routeTokenKnown: Boolean(bridge.routeToken),
        /** 配对网页 AI 的连接器 URL：公网优先，回环兜底（仅本机客户端可用）。 */
        publicMcpUrl: bridge.publicMcpUrl,
        loopbackMcpUrl: loopPort && bridge.routeToken
          ? `http://127.0.0.1:${loopPort}/mcp/${bridge.routeToken}`
          : "",
      };
    });

    registerWorkbenchIpc();
    await startBridge(currentWorkspace);
    publishStatus();
    await openWindow();
    if (process.argv.includes("--smoke")) {
      // 冒烟模式：窗口开 20 秒后自行退出，供首验/CI 证明「起得来、连得上」。
      // 第 4 秒抓一帧渲染进 userData/smoke-shot.png —— 界面结构对不对，
      // 无人值守时唯一的证据就是这张图。
      setTimeout(() => {
        void (async () => {
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const shot = await mainWindow.webContents.capturePage();
              fs.writeFileSync(path.join(app.getPath("userData"), "smoke-shot.png"), shot.toPNG());
            }
          } catch { /* 截图失败不影响冒烟结论 */ }
        })();
      }, 4000);
      setTimeout(() => { app.isQuitting = true; app.quit(); }, 20000);
    }
  });

  app.on("window-all-closed", () => {
    // 桥的本职是常驻：窗关了，服务与托盘还在；只有托盘「退出」真正收摊。
  });

  app.on("before-quit", event => {
    if (bridge.child && !bridge.intentionalStop) {
      event.preventDefault();
      void stopBridge().then(() => app.quit());
    }
  });
}
