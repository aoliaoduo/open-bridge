# Open Bridge

[![CI](https://github.com/aoliaoduo/open-bridge-app/actions/workflows/ci.yml/badge.svg)](https://github.com/aoliaoduo/open-bridge-app/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

把本机的文件、命令、进程和服务，变成一个标准的 MCP 端点，交给 ChatGPT 网页版 / Claude / Cursor 这类 AI 客户端直接调用。

**一个 Node 进程，一个端口，同时提供 MCP 端点和网页控制台。**

源自 VS Code 扩展 Open Bridge（0.5.17 终版）的独立化演进：核心服务器、工具集、并发锁与鉴权模型原样继承，宿主从 VS Code 换成本机 CLI + 浏览器控制台。

```
ChatGPT 网页对话 / Claude / Cursor / 任意 MCP 客户端
        │  （经你掌控的 ngrok 隧道，或只在局域网/本机）
        ▼
  open-bridge serve  ── /mcp/<路由令牌>   Streamable HTTP MCP（54 个工具，两代协议同端点）
        │            ── /console/         Web 控制台（仅本机回环可访问）
        │            ── /api/*            控制台后端（回环 + 令牌头双门控）
        ▼
  你所在目录的那个工作区（文件、命令、进程、服务编排）
```

### 一个端点，两代协议

`/mcp/<路由令牌>` 同时服务 **2026-07-28** 的「按请求」协议和 **2025 世代**的会话式协议，
**由请求自身决定走哪条**——没有开关要配，也没有模式要选：

| | 2026-07-28（现代） | 2025 世代（旧版） |
| --- | --- | --- |
| 握手 | 无 | `initialize` 换一个 session id |
| 每请求信封 | `params._meta` + `MCP-Protocol-Version` / `MCP-Method` / `MCP-Call-Name` 头 | 无 |
| 能力发现 | `server/discover` 回 `supportedVersions` | `initialize` 回 `protocolVersion` |
| 工具报错 | JSON-RPC error | JSON-RPC result 里的 `isError: true` |
| 断线续传 | 无（本来就没有会话） | `eventStore` + SSE 保活 |

两条路共用同一份工具清单、同一套用量计数与审计日志；差异只在上表这些地方。旧客户端
（Cursor、Claude Desktop、自建脚本……）不需要任何改动，会话表、锁与日志照旧。

工具另带 MCP 行为标注（`readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint`）。**这纯粹是给客户端和模型的信息，不是限制**：Bridge 不因此拒绝调用、
不裁剪工具，也不新增确认步骤。

---

## 30 秒上手

```bash
npm install -g .        # 在仓库目录里执行一次；之后任意目录都能用 open-bridge
cd 你的项目目录
open-bridge serve --open          # 或 --no-tunnel 只在本机用
```

终端会打印三个地址，浏览器会自动打开控制台：

```
  Web 控制台:   http://127.0.0.1:18080/console/
  本地 MCP URL: http://127.0.0.1:18080/mcp/<路由令牌>
  公网 MCP URL: https://<你的域名>/mcp/<路由令牌>      ← 配了 ngrok 才有

  接入 AI 客户端：open-bridge prompt  →  复制提示词，粘贴给客户端即可
```

把 **MCP URL** 填进客户端（或在客户端支持时直接把 `open-bridge prompt` 的输出粘过去），就通了。Ctrl+C 停止。

---

## 工作区 = 你所在的目录

这是独立版最省心的一点：**`open-bridge serve` 的工作区就是它被启动时的那个目录**，不用配置文件、不用下拉菜单。

```bash
cd C:\work\项目A
open-bridge serve --port 18080        # 这个实例服务「项目A」

cd C:\work\项目B
open-bridge serve                     # 另一个实例，服务「项目B」，互不干扰
```

- 两个实例可以**同时在线**，各有各的端口、路由令牌和运行记录；相对路径（`read_file("src/index.ts")`）永远以自己那个目录为基准。
- 一条命令看谁在跑：`open-bridge instances` —— 列出每个实例的 pid、端口、工作区，以及当前目录是哪一个。
- `stop` / `status` / `url` / `prompt` / `health` **默认作用于当前目录的那个实例**；当前目录没有实例、而整机只有唯一一个在跑时，会用它并在输出里注明；有多个而当前目录没有时，会提示你用 `instances` 挑清楚，绝不乱猜。
- 想覆盖默认行为用 `--root DIR`；换数据目录用 `--home DIR`。

> **端口**：不传 `--port` 时默认 `0`（每次启动随机分配一个空闲端口，地址会变）。想固定地址就显式指定 `--port 18080`。显式指定的端口被占用时会直接报错并给出替代命令；**配置里**的端口被占用时，会自动改用空闲端口并打印提示。同一个目录重复启动会被拒绝，并明确告诉你是哪个 pid 占着。

---

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `open-bridge serve [--port N] [--root DIR] [--home DIR] [--no-tunnel] [--open]` | 前台启动 Bridge（工作区 = 当前目录） |
| `open-bridge instances` | 列出共用同一数据目录的所有实例（别名 `list`） |
| `open-bridge status` | 状态、工作区、MCP URL、暴露情况 |
| `open-bridge health` | 体检：监听、工作区、隧道角色、暴露等级、工具数，并真连一次公网 |
| `open-bridge url` | 打印当前 MCP URL |
| `open-bridge prompt` | 打印「快速连接这个 MCP」接入提示词，直接粘给 AI 客户端 |
| `open-bridge logs [--tail N] [--follow] [--clear]` | 读 / 跟踪 / 清空日志 |
| `open-bridge stop` | 停止当前目录的实例 |
| `open-bridge config list / get KEY / set KEY VALUE / path` | 读写配置 |
| `open-bridge token create / list / revoke / delete / rotate` | 管理 Bearer 令牌 |
| `open-bridge doctor` | 环境诊断（含所有运行中实例） |
| `open-bridge version / help` | 版本与帮助 |

---

## Web 控制台

浏览器打开 `http://127.0.0.1:18080/console/`（端口随 `--port`）。每个页面都有自己的路径，
可以直接收藏、刷新、开第二个窗口，Ctrl+点击会在新标签页打开；顶栏下面一行会显示当前路径，
还放着「复制 MCP 地址 / 一键体检 / 刷新本页」三个快捷动作。

| 页面 | 路径 | 做什么 |
| --- | --- | --- |
| 状态 | `/console/status` | 工作区、MCP URL 复制、启动/停止/轮换端点、实时会话与锁；公网可达且未开鉴权时显示显式告警 |
| 会话 | `/console/sessions` | 谁在连我：客户端名（来自 MCP 握手）、空闲时长、进行中的请求、待办数，可单独**断开**；下面是正在持有的文件锁与等待者 |
| 工具 | `/console/tools` | 这台实例真正对外公布的 `tools/list`：按配置档与宿主能力过滤后的清单，核心工具高亮，可搜索 |
| 体检 | `/console/health` | 逐项检查实例/工作区/工具/隧道/暴露面，并真的穿过隧道请求一次 `/healthz` 验证公网连通；公网可达且未开鉴权时，这里能**一键开启第二道锁**（签发令牌 + 打开 Bearer，一步完成） |
| 服务 | `/console/services` | 保存/启动/停止/重启本机服务定义 |
| 日志 | `/console/logs` | 实时日志流（SSE），完整审计在数据目录 `audit.log` |
| 统计 | `/console/stats` | 调用计数、按工具分布、最近活动 |
| 令牌 | `/console/tokens` | 创建/轮换/吊销/删除/清理，两步确认防误触，明文只在签发时显示一次 |
| 设置 | `/console/settings` | 隧道域名、端口、Shell、文件访问白名单、工具集、并发锁——与 MCP `get_config` / `set_config_value` 共用一套校验 |

路径由前端路由决定（`ui/src/routes.ts`），服务端对任何 `/console/*` 都返回同一个页面并注入令牌，
所以加页面不需要动服务器。

### 安全边界（默认好用，需要时更严）
- `/api` 与 `/console` **只响应回环 Host**（`127.0.0.1` / `localhost`）——经 ngrok 公网域名访问一律 403，公网只暴露 `/mcp`
- 所有写操作要求 `X-Open-Bridge-Console` 头匹配路由令牌（页面由服务端注入；跨站页面既读不到也发不出）
- **Bearer 鉴权默认关闭**，因为「只填 URL」的客户端（如 ChatGPT 连接器）带不了自定义头，一开就全断。要开的话有两个入口：「令牌」页签发令牌后打开开关，或在「体检」页点**「开启第二道锁」**（签发 + 开启一步完成，已有令牌则复用，明文只在弹层显示一次）：无有效令牌时**失败关闭**（全拒），本机控制台随时能关掉，不会被自己锁死在门外
- **公网可达 = 拿到 URL 的人就能读写你的文件、执行命令**。应用不会偷偷限制你的权限，但会到处把这件事说出来：`status`、控制台、`health`、启动时的终端提示。想收紧就用令牌页开 Bearer，或直接 `--no-tunnel` 只在本机用

### OAuth 2.1（可选，默认关闭）

有些 MCP 客户端只认标准授权流程，不认「URL 里带令牌」。打开 OAuth 后，这类客户端可以
自己注册并按 OAuth 2.1 + PKCE 换取**属于它自己的**凭据：

```bash
open-bridge config set oauth.enabled true
```

或者用控制台设置页。打开后，客户端从 `/.well-known/oauth-protected-resource` 找到本机，
在 `/oauth/register` 动态注册，被引导到 `/oauth/authorize` 的授权页——**在那一页输入你的
路由令牌**（即控制台地址里的那串；也可以用 `OPEN_BRIDGE_OAUTH_OWNER` 换成别的口令）——
之后拿到 access + refresh token。

要点：

- **默认关闭。** 打开后 `/mcp` 需要 **OAuth 凭据**：只在地址里带路由令牌不再算数——能走标准流程的
  客户端会先收到 401 + `WWW-Authenticate`（这不是故障，正是它开始授权的信号），随后自己注册、按
  PKCE 换到**属于它自己、可单独吊销**的凭据。路径里的路由令牌是路由键而不是凭据，所以「只填 URL」
  从来不是一道锁；OAuth 打开后才第一次有了锁。
- **已经持有令牌的客户端不会断线。** `Authorization: Bearer <令牌>` 与 `?token=<令牌>` 照常通过，
  个人令牌门禁开不开都一样（这正是修过的一个洞：以前门禁关着时，OAuth 会抢在令牌校验之前拒绝）。
  只认 URL、又带不了头的客户端：给它一条 `?token=<令牌>` 的地址，或者别开 OAuth。
- **控制台能看、也能关。** 设置页的「OAuth 2.1」卡片就是那个开关，并列出已注册的客户端与在用凭据
  数量；本机控制台（`/api`、`/console`）只回环，随时关得掉，不会把自己锁在门外。
- **只支持 S256。** `plain` 一律拒绝——它是公开客户端（没有 client secret），PKCE 是唯一的持有证明。
- **`resource` 必填且必须是本机。** 否则这里签发的 token 可能被拿去打别的服务（RFC 8707）。
- **refresh 一次性轮换。** 用过的 refresh token 立刻失效，重放换不到新凭据。
- 授权页、注册与 token 端点**只**在公网暴露这些路径；`/api` 与 `/console` 依然只回环可访问。
- 控制台可以看已注册的客户端与在用凭据数量（`/api/oauth`），**不含任何密钥或摘要**。

---

## 公网隧道（ngrok）

只想本机/局域网用 → 加 `--no-tunnel`，完事，不需要 ngrok。

要让 ChatGPT 网页版这类外部客户端连进来：

```bash
open-bridge config set ngrokDomain <你预留的域名>.ngrok-free.dev
open-bridge serve --open          # 注意：不带 --no-tunnel
```

- 免费 ngrok 账号只分配一个子域，**同一域名同时只能被一个实例占用**。旧的 VS Code 扩展实例正占着也不必先停它：本机实例注册表（`bridge-peers.json`）是跨实例共享的——持有隧道的实例按令牌摘要查表并转发到对应实例。应用会把自己的那一行登记进**已存在**的注册表（不会在别人目录里凭空建文件），于是公网请求经那条隧道转发到应用，`tunnel_role` 显示 `follower`，控制台会注明这条地址依赖那个实例；持有方退出后，应用在下一轮探测里自己接管域名（变成 `owner`）。需要额外路径时用 `sharedPeerRegistry`。
- 抢域名这件事很谨慎：**只有 ngrok 明确回答"这个域名没人在用"时才认领**，超时/5xx 一律按"不知道"处理并继续观察。万一撞上 `ERR_NGROK_334`（域名已被别人占用），实例会老老实实只在本机服务，并持续观察那条隧道，一旦发现自己能被正常转发就自动切回 `follower`——不会把自己卡死，也不会起第二个 ngrok 去打架。
- 配置里没填域名、或域名写错 → 只会得到 `ERR_NGROK_313` 之类的明确报错，本地服务不受影响。

---

## 数据目录

默认 `~/.open-bridge`（`OPEN_BRIDGE_HOME` 或 `--home` 可改）：

```
config.json              配置（config-defaults.ts 是 schema 单一事实源）
state.json               持久状态（服务定义 / 待办 / 用量计数）
secrets.json             路由令牌 + 哈希令牌记录（明文永不落盘）
audit.log                追加式审计日志（1 MiB 轮转）
logs/bridge.log          Bridge 与服务日志（open-bridge logs 读它；默认 10 MiB 轮转到 bridge.log.1，`logMaxBytes` 可调，0 = 不轮转）
runtime-<后缀>.json      每个工作区一份运行记录（pid / 端口 / 根目录）
bridge-peers.json        本机实例注册表（多实例共享隧道用）
```

多个实例共享同一个数据目录：**配置、令牌、注册表是全局的**，**运行记录、路由令牌是按工作区分开的**（后缀 = 工作区路径的哈希前 24 位）。

> 从旧版本升级：旧的单一 `runtime.json` 仍会被读取——只有当它记录的根目录正是你要找的那个时才采用，避免把 A 目录的实例误当成 B 的。

---

## 常见问题

**端口被占用？**
`open-bridge instances` 看是不是已经有一个实例在跑；换端口 `--port 18081`，或先 `open-bridge stop`。

**公网地址打不开？**
`open-bridge health` 会真连一次公网并报 HTTP 状态与耗时。`tunnel_role: follower` 表示这条地址借用自另一个实例——那个实例退出后地址会变，应用会在能接管时接管。

**MCP 客户端报传输层错误（SSL EOF / 连接被重置 / 超时）？**
免费 ngrok 隧道偶尔会抖一下，等 5 秒重试一次即可；接入提示词里已经写了这句，客户端不需要额外配置。

**担心公网裸奔？**
`status` / `health` / 控制台都会明确告诉你当前暴露等级（`local` / `public-open` / `public-authed`）。要收紧就在控制台令牌页签发令牌并打开 Bearer 开关；不想暴露就直接 `--no-tunnel`。

**要不要装 VS Code 扩展？**
不需要。扩展 0.5.17 已封存为终版，独立版是主力。

---

## 开发

```bash
npm install
npm run build        # tsc（core + CLI）+ vite（React 控制台）
npm run verify       # typecheck + lint + build + 全部测试（单元 / 集成 / UI）
npm run dev -- serve --no-tunnel   # tsx 免编译直接跑
```

测试分层：`test/*.test.ts` 是单元测试；`test/*-integration.test.mjs` 会**真的启动 `bin/open-bridge.js` 并走 HTTP**（外壳、鉴权闸门、两代 MCP 协议、多实例），其中鉴权闸门与协议不变量两份套件是从扩展时代移植过来的——它们当初是用真实事故换来的断言。

架构：`src/bridge|http|mcp|network|process|shell|workspace` 是零宿主依赖的核心；`src/host/` 是宿主抽象（Host 接口 + 文件版实现）；`src/server/` 是 API/控制台；`src/cli.ts` 是入口。任何宿主（Tauri 壳、甚至回归 VS Code 壳）只需实现一次 Host 接口。

依赖：运行时只有 `@modelcontextprotocol/server` + `@modelcontextprotocol/node`（2.x，负责 2026-07-28 的按请求协议）与 `@modelcontextprotocol/sdk`（1.x，负责 2025 世代的会话式传输）。**没有任何 Web 框架**——`/mcp`、`/api`、`/console` 全部挂在 `node:http` 上。

---

## 与 VS Code 扩展的关系

独立版**在能力上继承扩展**（配置键名一一对应，工具定义逐字节一致：扩展 56 个定义，独立版对外暴露 54 个），并去掉只在编辑器里有意义的壳（webview HTML、命令面板、`autoStart` 等），把宿主换成 CLI + 浏览器控制台。

已经**强于扩展**的地方：

- 多实例：一个目录一个实例、共享一条隧道；扩展受限于"一个窗口一个 Bridge"
- 稳定性：重连链可取消（不再无限重试）、拆除时序有防 ECONNRESET 处理、域名认领绝不靠猜
- 可运维：`instances` / `logs` / `health` / `doctor`，以及 HTTP API 与 9 个页面的控制台（每页一个路径）

刻意**不做**的三件事：

- **运行时切换工作区**（扩展的 `switchWorkspace`）：改成"第二个目录 = 第二个实例"，比在跑着的实例里换根更干净
- **把进程输出镜像进真实终端**（扩展的 `visible=true`）：独立进程弹系统窗口太打扰；输出一律走 `read_process_output` 按需读
- **编辑器专属工具**（`lsp`、`get_diagnostics`）：依赖语言服务器，独立版没有就不假装有，`tools/list` 会自动过滤，直接调用会得到明确的降级说明

## License

MIT © Open Bridge contributors
