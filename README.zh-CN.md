# Open Bridge

<div align="center">

**让 ChatGPT、Claude 或其他远程 MCP 客户端，受控地访问你机器上的真实工作区。**

文件、命令、长期进程、服务和自动化能力，通过一个标准 MCP 端点暴露。

[![CI](https://github.com/aoliaoduo/open-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/aoliaoduo/open-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

[English](README.md) · **简体中文**

[快速开始](#快速开始) · [核心能力](#核心能力) · [Windows](#windows) · [安全](#安全) · [文档](#文档)

</div>

---

## Open Bridge 是什么？

Open Bridge 是一个独立 MCP Bridge，让远程 AI 客户端直接操作你机器上的真实项目目录。

在一个目录里启动它，这个目录就能通过 MCP 提供给 AI 客户端使用。最常见的连接方式是通过 ngrok 或 Tailscale Funnel 发布公网 HTTPS 地址；`--no-tunnel` 更适合本机开发或明确不需要远程访问的场景。

```text
ChatGPT / Claude / 远程 MCP 客户端
                    │
               HTTPS + MCP
                    ▼
          ngrok / Tailscale Funnel
                    │
             转发到本机回环
                    ▼
             Open Bridge
            一个 Node 进程
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
      文件         命令          进程
        │           │            │
        └───────────┼────────────┘
                    ▼
                 你的工作区

          Web 控制台只在本机：
       会话 · 日志 · 健康状态 · 设置
```

一个进程、一个端口。不依赖 Web 框架，不把工作流绑死在编辑器里。

## 快速开始

从本仓库检出目录开始：

```bash
npm ci
npm run build
npm install -g .

cd 你的项目目录
open-bridge serve
```

Open Bridge 会打印一个 MCP URL。把这个 URL 配到 MCP 客户端，客户端就连接到了你启动它时所在的目录。

典型地址：

```text
公网 MCP URL: https://<你的域名>/mcp/<路由令牌>          ← 常规客户端连接
Web 控制台:   http://127.0.0.1:18080/console/             ← 本机管理
本地 MCP URL: http://127.0.0.1:18080/mcp/<路由令牌>      ← 本机 / 调试使用
```

> **把 MCP URL 当成凭据。** 常规远程使用会通过 ngrok 或 Tailscale Funnel 发布公网 MCP 地址，因此要保护完整 URL。客户端支持凭据时，可以在控制台 **安全** 页开启 Bearer 门禁或 OAuth。

最常见的远程流程是：启动后打开 Web 控制台，在 **设置 → 隧道 → 一键自动配置** 中发布公网地址。第一次用 ngrok / Tailscale 时，直接照 **[公网隧道小白教程](docs/tunnels.md)** 操作。需要固定本地监听端口时：

```bash
open-bridge serve --port 18080
```

只用于本机开发、或明确不希望远程访问时：

```bash
open-bridge serve --no-tunnel
```

## 核心能力

| 能力 | 作用 |
| --- | --- |
| **完整 MCP 工具集** | 读写文件、补丁、搜索、执行命令、托管进程、管理服务、查看活动，并通过 `run_script` 组合多步工作。 |
| **现代 + 兼容 MCP** | 两代 MCP 协议共用同一个端点，按请求自动选择；旧客户端不需要再开一套服务。 |
| **真实进程托管** | 长期命令有 ID、输出缓冲、生命周期控制、重启策略和清理语义。 |
| **命名服务** | 为工作区定义可复用服务，管理健康检查、日志、端口和重启行为。 |
| **Web 控制台** | 会话、工具、日志、资源锁、健康状态、暴露面、隧道、OAuth、令牌、通知和设置。 |
| **OAuth 2.1 + PKCE** | 为支持标准授权流程的客户端提供可选 OAuth 接入。 |
| **Bearer 门禁** | 为能携带凭据的客户端单独签发、轮换和吊销令牌。 |
| **公网 HTTPS 隧道** | 主要远程连接方式：集成 ngrok 与 Tailscale Funnel，包含环境检测、健康检查、ownership 和自动重连。 |
| **Code Mode** | `run_script` 在隔离的 Worker/VM sandbox 中组合 Bridge 工具，减少往返，并只返回真正需要的数据。 |
| **操作员通知** | AI 等待回答或对话结束时，可通过 Bark 推送或本机声音提醒。 |
| **可审计运行** | 活动历史、调用统计、日志、暴露等级、诊断信息和资源锁都可查看。 |

## 工作区如何运行

日常使用只需要记住三个规则。

### 当前目录就是工作区

在项目目录里启动：

```bash
cd my-project
open-bridge serve
```

这个目录就是项目根目录。换一个目录启动另一个实例，就得到另一个互相独立的工作区。

### 端口默认动态选择

不传 `--port` 时会选择可用端口。需要稳定地址时指定固定端口：

```bash
open-bridge serve --port 18080
```

### 本机操作者拥有这个实例

有可见 TUI 时，按 **Ctrl+C** 或关闭承载它的终端即可停止实例。若当前只有 Web 控制台可见，可在 **状态 → 关闭 Bridge** 中执行同一套优雅关闭。

完整命令和配置说明见 **[docs/configuration.md](docs/configuration.md)**。

## Windows

Windows 推荐使用资源管理器右键菜单：

```bash
open-bridge explorer install
```

安装后，在文件夹本身或文件夹空白处右键 **在此启动 Open Bridge**。

这个启动链路会：

- 直接把工作区交给 Node，不把用户路径拼进 PowerShell 或 `cmd.exe` 源码；
- 已有实例时直接复用，不重复启动；
- 新实例会在 Windows Terminal 中打开**可见 TUI**；
- 同一工作区已经运行时，再次右键会打开现有 Web 控制台；
- Windows Terminal 不可用时会改为打开 Web 控制台，不会留下“后台已启动但什么都看不到”的实例；状态页可以直接关闭这个 Bridge；
- 只写当前用户的 `HKCU\Software\Classes`，不需要管理员权限。

卸载：

```bash
open-bridge explorer uninstall
```

<details>
<summary><strong>Windows 启动器与兼容说明</strong></summary>

Windows 11 可能把这个经典 shell 菜单放在 **显示更多选项** 中。

旧的 PowerShell 安装/卸载脚本继续保留为兼容 wrapper，实际仍委托给同一个 Node/TypeScript CLI。

`scripts/start-open-bridge.cmd` 与 `scripts/start-open-bridge-project.cmd` 现在刻意保持为很薄的双击 bootstrap。目录选择、上次目录持久化、构建/启动策略以及本仓库固定的 **8123** 开发端口，都由 Node/TypeScript 处理。项目启动器会对生产构建输入计算内容指纹；只要当前源码与上次 launcher build 后记录的指纹不完全一致，就会先重新构建再启动。

通用 `.cmd` 刻意不再接收 workspace/flag 参数，因为 `cmd.exe` 会在批处理逻辑有机会保护之前先展开合法路径里的字面 `%NAME%`。自动化应直接调用 CLI：

```bash
open-bridge launch --root DIR
```

源码仓库本身不会自动把 `open-bridge` 安装成全局命令。如果 PowerShell 提示“无法识别 open-bridge”，请从仓库里直接调用入口：

```powershell
node .\bin\open-bridge.js instances
node .\bin\open-bridge.js stop --pid 12345
```

如果当前不在仓库目录，就把 `bin\open-bridge.js` 换成绝对路径。

</details>

## 接入客户端

Open Bridge 把“传输地址”和“工作提示词”分开管理。

获取 MCP URL：

```bash
open-bridge url
```

获取工作提示词：

```bash
open-bridge prompt
```

先在 MCP 客户端里配置 URL 并连接，再把提示词交给客户端。

只接受标准授权流程的客户端可以使用 OAuth 2.1 + PKCE。OAuth 默认关闭，配置方法见 [docs/configuration.md](docs/configuration.md#web-console)。

## 安全

Open Bridge 刻意暴露的是强能力，因此安全边界选择“明确告诉你”，而不是偷偷隐藏。

- `/api` 和 `/console` 只响应回环地址。
- 公网访问使用带路由令牌的 MCP 路径。
- 只有启用 OAuth 时才开放 OAuth discovery / authorization 路由。
- Bearer 门禁默认关闭，以兼容只能配置 URL 的客户端。
- 当前暴露等级会明确显示为 `local`、`public-open` 或 `public-authed`，并出现在 status、health、启动输出和控制台里。
- 文件与进程操作继承运行 Open Bridge 的当前用户权限。

准备暴露到公网前，建议先读 **[SECURITY.md](SECURITY.md)**。其中说明了威胁模型、三种暴露等级、刻意不做的安全限制，以及漏洞报告方式。

## 架构

Open Bridge 是模块化 Node.js 应用，不是套在 Web 框架里的服务器。

```text
CLI / TUI / Web 控制台
          │
          ▼
      Bridge 子系统
 tools · runtime · sessions
 tunnel · auth · lifecycle
          │
          ▼
       明确外部边界
 文件系统 · 进程 · 网络
 Windows adapter · MCP transport
```

设计原则：

- 优先模块化单体，而不是拆服务；
- 优先真实子系统边界，而不是为了分层制造 framework layer；
- 只有真实外部边界才使用 Ports & Adapters；
- 启动进程优先结构化 argv/cwd/env，而不是字符串拼 shell；
- 迁移期间允许行为保持不变的兼容 facade；
- 对不允许回退的架构边界使用架构测试保护。

当前模块地图见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](docs/README.md) | 文档中心与各主题正本索引 |
| [docs/tunnels.md](docs/tunnels.md) | ngrok / Tailscale Funnel 小白入门教程 |
| [docs/configuration.md](docs/configuration.md) | CLI 命令、控制台、隧道、通知、数据目录、FAQ |
| [docs/tools.md](docs/tools.md) | 完整工具参考与准确行为 |
| [SECURITY.md](SECURITY.md) | 威胁模型、暴露等级、漏洞报告 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 模块职责、执行路径、状态和安全边界 |
| [docs/observability.md](docs/observability.md) | 诊断、数据目录工件、日志与脱敏导出 |
| [AGENTS.md](AGENTS.md) | 本仓库工程约定 |
| [docs/agent-collaboration-workflow.md](docs/agent-collaboration-workflow.md) | 验证、协作与交接流程 |
| [CHANGELOG.md](CHANGELOG.md) | 用户可见变化及原因 |

## 开发

```bash
npm ci
npm run dev -- serve --no-tunnel
npm run verify
```

常用检查：

```bash
npm run check:fast      # 安全检查 + typecheck + lint + unit/UI tests
npm run verify          # build + 完整测试
npm run package:check   # 检查 npm 实际打包内容
npm run release:check   # 完整发布前检查
```

集成测试会真正启动构建后的 `bin/open-bridge.js` 并走 HTTP，所以源码修改后执行集成测试前要先重建 `dist`。

运行时依赖主要是所支持 MCP 协议代际和 Node transport 所需的官方 MCP 包。MCP、API、OAuth 和控制台路由都直接挂在 `node:http` 上。

## License

MIT © Open Bridge contributors
