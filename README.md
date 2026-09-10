# Open Bridge

[![CI](https://github.com/aoliaoduo/open-bridge-app/actions/workflows/ci.yml/badge.svg)](https://github.com/aoliaoduo/open-bridge-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

在本机安全暴露工作区能力的独立 MCP 桥接：**一个 Node 进程，一个端口，同时提供 MCP 端点和 Web 控制台**。

源自 VS Code 扩展 Open Bridge（0.5.17 终版）的独立化演进——核心服务器、工具集、并发锁与鉴权模型原样继承，宿主从 VS Code 换成本机 CLI + 浏览器控制台。

```
ChatGPT 网页对话 / Claude / Cursor / 任意 MCP 客户端
        │  （经你掌控的 ngrok 隧道或局域网）
        ▼
  open-bridge serve  ── /mcp/<路由令牌>   Streamable HTTP MCP（54 个工具）
        │            ── /console/         Web 控制台（仅本机回环可访问）
        │            ── /api/*            控制台后端（回环 + 令牌头双门控）
        ▼
  你的项目工作区（文件、命令、进程、服务编排）
```

## 安装与启动

要求 Node.js ≥ 22（Node 20 已于 2026-03 结束维护，不再作为支持基线）。

```bash
npm install -g open-bridge

# 在项目目录启动（前台运行，Ctrl+C 停止）
cd your-project
open-bridge serve --no-tunnel        # 纯本地
open-bridge serve                    # 走 ngrok 隧道（需先配置域名）
```

启动后终端会打印：

```
  Web 控制台:  http://127.0.0.1:<端口>/console/
  本地 MCP URL: http://127.0.0.1:<端口>/mcp/<路由令牌>
  公网 MCP URL: https://<你的域名>.ngrok-free.dev/mcp/<路由令牌>
```

**MCP URL 本身就是凭证**（路由令牌即鉴权），把它填进 MCP 客户端即可。可选开启 Bearer 鉴权做第二道闸（控制台「令牌」页签发，明文只显示一次）。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]` | 前台启动 Bridge |
| `open-bridge stop` | 停止运行中的实例 |
| `open-bridge status` | 查看实例状态 |
| `open-bridge url` | 打印当前 MCP URL |
| `open-bridge config list / get KEY / set KEY VALUE / path` | 读写配置 |
| `open-bridge token create / list / revoke / delete / rotate` | 管理 Bearer 令牌 |
| `open-bridge doctor` | 环境诊断 |

## Web 控制台

浏览器打开 `http://127.0.0.1:<端口>/console/`：

- **状态**：MCP URL 复制、启动/停止/轮换端点、实时会话与锁
- **设置**：隧道域名、端口、Shell、文件访问白名单、工具集、并发锁——与 MCP `get_config` / `set_config_value` 共用一套校验
- **令牌**：创建/轮换/吊销/删除/清理，两步确认防误触，新令牌明文只在签发时显示一次
- **日志**：实时日志流（SSE），完整审计在数据目录 `audit.log`
- **统计**：调用计数、按工具分布、最近活动

安全边界（与扩展时代同一姿态，适配 HTTP 后更严）：

- `/api` 与 `/console` **只响应回环 Host**（`127.0.0.1`/`localhost`）——经 ngrok 公网域名访问一律 403，公网只暴露 `/mcp`
- 所有写操作要求 `X-Open-Bridge-Console` 头匹配路由令牌（页面由服务端注入；跨站页面既读不到也发不出，CSRF 无解）
- Bearer 鉴权默认关闭；开启后失败关闭（无有效令牌时全拒），操作员本机可随时在控制台关掉

## 数据目录

默认 `~/.open-bridge`（`OPEN_BRIDGE_HOME` 或 `--home` 可改）：

```
config.json     配置（config-defaults.ts 为 schema 单一事实源）
state.json      持久状态（服务定义 / 待办 / 用量计数）
secrets.json    路由令牌 + 哈希令牌记录（chmod 600，明文永不落盘）
audit.log       追加式审计日志（1 MiB 轮转）
logs/           Bridge 与服务日志
runtime.json    运行实例注册（pid / 端口，供 stop/status 使用）
```

## ngrok 隧道

1. 在 [ngrok 控制台](https://dashboard.ngrok.com/domains)预留一个免费域名
2. `open-bridge config set ngrokDomain example.ngrok-free.dev`（或控制台「设置」页）
3. `open-bridge serve` —— 隧道意外退出会自动重连（本地服务器与 MCP 会话保持存活，只重连隧道）

本机多实例共享隧道域名时自动形成 owner/follower 协调（peers 注册表），与扩展行为一致。

## 从 VS Code 扩展迁移

扩展 0.5.17 已封存为终版。独立版差异：

- 配置从 VS Code settings 迁到 `~/.open-bridge/config.json`（键名完全一致）
- 「工作区」概念变为 `serve` 时的 `--root`（默认当前目录）
- 编辑器专属工具（`lsp`、`get_diagnostics`）不在独立版提供——它们依赖语言服务器，`tools/list` 会自动过滤（直接调用会得到明确的降级提示，而不是"未知工具"）
- 工具定义共 56 个，与扩展逐字节一致；独立版对外暴露其中 54 个（文件/发现/补丁/进程/服务编排/网络探测/批处理/待办/统计）
- 内置 ripgrep 解析按平台自适应：Windows 用 `vendor/rg.exe`，其他平台找 `vendor/rg`，都没有就回退 PATH 上的 `rg`，最后回退内置扫描器——**功能不受影响**，只是大仓库搜索会慢一些

## 开发

```bash
npm install
npm run build        # tsc（core + CLI）+ vite（React 控制台）
npm test             # 单元测试 + API 集成测试
npm run dev -- serve --no-tunnel   # tsx 免编译直接跑
```

架构：`src/bridge|http|mcp|network|process|shell|workspace` 是零宿主依赖的核心；`src/host/` 是宿主抽象（Host 接口 + 文件版实现）；`src/server/` 是 API/控制台；`src/cli.ts` 是入口。任何宿主（Tauri 壳、甚至回归 VS Code 壳）只需实现一次 Host 接口。

## License

MIT © Open Bridge contributors
