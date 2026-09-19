# Open Bridge 架构说明

> 本文描述当前独立版 Open Bridge 的运行边界、模块职责和关键约束。它面向维护者；日常配置请看 [配置与运维](docs/configuration.md)，逐项工具契约请看 [工具参考](docs/tools.md)。

## 1. 系统目标与边界

Open Bridge 是一个运行在用户本机的、独立的 Streamable HTTP MCP Bridge。它把经过认证的 AI 客户端连接到本地工作区能力，同时提供 CLI、Web 控制台、审计日志和可选的公网入口。

它负责：

- 暴露 MCP 工具（文件、搜索、命令、进程、任务、配置、日志等）；
- 在并发请求间执行资源锁、输入校验和审计；
- 管理本地配置、令牌、运行时记录和可选隧道；
- 提供本机控制台和有限的 Bark / 本地声音提醒。

它**不**是模型代理或任务调度器：模型推理、未通过 Bridge 发起的工具、外部进程的内部进度，对 Bridge 都可能不可见。因此任何“任务是否真正结束”的服务端判断都只能是保守启发式，而不是事实来源。

## 2. 总体结构

```text
AI client / MCP host
        │  Streamable HTTP + personal token / OAuth
        ▼
┌──────────────────────────────────────────────────────────┐
│ Open Bridge process                                       │
│                                                          │
│  HTTP server ── MCP endpoint ── tool catalog/executor    │
│       │                 │                 │              │
│       │                 │                 ├─ workspace   │
│       │                 │                 ├─ shell       │
│       │                 │                 ├─ processes   │
│       │                 │                 ├─ config      │
│       │                 │                 └─ audit/logs  │
│       │                 │                                │
│       ├─ console API ──┴─ shared settings/state          │
│       ├─ static console UI                                │
│       └─ lifecycle / tunnel / notification services       │
└──────────────────────────────────────────────────────────┘
        │                         │
        │ loopback                ├─ Bark / local sound (optional)
        ▼                         └─ ngrok or Tailscale Funnel (optional)
Browser console                         ▼
                                      remote MCP client
```

所有浏览器 API 请求使用相对路径，控制台不依赖浏览器访问 `localhost` 以外的后端；单进程内的 HTTP、MCP、控制台和生命周期状态共享同一个 host/state 层。

## 3. 源码模块

| 目录 / 文件 | 职责 |
| --- | --- |
| `src/cli.ts` | CLI 入口；解析 `serve`、`status`、`stop`、`token`、`config`、`doctor` 等命令。 |
| `src/host/` | 宿主抽象及本地持久化：配置、运行时记录、日志、进程标题和平台差异。核心层通过它访问环境。 |
| `src/server/` | HTTP 监听、路由、控制台 API、静态 UI 和安全响应边界。 |
| `src/mcp/` | Streamable HTTP MCP 协议接入、工具定义、输入 schema 和响应格式。 |
| `src/bridge/` | 会话/活动状态、工具执行、资源锁、审计、任务列表、通知和 MCP endpoint 编排。 |
| `src/workspace/` | 工作区文件、搜索、编辑、批处理、路径约束和内容处理。 |
| `src/shell/`、`src/process/` | 前台命令、长驻进程、交互、输出、超时与生命周期控制。 |
| `src/network/` | ngrok、Tailscale Funnel 等隧道的探测、启动、健康检查和清理。 |
| `ui/` | React/Vite 控制台源代码；产物由构建写入 `dist/ui/`。 |
| `test/` | 单元、协议、集成和 UI 测试；通知、认证、隧道和并发均有独立覆盖。 |
| `scripts/`、`bin/` | 构建清理、发布辅助和安装后的 CLI 启动器。 |

## 4. 请求和工具执行路径

1. 客户端向 `/mcp` 建立或继续 Streamable HTTP MCP 请求。
2. `src/server/` 完成来源、认证、请求大小和方法边界检查。
3. `src/mcp/` 将协议请求映射为由 `tool-definitions` 声明的工具调用。
4. `src/bridge/mcp-endpoint.ts` 建立执行上下文，记录活动，并调用统一的工具执行路径。
5. 执行前由资源锁根据文件、端口、进程或其他资源键进行串行化；互不冲突的调用可并行。
6. 工具模块完成工作，返回文本和（适用时）`structuredContent`；审计记录结果摘要、耗时和失败原因，但不记录密钥明文。
7. 结束时更新活动时钟和 in-flight 计数，再将协议响应写回客户端。

批处理和 todo 看板仍是 MCP 的一等能力；它们不通过额外的“行为教练”层改变工具结果或要求模型创建任务。

## 5. 状态、持久化与生命周期

### 进程内状态

`src/bridge/state.ts` 保存临时的会话、现代无状态请求活动、in-flight 计数、todo 和通知轮次。它只代表当前 Bridge 进程；重启会清空这类易失状态。

传统会话和现代 Streamable HTTP 请求的活动会被汇总为同一份“最近活动”快照。in-flight 请求被视为活动，活动时钟在请求结束时更新，避免把仍在服务的长请求当成静默。

### 本地持久化

宿主层在 Open Bridge 数据目录（默认 `~/.open-bridge`，可用 `OPEN_BRIDGE_HOME` 或 CLI 参数覆盖）保存配置、令牌、运行时记录和日志。写入采用校验、掩码和必要的跨进程合并策略；浏览器控制台和 `get_config` 只显示敏感值的掩码。

运行中的实例发布 runtime 记录，供 `open-bridge status`、`url` 和 `stop` 定位。服务停止、重绑或旋转端点时，响应会优先完成写回，再释放监听器，避免调用方收到“动作已成功但连接被重置”的假失败。

## 6. 安全模型

- MCP 入口支持个人令牌；兼容 OAuth 的认证路径也保留。
- 控制台页面可在本机安全地加载，但变更类 API 有独立的控制台令牌 / 来源边界，不把机密暴露进页面或普通读取接口。
- 工作区工具遵从允许目录和路径规范化规则，拒绝越界路径。
- 工具参数受 schema 与服务端校验双重约束；shell、进程、文件和网络操作均进入审计日志。
- Bark 设备密钥为单向配置：配置页、MCP 读取结果、审计与运行日志不回显其明文。
- 公网入口是显式可选能力；不开隧道时服务只在本机可达。

## 7. 通知架构与准确性边界

通知只有两个对外事件：

- `waiting`：模型已经提出阻塞性问题或选择，必须等待用户回答；
- `finished`：本轮工作真实完成，由模型显式作为最后动作发送。

每个活动轮次最多对外提醒一次。Bark 固定采用时效性、持续响铃的单次投递；普通工具活动恢复后才打开新轮次。普通进度、todo 更新和命令输出不会推送手机。

为覆盖模型遗漏显式 `finished` 的情况，服务端保留一次兜底，但阈值固定为**连续十分钟没有 Bridge 可观察活动**且不存在 in-flight MCP 请求。该兜底不会重复发送。它并不声称准确检测了 AI 的真实停止：模型思考、外部工具或未被 Bridge 包装的长任务仍可能不可见。因此正确的结束信号始终优先是显式 `notify(event:"finished")`。

## 8. 配置、工具档和控制台

配置只有一个共享真源：控制台设置页和 MCP 的 `get_config` / `set_config_value` 使用同一验证模型。常用领域包括网络与隧道、文件范围、shell、通知、锁和日志。

工具目录默认使用 `full` 档，另保留 `core` 档给只需要基础能力的部署。`core` 是可选收缩档，不改变 `full` 的默认能力，也不删除 todo、批处理或其他完整工具能力。

控制台提供状态、设置、令牌、日志、会话和工具等页面。它是管理界面，不是 MCP 执行逻辑的第二套实现；所有有副作用的操作最终回到同一宿主、bridge 或 server 服务。

## 9. 网络与隧道

本地监听器是服务的基础；端口可由 CLI/配置决定。项目专用的 Windows 启动器 `start-open-bridge-project.cmd` 固定从项目根目录启动并使用端口 `8123`，且不自动打开浏览器。

可选公网能力由网络层管理：

- **ngrok**：按进程生命周期启动、健康检查和重连；明确的配置错误不会无限重试或发布不可用 URL。
- **Tailscale Funnel**：保留为独立提供商能力，不因控制台或精简档而移除。

隧道 URL 仅在端点真实健康后发布；停止或失败会清除失效公开地址。

## 10. 构建、测试和发布

```bash
npm run typecheck   # TypeScript（服务端和 UI）
npm run lint        # ESLint
npm run build       # 清理旧产物，编译 src，并构建 ui 到 dist/ui
npm test            # 核心、协议、集成与 UI 测试
npm run verify      # typecheck + lint + build + test
```

运行中的 Node 进程不会自动加载新的 `dist`。修改服务端或 UI 后，应先构建，再重启 Bridge。启动器会在启动前构建，适合本项目的日常 Windows 使用。

## 11. 维护原则

1. **一个真源**：协议、控制台和 CLI 对同一配置和生命周期事实达成一致。
2. **先安全、后便利**：本地默认、显式公开、秘密不回显、失败可诊断。
3. **工具结果是契约**：不要在工具结果中注入隐藏的行为教练、todo 催促或改变 schema 的副作用。
4. **异步动作必须诚实**：网络、隧道、停止、重绑和通知都要区分“已请求”与“已送达/已完成”。
5. **启发式必须标明边界**：尤其是活动和结束判断；不要把不可观察的 AI 行为伪装成确定事实。
6. **先测试再扩展**：涉及协议、认证、持久化、并发或公开网络时，同时覆盖成功、失败、重试和清理路径。

## 12. 快速排障入口

- 配置、目录、隧道、令牌：[`docs/configuration.md`](docs/configuration.md)
- MCP 工具、参数和通知使用规则：[`docs/tools.md`](docs/tools.md)
- 变更摘要：[`CHANGELOG.md`](CHANGELOG.md)
- 运行状况：`open-bridge status`、`open-bridge doctor`，或控制台的状态/日志页。
