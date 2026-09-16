/* eslint-disable @typescript-eslint/no-require-imports -- Electron 沙箱内的 preload 只能是 CommonJS（ESM preload 要求关沙箱，安全姿态不换）。 */
/**
 * 壳与页面之间唯一受控的桥。MCP 上桌面版只暴露：壳/桥状态、工作区切换、
 * 控制台窗口、活动轮询与剪贴板兜底。mcp.* 保留为 B 阶段客户端窗格的插座。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("obDesktop", {
  /** 壳/桥状态：端口、附着、工作区、日志、连接器 URL（公网/回环）。 */
  status: () => ipcRenderer.invoke("ob:status"),
  restartBridge: () => ipcRenderer.invoke("ob:restart"),
  chooseWorkspace: () => ipcRenderer.invoke("ob:choose-workspace"),
  setWorkspace: (dirPath) => ipcRenderer.invoke("ob:set-workspace", dirPath),
  openConsole: () => ipcRenderer.invoke("ob:open-console"),
  /** 桥的活动日志（最新在前，滚动窗上限见桥侧 state.activity）。 */
  activity: () => ipcRenderer.invoke("ob:activity"),
  /** 剪贴板兜底：渲染层 navigator.clipboard 不可达时走主进程。 */
  copyText: (text) => ipcRenderer.invoke("ob:copy-text", text),
  /** （B 阶段预留）经壳转发到本地桥 MCP 的工具面。 */
  mcp: {
    tools: () => ipcRenderer.invoke("mcp:tools"),
    callTool: (name, args) => ipcRenderer.invoke("mcp:call", name, args),
  },
});
