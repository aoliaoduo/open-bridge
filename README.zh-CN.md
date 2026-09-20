# Open Bridge

**把本机的一个目录真正交给 ChatGPT、Claude、Cursor —— 文件、命令、进程，通过标准 MCP 端点。**

[![CI](https://github.com/aoliaoduo/open-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/aoliaoduo/open-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

[English](README.md) | 简体中文

一个 Node 进程、一个端口。不依赖编辑器、不是插件、没有 Web 框架。

```bash
npm ci                 # 在检出的本仓库中执行
npm run build
npm install -g .
cd 你的项目目录
open-bridge serve
```

它会打印一个 MCP URL。填进客户端，AI 就在那个目录里干活了。

```
Web 控制台:   http://127.0.0.1:18080/console/
本地 MCP URL: http://127.0.0.1:18080/mcp/<路由令牌>
公网 MCP URL: https://<你的域名>/mcp/<路由令牌>      ← 配置公网隧道后才有
```

> **这个 URL 就是钥匙。** 公网可达时，拿到它的人就能读写你的文件、执行命令。只在本机用就加 `--no-tunnel`；需要公网就去控制台「安全」页打开 Bearer 门禁。

---

## 为什么有这个东西

编辑器插件把 AI 绑在编辑器里，这个不会：桥就是一个普通 HTTP 服务，同一个工作区可以从浏览器标签页、手机或任何会说 MCP 的客户端访问。

- **39 个工具** —— 读写、打补丁、搜索、跑命令、托管长期进程、编排命名服务。
- **一个端点同时服务两代 MCP 协议**，按请求自动判断。老客户端不用改任何东西。
- **一个真的能用的控制台**（`/console/`）—— 会话、工具、日志、并发锁、体检、全部设置。不是状态页，是真的在上面操作。
- **需要你的时候它会说。** AI 卡住等你回答、或对话结束时，推手机（Bark）或在这台机器上放一段声音。

## 上手

第一天值得知道的三件事：

**工作区就是你启动它的那个目录。** 没有配置文件，没有下拉框。换个目录再跑一次，就是第二个互不干扰的实例。

**端口不固定，除非你指定。** 不带 `--port` 时每次随机取空闲端口，地址会变。`--port 18080` 可以钉住。

**关掉终端就停。** 那个窗口掌握着实例 —— 这也是控制台没有启动/停止按钮的原因。

Windows 下有 `start-open-bridge.cmd`：双击后输入要用的目录。若要固定启动**本项目**，请双击 `start-open-bridge-project.cmd`：它始终用本项目作工作区、每次构建后提供控制台（不自动打开浏览器），并固定使用 **8123** 端口。

其余的 —— 每条命令、每项设置、控制台各页、隧道、通知、数据目录 —— 都在 **[docs/configuration.md](docs/configuration.md)**。

## 接入客户端

```bash
open-bridge prompt      # 打印一段现成的接入提示词
```

粘给客户端即可，或者直接给它 MCP URL。只认标准授权流程的客户端，可以用 OAuth 2.1 + PKCE（默认关闭），见 [docs/configuration.md](docs/configuration.md#web-console)。

## 一段话讲清安全

`/api` 和 `/console` 只响应回环地址。公网提供令牌化的 MCP 与健康路由，启用 OAuth 时还提供授权和发现端点。Bearer 门禁**默认关闭**以兼容只接受 URL 的客户端；需要按客户端发放凭据时，可在安全页开启。应用不会偷偷缩减你的权限，但会把当前暴露等级（`local` / `public-open` / `public-authed`）明确写在 `status`、`health`、控制台和启动输出里。

威胁模型、三档暴露面的定义、以及**哪些事是刻意不锁的**，都在 [SECURITY.md](SECURITY.md)，漏洞也报到那里。

## 文档

| | |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | 命令、控制台、隧道、通知、数据目录、常见问题 |
| [docs/tools.md](docs/tools.md) | 39 个工具各自的准确行为 |
| [SECURITY.md](SECURITY.md) | 威胁模型与漏洞报告 |
| [AGENTS.md](https://github.com/aoliaoduo/open-bridge/blob/main/AGENTS.md) | 改这个仓库的约定 —— 提 PR 前先读 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前模块职责、执行路径与状态边界 |
| [Agent 协作流程](https://github.com/aoliaoduo/open-bridge/blob/main/docs/agent-collaboration-workflow.md) | 仓库协作、验证与交接 |
| [CHANGELOG.md](CHANGELOG.md) | 改了什么，以及为什么 |

## 开发

```bash
npm ci
npm run dev -- serve --no-tunnel   # 直接跑源码，不用先构建
npm run verify                     # typecheck + lint + build + 全部测试
```

提交前 `npm run verify` 必须全绿。集成测试是**真的**启动 `bin/open-bridge.js` 走 HTTP 的，所以**先构建再跑**，否则它报的是旧行为。

完整发布验证使用 `npm run release:check`，在全部检查之外核对 npm 实际打包清单。模块地图以 [ARCHITECTURE.md](ARCHITECTURE.md) 为准：核心依赖 `Host` 接口而不是具体宿主实现，但直接使用 Node 内置模块是正常的。运行时依赖为三个官方 MCP 包（v1 SDK、v2 server 与 Node adapter），不是 Web 框架；MCP、API 和控制台都直接挂在 `node:http` 上。

## License

MIT © Open Bridge contributors
