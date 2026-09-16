/* eslint-disable @typescript-eslint/no-require-imports -- Electron 沙箱内的 preload 只能是 CommonJS（ESM preload 要求关沙箱，安全姿态不换）。 */
/**
 * 壳与页面之间唯一受控的桥（contextIsolation 之内、nodeIntegration 之外）。
 *
 * 工作台阶段：这张表面分四组 —— 壳状态/重启、工作区项目（选目录、切换、
 * 打开控制台）、本地商店（workbench.json）、agent 两条腿（LLM 流式对话、
 * 经壳转发的 MCP 工具）。渲染层永远拿不到令牌与密钥之外的网络细节，壳是唯一出口。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("obDesktop", {
  /** 壳/桥状态：端口、附着与否、工作区、日志文件、运行时版本。 */
  status: () => ipcRenderer.invoke("ob:status"),
  /** 重启本地桥服务（工作区不变）。 */
  restartBridge: () => ipcRenderer.invoke("ob:restart"),
  /** 弹目录选择框，返回所选路径或 null。 */
  chooseWorkspace: () => ipcRenderer.invoke("ob:choose-workspace"),
  /** 切换桥服务的工作区（保存后重启服务）。 */
  setWorkspace: (dirPath) => ipcRenderer.invoke("ob:set-workspace", dirPath),
  /** 打开旧版监控控制台窗口。 */
  openConsole: () => ipcRenderer.invoke("ob:open-console"),
  /** 工作台本地数据（projects / conversations / settings）。 */
  store: {
    load: () => ipcRenderer.invoke("wb:load"),
    save: (data) => ipcRenderer.invoke("wb:save", data),
  },
  /** 经壳转发到本地桥 MCP 的工具面。 */
  mcp: {
    tools: () => ipcRenderer.invoke("mcp:tools"),
    callTool: (name, args) => ipcRenderer.invoke("mcp:call", name, args),
  },
  /** LLM（OpenAI 兼容）：流式对话与连接测试。密钥只到主进程。 */
  llm: {
    chat: (req, onEvent) => new Promise((resolve, reject) => {
      const channel = globalThis.crypto.randomUUID();
      const listener = (_event, msg) => {
        if (!msg || msg.channel !== channel) return;
        if (msg.type === "delta" && onEvent && typeof onEvent.delta === "function") {
          onEvent.delta(msg.text);
        } else if (msg.type === "done") {
          ipcRenderer.removeListener("llm:event", listener);
          resolve(msg.result);
        } else if (msg.type === "error") {
          ipcRenderer.removeListener("llm:event", listener);
          reject(new Error(msg.message));
        }
      };
      ipcRenderer.on("llm:event", listener);
      ipcRenderer.invoke("llm:chat", channel, req).catch((error) => {
        ipcRenderer.removeListener("llm:event", listener);
        reject(error);
      });
    }),
    test: (cfg) => ipcRenderer.invoke("llm:test", cfg),
  },
});
