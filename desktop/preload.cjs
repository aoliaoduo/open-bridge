/**
 * 壳与页面之间唯一受控的桥（contextIsolation 之内、nodeIntegration 之外）。
 *
 * 现在只暴露状态查询与重启 —— console UI 还是纯网页，不知道自己住在壳里；
 * 这张表面是给下一段（codex 式 agent 工作台界面）预留的插座位：届时对话、
 * diff、终端组件经 `obDesktop` 拿壳与桥的能力，壳结构不必再动。
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron 沙箱内的 preload 只能是 CommonJS（ESM preload 要求关沙箱，安全姿态不换）。 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("obDesktop", {
  /** 壳/桥状态：端口、附着与否、工作区、日志文件、运行时版本。 */
  status: () => ipcRenderer.invoke("ob:status"),
  /** 重启本地桥服务（工作区不变）。 */
  restartBridge: () => ipcRenderer.invoke("ob:restart"),
});
