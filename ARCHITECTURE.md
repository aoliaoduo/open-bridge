# Open Bridge 架构说明

本文描述当前源码的职责边界。运行配置见 [配置与运维](docs/configuration.md)，工具契约见 [工具参考](docs/tools.md)；历史设计过程保留在 Git 历史，不作为未完成任务清单。

## 1. 产品边界

Open Bridge 是用户主动启动的本地工作区 MCP 服务：一个 Node 进程提供 CLI、Streamable HTTP MCP、Web 控制台、审计和可选公网隧道。

AI 客户端负责推理、选择工具与编排工作；Bridge 负责真实执行、结果契约、资源锁和可观察状态。它不是模型代理、Agent 调度平台或命令沙箱，也不会根据工具的 `readOnlyHint` / `destructiveHint` 自动增加确认步骤。

## 2. 当前模块地图

| 位置 | 实际职责 |
| --- | --- |
| `src/cli.ts`、`src/cli/` | CLI 入口、参数、实例定位、检查和本地管理命令。 |
| `src/host/host.ts` | 唯一的宿主接口：配置、持久化、日志、UI 通知等共享能力。 |
| `src/host/node-host.ts` | 文件版宿主实现；仅由 CLI 和控制台 API 安装或访问具体实现。 |
| `src/bridge/http-listener.ts` | HTTP 监听、Host/CORS/认证边界、健康路由、对等转发，以及两代 MCP 请求分流。 |
| `src/bridge/mcp-endpoint.ts` | 两代 MCP 的发现/初始化、说明注入、工具调用适配及共享结果构造。 |
| `src/bridge/tool-catalog.ts`、`src/bridge/tool-families.ts` | 工具档过滤、规范工具名和兼容别名归一化。 |
| `src/bridge/dispatcher.ts`、`src/bridge/lock-plan.ts` | 调用分发、输入检查、资源锁计划、审计和统计。 |
| `src/bridge/` 的工具与生命周期模块 | 文件/进程/服务/脚本工具执行，会话、任务、通知、隧道和启停编排。 |
| `src/mcp/` | 工具 schema，以及 glob、搜索、流式读取、补丁、diff 等算法；不是 HTTP 协议入口。 |
| `src/http/` | 个人令牌与 OAuth、请求体/响应、安全策略和对等实例通信。 |
| `src/workspace/` | 工作区上下文、路径、换行、文件版本和持久化辅助。 |
| `src/shell/`、`src/process/` | Shell 选择/参数/标记，以及进程输出缓冲、游标、ANSI 和捕获；工具入口在 `src/bridge/`。 |
| `src/network/` | 安全网络探测与网络/ngrok 错误分类；隧道生命周期在 `src/bridge/`。 |
| `src/server/` | 本机控制台 API、设置处理与静态 UI 路由。 |
| `ui/src/` | React 控制台及其 UI 测试；Vite 产物进入 `dist/ui/`。 |
| `test/` | 核心单元测试和会启动真实进程的协议/集成测试，不包含 UI 测试。 |
| `scripts/`、`bin/` | 构建清理、npm 发布清单检查和安装后的 CLI 启动器。 |

“核心只依赖 Host 接口”不等于“核心不能使用 Node 内置模块”。文件、Shell 和网络工具本来就直接使用 Node 能力；不要为消除这些依赖增加第二套宿主抽象。

## 3. 请求与结果路径

1. 客户端访问 `/mcp/<route-token>`。监听器检查 Host、可选认证和请求边界；`/api`、`/console` 由独立的本机路由处理。
2. 2025 世代使用 SDK v1 的 `initialize` / session / SSE 路径；2026-07-28 世代使用 SDK v2 的无状态发现与请求路径。按请求分类，每代只有一个处理者。
3. 两条路径共用工具目录、执行入口和结果构造。`tools/list` 只公布规范名称；旧别名仍归一到同一实现，不是待删除的死代码。
4. 分发器校验参数并按文件、进程、端口或显式资源键申请锁；互不冲突的调用可以并行。
5. 工具返回文本和类型化的 `structuredContent`。数组型兼容文本可对应 `{items: [...]}` 类型化载荷；工具错误、部分行失败和命令非零退出码不是同一件事。
6. 审计、统计和 in-flight 状态随调用更新。`batch` 与 `run_script` 子调用也走真实执行路径，不绕过锁、权限或审计。

发现/初始化时发送项目说明；`tools/list` 时发送工具目录。普通工具调用不会重复附带整份说明或目录。客户端怎样放入模型上下文不由 Bridge 决定。

## 4. 状态、存储与生命周期

- 进程内保存会话、受监管进程、in-flight 请求、通知轮次等状态；不要把内存状态当成重启后仍存在的记录。
- 数据目录默认 `~/.open-bridge`，可由 `OPEN_BRIDGE_HOME` 或 `--home` 改变。`config.json` 保存配置；`state.json` 保存服务定义、任务和统计；`secrets.json` 保存工作区路由令牌及个人令牌的哈希记录。
- 路由令牌由随机字节生成并按工作区持久化，不是从路径直接推导出来的令牌。工作区路径用于存储键和 runtime 文件的后缀。
- `runtime-<suffix>.json` 用于定位实例，`bridge-peers.json` 用于同机隧道共享。审计在 `audit.log`，Bridge 日志在 `logs/bridge.log`，服务日志默认在 `service-logs/`，详见配置参考。
- 只保存服务定义，不把旧的 `command_id` 当成新进程。前台命令等待超时不会杀进程，客户端应沿返回的 id 继续读取或等待。
- 构建不会热更新运行中的 Node 进程。`bridge_status` 的 `build_stale` 是判断是否仍在运行旧构建的依据。

## 5. 安全与网络边界

- 默认监听回环地址；公网隧道显式可选。公网可提供令牌化 MCP 和健康路由；启用 OAuth 时还有授权与发现端点，并非“只公开 `/mcp`”。
- `/api` 与 `/console` 是本机管理面，不向跨来源网页开放 CORS；变更 API 还要求控制台令牌头。
- Bearer 门禁和 OAuth 默认关闭。公开模式下应把完整 MCP URL 当作访问凭据保护；开启认证是操作者的选择，不在清理或升级中自动改变。
- `unrestrictedFileAccess` 默认开启：工作区固定相对路径的含义，但不是文件系统沙箱。关闭该设置时才按允许目录限制访问；删除/移动工作区根、数据目录或盘根的自毁护栏另行存在。
- 密钥掩码、路径保护、运行时守卫和兼容输入不能因为“看起来多余”而删除。完整威胁模型见 [SECURITY.md](SECURITY.md)。

隧道由 `src/bridge/` 管理：ngrok 使用受监管子进程，Tailscale Funnel 使用本机守护进程；实例可以通过共享注册表跟随同机隧道持有者。两种提供商的生命周期并不相同，不能用一次返回的成功布尔值替代实际健康状态。

## 6. 通知与控制台

`notify` 只有 `waiting` 和 `finished` 两个事件。每轮最多一次 Bark/本机声音提醒；普通工具活动恢复后才开启新轮次，进度和 todo 更新不直接通知手机。

遗漏显式结束通知时，兜底只在连续十分钟无 Bridge 可观察活动、且没有 in-flight MCP 请求后触发一次。这是启发式，不证明模型或外部任务已经结束。

控制台通过相对 URL 调用同一进程的 API，和 CLI、MCP 共用配置与状态，不另行实现工具逻辑。默认 `full` 工具档和可选 `core` 子集由 `src/bridge/tool-catalog.ts` 决定。

## 7. 构建、验证与维护

```bash
npm ci
npm run typecheck       # 核心和 UI 类型检查
npm run lint
npm run build           # 清理产物，编译核心并构建控制台
npm test                # 核心、协议、集成和 UI
npm run release:check   # verify 全流程 + npm 实际打包清单检查
```

集成测试启动 `bin/open-bridge.js` 并读取 `dist/`，所以必须先构建。源码、测试和 UI 测试的放置约定见仓库的 `AGENTS.md`；一批修改完成后还需审阅差异、检查工作树并只提交相关文件。

Windows 项目启动器 `start-open-bridge-project.cmd` 从项目目录构建并启动，固定端口 `8123`，不自动打开浏览器。重启后先确认 `state: "running"` 与 `build_stale: false`，再做与改动对应的真实 MCP 验证；源码测试通过不能代替这一步。

维护时优先保持一个配置/契约真源、最小直接的改动、可恢复且诚实的异步结果。不要恢复行为教练层，也不要把已完成的迁移报告当成新的待办任务。
