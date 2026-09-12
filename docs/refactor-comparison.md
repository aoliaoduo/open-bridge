# 三项目对比与取舍报告

> 对象：`DesktopCommanderMCP`、`devspace`、`taskquay`（均在 `C:\Users\aolia\Desktop\codex\GitHub\`）
> 基准：本项目 **open-bridge-app**（工作区 = 当前目录）
> 结论日期：本轮调研
> **本报告只做判断，不改代码。** 所有结论都能被下面的命令复现；凡未能实证的都标注为「未确认」。

---

## 0.0 审计修正（第 2 轮，2026-09-11）

本节记录审计对本文档结论的修正，避免「文档说 A、代码做 B」继续共存。

1. **「OAuth 作为第二把钥匙与路由令牌并存，不是门槛」——与实现不符，已按实现改正。**
   `authorizeRequest` 在 `oauth.enabled=true` 且个人令牌门禁关闭时直接按 OAuth 判定：`/mcp/<路由令牌>`
   上只带 URL 的请求一律 401。两条路只能选一条，而「放行只带 URL 的请求」会让 OAuth 彻底失去门槛意义
   ——能走到这个闸门的请求**必然**带着正确的路由令牌（`lifecycle.ts` 先按路径匹配），所以放行等于全放行。
   结论：**OAuth 是一道独立的门**，打开后 `/mcp` 需要 OAuth 凭据；「URL 即凭据」这个前提本身不成立
   （`bearerFrom` 只读 `Authorization` 头与 `?token=` 查询串，从不读路径）。
2. **真正的缺陷是另一件事：出示了令牌的客户端被断线。** 个人令牌门禁关着时，OAuth 会抢在令牌校验之前
   拒绝，于是 `Authorization: Bearer <个人令牌>` 与 `?token=<个人令牌>` 客户端在打开 OAuth 的瞬间全挂
   ——这正是 README「不会让原来用路由令牌或 Bearer 令牌的客户端断线」所承诺的。已修：只要请求出示了
   凭据就继续校验（门禁开不开都校验），并且 401 上带 `WWW-Authenticate`，让过期客户端能改走 OAuth。
3. **控制台缺的那一半也补齐了。** `oauth.enabled` 此前只能在设置页之外改，`/api/oauth` 也没有任何界面
   消费；现在设置页有「OAuth 2.1」卡片（开关 + 回调主机白名单 + 已注册客户端/在用凭据数量）。

---

## 0.1 执行进度（本报告发布后的落地情况）

按调整后的顺序（**先可达性、后凭据管理**——目标用户是「所有支持 MCP 的网页 AI」，不限 ChatGPT）已完成：

| 项 | 状态 | 证据 |
| --- | --- | --- |
| **P0 窃锁缺陷**（§2.6） | ✅ **已修** | `LockRelease.handOff()` 在移交时只关定时器不释放锁；回归测试 `test/resource-locks.test.ts` 两条（移交后不被回收 / 未移交仍被回收） |
| **P1 双协议 `/mcp`**（§2.4） | ✅ **已落地** | `classifyInboundRequest` 按请求分流；现代路走 `createMcpHandler` + `legacy:"reject"`；`server/discover` 实测返回 `supportedVersions: ["2026-07-28"]`；新增 `test/mcp-modern-protocol-integration.test.mjs`（9 项） |
| **P2a 鉴权 O(1)**（§2.7） | ✅ **已修** | digest 索引 + 按存储原文失效的解析缓存；`AuthFailureLimiter` 去掉排序；跨进程吊销测试仍通过 |
| **P3a 行为标注**（§5 P2 第 13 条） | ✅ **已落地** | `src/bridge/tool-annotations.ts`，58 个定义齐备，**只告知不阻断**（新增测试断言非只读工具仍可无确认执行） |
| **P3b-1 关闭式进度词表** | ✅ **已落地** | `src/bridge/progress-vocabulary.ts`：`phase` / `category` 词表外的值**丢弃而非归默认**，运行时 `Object.freeze`（测试 `test/progress-vocabulary.test.ts`） |
| **P3b-2 按请求可观测性** | ✅ **已落地** | `src/bridge/request-trace.ts`：方法白名单、session/tool 哈希、错误指纹 + 160 字符单行摘要、用 `close` 抓客户端中断；集成测试断言工具名不进日志 |
| **P3b-3 优雅停机可观测** | ✅ **已落地** | 停机按阶段记录（开始 / 排空 N 个会话 / 宽限期到 / 完成），空闲停机仍只有一行 |
| **P2b OAuth 2.1**（§2.3） | ✅ **已落地** | 见下方「OAuth 的最终取舍与实现」 |
| **D9 skills 发现**（§3.1） | ✅ **已落地**（2026-09-12） | `src/bridge/skills.ts`（只读、有界、索引优先）+ `list_skills` 工具 + 说明注入；`test/skills.test.ts` 12 条 + `test/skills-integration.test.mjs` 5 条；对照现状见 `docs/comparison-status-2026-09-12.md` |
| **P3b-4 结构化错误** | ⏸ **主动降级** | 见下方「为什么结构化错误被降级」 |
| P4 幂等键 / 长轮询 / skills / 用量四态 | ⏸ 未做 | 需要真实消费者，暂不引入 |

### 实测修正了报告中的两处判断

1. **§2.1 的「未确认」已否证。** 实跑 v2 的 `server/discover` 返回 `supportedVersions: ["2026-07-28"]`——`LATEST_PROTOCOL_VERSION = "2025-11-25"` 那个常量并不是对外宣称的版本。所以「v2 到底支不支持 2026-07-28」不再是风险。
2. **现代路要求头体一致。** `tools/call` 必须同时带 `MCP-Call-Name`（即 `Mcp-Name`）头并与 `params.name` 一致，否则拒绝：`the body carries params.name="…" but the required Mcp-Name header is absent`。这是协议自身的防走私规则，不是我们的限制。

### 与任务书措辞的一处偏离（有意，且更稳）

任务书写的是 `createMcpHandler + legacy:"stateless"`。**实际用的是 `legacy:"reject"` + 先分类再分流**，原因有二：

1. `legacy:"stateless"` 会让 v2 **同时**服务旧客户端，于是同一个旧客户端可能被两条路处理——而我们的旧路是有状态的（会话表、`eventStore` 断线续传、15 s SSE 保活），v2 的无状态旧路没有这些。两条路都在服务同一类客户端，行为就会取决于谁先抢到请求。
2. 我们的 `StreamableHTTPServerTransport` 在 `--port 0` 时依赖 `runtime.json` 里已绑定的端口重新绑定；让 v2 也接管旧流量，等于把已经验证过的会话路径变成一条并行分支。

现在的形状是：`classifyInboundRequest`（v2 自己的判定器）决定时代，**每个时代恰好一个所有者**——现代走 v2 handler，旧版走原有会话路径，一行未改。任务书要求的「旧路与 `keepAliveMs`/`retryInterval`/`eventStore` 全部保留」因此被完整满足，而且没有任何客户端看到两种行为。

### 为什么结构化错误被降级（从 P3 移出）

`{code, blocking, nextAction}` 的价值是让模型知道「下一步做什么」而不是瞎重试。但实测我们的错误路径**已经**在做这件事，只是以人类可读句子的形式：资源锁超时明说 `retry, or raise concurrency.waitTimeoutMs (console settings page)`；`edit_block` 零命中时返回最近似区域与漂移原因；未知工具名给出编辑距离建议（`error-hints.ts`）。模型读得懂这些句子。

再包一层结构化字段，收益是「可编程判别」，成本是给全部 57 个工具加码并改动既有错误契约。**在观察到具体误重试案例之前，这是没有证据支撑的改动**，故降级为「有证据再做」。这符合本项目的取舍习惯：不为看起来完整而改。

### OAuth 的最终取舍与实现（已完成）

上一版把 OAuth 列为 P0，依据是「ChatGPT 连接器只填 URL、带不了自定义头」。**这个依据对本项目不成立**：`/mcp/<路由令牌>` 的令牌就在路径里（`lifecycle.ts` 注释写明 "the route token IS the credential"），任何只会贴 URL 的客户端**今天就能带凭据接入**。

于是 OAuth 的真实收益收窄为「**按客户端签发、可单独吊销**」——它**不是可达性门槛**（门槛是协议版本，已由 P1 解决），而是凭据管理的升级。据此把它从 P0 降到 P2，并且**作为第二把钥匙与路由令牌并存**，而不是取代它。（**这句与最终实现不符，见文末「审计修正」**）

**凭据取舍最终这样定**：授权页那次输入默认就是**路由令牌**（`OPEN_BRIDGE_OAUTH_OWNER` 可覆盖）。上一版我担心这会「让每客户端独立凭据的收益落空」——**这个担心是错的**：共享口令认证的是**在浏览器前点头的那个人**，而签发的 token 依然是**每客户端一份、可单独吊销**。收益完整保留，且操作员不需要多记一个秘密。同一套失败锁定复用 Bearer 闸门的限流器。

**实测勘定的实现面**：v2 只给了资源服务器那一半——`requireBearerAuth`（吃标准 `Request`，不绑 Express）、`oauthMetadataResponse`、`bearerAuthChallengeResponse`、`checkResourceAllowed`。授权服务器四个路由（`/register`、`/authorize`、`/token`、`/revoke`）在 devspace 那边来自 `@modelcontextprotocol/express`，**引入它等于引入 Express**，违反零框架约束，所以按 `node:http` 手写（约 700 行 + 25 项测试）。

**安全取舍全部写死在实现里**：只支持 S256（`plain` 拒绝）；`resource` 必填且必须是本机（RFC 8707）；授权码仅内存 + 5 分钟 TTL；refresh 一次性轮换（消费与读取同一步，重放找不到）；所有密钥只存 sha256；重定向 host 白名单且**精确匹配解析后的 host**（`https://evil.com/?x=chatgpt.com` 不通过）；授权页错误按规范**回跳到客户端的 callback**，只有 redirect_uri 本身不可信时才直接答 400（否则就是开放重定向）。

集成测试覆盖的每一项都是真实攻击面：单次性、PKCE 失败仍消费授权码、未注册重定向、越权 scope、跨 resource、refresh 重放、吊销后 401、控制台不泄漏摘要。

---

## 0. 一句话结论

本项目在**工程化与可运维性**这一层（CLI、多实例、Web 控制台、资源锁、隧道接管、审计日志、42 个测试文件）已经明显强于这三个项目；真正落后的是**对外协议与身份层**——尤其只有一个静态 Bearer PAT、且未验证 OAuth 2.1。

因此「取精华弃糟粕」的正确姿势不是吸收架构，而是**只移植子系统**：把 ChatGPT 连接器刚需的 OAuth 2.1 与双协议 `/mcp` 补上，把可观测性与错误语义的成熟做法搬过来；**拒绝**引入 Express 框架耦合、SQLite/Drizzle 状态层、文档处理依赖树、沙箱，以及需要本地 Coding Agent 才能兑现的整层委派机制。**每一条都必须是能力或性能的净增益。**

> **补充硬约束已核实并转化为红线**：我们本来就是**能力优先**的（`unrestrictedFileAccess: true`、`allowedDirectories: []`、`auth.enabled: false`、56 工具全开），而 devspace/taskquay 用 `allowedRoots` + 沙箱做了能力削减。本轮**一项削减都不采纳**（详见 §0.5 与 §7）。
>
> **同时查出我们自己的两个真问题**（与安全无关）：
> 1. **§2.6 我们正在偷窃活跃进程的资源锁（已实测复现）** —— `handOffToProcess` 不清除 hold 定时器，默认 300 s 后锁被回收并 `pump()` 给第二个调用，**而进程仍在跑**。探针输出 `reclaimedByHoldTimeout: true` + `secondCallerAcquiredSameKey: true`。这直接违反 README 对 `resource_keys` 的承诺。已列为 P0。
> 2. **§2.7 鉴权热路径是 O(n) 磁盘读 + 线性扫描** —— 需要改成 O(1) 查表 + mtime 失效缓存（**同时**保住跨进程一致性与性能），否则 OAuth 接入后会把已知成本乘以更高的请求率。

---

## 0.5 本项目的安全哲学：**能力优先**，且这比三家都正确

补充的硬约束是「不要为了安全放弃性能/权限和能力」。实测三家与我们的安全姿态：

| | 安全手段 | 是否削减能力 | 判定 |
| --- | --- | --- | --- |
| **本项目** | 可选 Bearer PAT、Host 白名单、回环门控 `/api`+`/console`、常量时间比较、失败锁定 | **完全不减**：`auth.enabled` 默认 `false`；`unrestrictedFileAccess` 默认 **`true`**；`allowedDirectories` 默认 **`[]`**；全 56 工具无条件公布 | ✅ **能力优先，安全是可选叠加层** |
| DesktopCommanderMCP | 无鉴权层；靠 VS Code/Claude 客户端侧信任 | 不减 | ⚠️ 无安全，但也无削减 |
| devspace / taskquay | OAuth、`ownerToken`、`allowedRoots`、控制台远程访问默认关闭 | **有削减**：`roots.ts` 强制路径必须在 `allowedRoots` 内，越界抛 `AccessDeniedError` | ⚠️ 以能力换安全 |
| taskquay（额外） | `@anthropic-ai/sandbox-runtime` + `local-agent-pi-sandbox.ts`（18 KB）+ `PI_NETWORK_ALLOWLIST` + 三档 `read_only\|allowed\|full_access` | **大幅削减**（网络 allowlist、写入模式） | ❌ **我们不复制** |

**关键判断：taskquay 需要沙箱，正是因为它把外部 Coding Agent 当子进程跑——它必须约束自己不信任的下属进程。我们不做委派，因此我们不需要沙箱。** 这是架构差异，不是安全上的落后。给它加沙箱等于自我阉割。

**由此得到两条设计红线**（贯穿下面所有建议）：

1. **OAuth / 鉴权永远是「叠加一层可选认证」，不是「收紧现有能力」**。不引入 `allowedRoots` 式的强制边界，不因安全理由裁剪工具集，不把 `unrestrictedFileAccess` 的默认值从 `true` 改成 `false`。
2. **`destructiveHint` / `readOnlyHint` 这类标注要做**。taskquay 用它把风险**告知**客户端（由客户端决定要不要问用户），而不是由服务端阻断——**告知是零能力损失的**。这是安全与能力不冲突的少数正确形态，我们应该采用。

---

## 1. 量化基线

### 1.1 本项目 open-bridge-app

| 项 | 值 | 备注 |
| --- | --- | --- |
| 运行时依赖 | **1 个**（`@modelcontextprotocol/sdk@^1.30.0`） | 极克制 |
| 框架依赖 | **无** | 全 `node:http`；`node:` 内置模块共 81 处 import |
| 源码规模 | `src/` **61** 文件 / **581 KB**（注释密集型）；`ui/` **20** 文件 / **109 KB** | 注释密度是刻意的 |
| 工具数 | 定义 **56** 个，对外公布 **54** 个 | `lsp`/`get_diagnostics` 因 `lsp:false` 被过滤（`src/bridge/tool-catalog.ts`） |
| MCP 能力声明 | `capabilities: { tools: {}, logging: {} }` | 无 resources / prompts / elicitation / sampling / roots / completions |
| 测试 | `test/` 共 **42** 文件：**35** 个单测 + **7** 个集成套件（真起进程走 HTTP） | 含鉴权闸门与协议不变量「事故遗产」断言 |
| 控制台 | 9 个页面 | status/sessions/tools/health/services/logs/stats/tokens/settings |
| 鉴权 | 可选 Bearer PAT（`ob_` 前缀，sha256 落盘，常量时间比较，按远端键锁定） | **默认关闭** |
| 协议版本 | 无 `server/discover`；SDK 自协商 1.30 默认版本（`LATEST_PROTOCOL_VERSION = "2025-11-25"`）；健康探针写死 `2025-06-18` | 无状态化改造未做 |

### 1.2 三个参照项目

| | DesktopCommanderMCP | devspace | taskquay |
| --- | --- | --- | --- |
| 版本 | 0.2.48 | 1.0.8 | 1.0.8（devspace 二开分支，package.json 仍叫 `@waishnav/devspace`） |
| src 文件 / 体积 | 125 / **1118 KB** | 138 / 1022 KB | 208 / **1571 KB** |
| 运行时依赖 | **28 个**（tiptap×7、exceljs、sharp、pdf-lib、supabase…） | 27 个（express、better-sqlite3、drizzle-orm、zod、clack…） | 同 devspace |
| 测试文件数 | 少量（`test/` + 脚本） | ~45 个 `.test.ts`（与源码同目录） | ~90 个 `.test.ts`（与源码同目录） |
| 包管理 | npm | pnpm 11.25.0（硬性） | 同 devspace |
| 形态 | MCP server + 桌面/远程设备 + VS Code/Claude/Cursor 插件分发 | 自托管 MCP + ChatGPT 连接器 + 本地 Coding Agent | devspace + 任务台 + 有界委派 |
| 关键能力 | 文件/表格/PDF/图片、文档转换、pizzip、exceljs、sharp | **OAuth 2.1 + DCR**、**双协议 `/mcp`**、worktree、skills、apps 卡片 | 上面全部 + 工作台账、用量回执、长轮询、执行仲裁、并发等待队列 |

---

## 2. 核心发现（均已实证）

### 2.1 【决定性】ECOSYSTEM 已换代：`@modelcontextprotocol/sdk` 是 v1，稳定线已是 v2

从 npm 实证：

```
@modelcontextprotocol/sdk        latest = 1.30.0   （无 2.x）
@modelcontextprotocol/server     latest = 2.0.0    （✅ 稳定版）
@modelcontextprotocol/core       latest = 2.0.0
@modelcontextprotocol/node       latest = 2.0.0
@modelcontextprotocol/ext-apps   latest = 2.0.0
```

`@modelcontextprotocol/server@2.0.0` 的 README 原文：

> **v2 is the stable release line**, implementing the [2026-07-28 MCP spec](https://modelcontextprotocol.io/specification/2026-07-28). Migrating from v1? Start with the migration guide.
> This is **v2** … It replaces the monolithic `@modelcontextprotocol/sdk` package from v1.

**这意味着 devspace/taskquay 的那套「双协议 `/mcp`」不是奇技淫巧，而是官方 v2 的标准入口。** taskquay 的做法（`createMcpHandler(..., { legacy: "stateless" })` + `toNodeHandler`）正是 v2 API。

**未确认但必须实测的一点**：`core@2.0.0` 内部的 `LATEST_PROTOCOL_VERSION` 字面量仍是 `"2025-11-25"`，`SUPPORTED_PROTOCOL_VERSIONS` 为 `["2025-11-25","2025-06-18","2025-03-26","2024-11-05","2024-10-07"]`，**不含 `2026-07-28`**；而同一份 bundle 的注释反复以 `2026-07-28` 描述「现代」语义（`ResultMetaObject`、`server/discover`、SEP-2577 弃用项）。README 与常量不一致，**落地前必须实测** `server/discover` 的 `supportedVersions` 到底返回什么。

### 2.2 【决定性】v2 的鉴权是 Web 标准 API，不再绑 Express——但 v1 是绑的

- **v1.30（我们现在装的）**：`mcpAuthRouter` / `requireBearerAuth` 的 `.d.ts` 首行就是 `import express, { RequestHandler } from 'express'`，**返回 Express 中间件**。本项目零框架、纯 `node:http`，直接采用会强制引入 Express。
- **v2.0.0**：导出的是 `requireBearerAuth(options): (request: Request) => Promise<AuthInfo | Response>`、`verifyBearerToken`、`oauthMetadataResponse`、`validateHostHeader` —— **标准 `Request`/`Response`**。Express 支持被拆到独立包 `@modelcontextprotocol/express`。

**结论：升 v2 同时解决「双协议」和「OAuth 且不引入 Express」两个问题。** 这是本报告最重要的可执行判断。

**并且升级不会损失能力（已实测 v2 包的 `.d.mts`）**：v2 的传输层保留了我们在用的三样流式能力——`keepAliveMs?: number`（SSE 注释帧保活，对应我们现在 `keepAliveMs: 15_000`）、`retryInterval`（客户端重连提示，对应我们现在 `retryInterval: 2_000`）、以及 `eventStore`（可恢复事件流，注释明确写「Only available when using a StreamableHTTPServerTransport with eventStore configured」）。`NodeStreamableHTTPServerTransport` 仍在 `@modelcontextprotocol/node` 中导出。同时 `legacy?: 'stateless' | 'reject'` 与 `legacyStatelessFallback(factory, onerror)` 均已确认存在。

> 换言之：**v2 = 多一条现代无状态路，旧路连保活参数都能照搬**。这不是「换代重写」，是「同层扩容」。

### 2.3 【关键】本项目最大的对外缺口就是 OAuth 2.1

证据链：

1. `src/http/auth-core.ts` 的文件头注释明确写着「为什么用哈希 PAT 而不是完整 OAuth」——设计上是**有意**的取舍。
2. 同一文件 142 行的注释却写着：「Borrowed from the one auth weakness devspace did NOT solve — an unlimited password prompt」——说明作者读过 devspace，但**没有**把它的 OAuth 当作要抄的东西。
3. README 第 113 行承认：「**Bearer 鉴权默认关闭**，因为「只填 URL」的客户端（如 ChatGPT 连接器）带不了自定义头，一开就全断。」
4. README 第 19 行把「`/api/*`（回环 + 令牌头双门控）」当作安全边界——但这只保护控制台，不保护公网 `/mcp`。

devspace 的实证做法（taskquay 沿用）：

| 项 | 实现 |
| --- | --- |
| 端点 | `mcpAuthRouter({ provider, issuerUrl, baseUrl, resourceServerUrl, scopesSupported, resourceName })` 挂在**应用根**（非 `/mcp`） |
| 动态注册 | `client_id = devspace-<uuid>`，`token_endpoint_auth_method: "none"`，`grant_types: ["authorization_code","refresh_token"]`，`response_types: ["code"]` |
| 重定向白名单 | 注册时校验 host；`localhost`/`127.0.0.1`/`[::1]` 永久放行；默认 `["chatgpt.com","localhost","127.0.0.1"]`；ChatGPT 实际回调是 `https://chatgpt.com/connector_platform_oauth_redirect` |
| PKCE | 授权页硬编码 `code_challenge` + `S256`；`challengeForAuthorizationCode` 返回存储的 challenge |
| `resource` | **授权时强制**，缺失或不在白名单直接 `InvalidRequestError`；换 token / 刷新必须重复同一 `resource` |
| 存储 | 只存 `sha256(token).digest("base64url")`；授权码**仅内存** Map、TTL 5 分钟 |
| TTL | access 3600 s，refresh 2592000 s（30 天） |
| 刷新轮换 | `immediate` 事务内删除被消费的 refresh hash 且要求 `changes === 1`，否则返回 false 且**一行都不插**（重放防护） |
| 同意页 | 服务端渲染 HTML 表单，**无 cookie/无服务端会话**——所有授权参数靠隐藏字段往返 |
| 口令比较 | `timingSafeEqual`，长度先校验；来源 `config.oauth.ownerToken` 或 env，最短 16 字符 |
| `/mcp` 校验 | `requireBearerAuth` 之后再查 `req.auth.resource` 是否允许；不允许 → **401**（JSON-RPC `-32001`）+ `auth_denied` 日志。代码里**没有 403 分支** |

**对我们最值钱的 4 条**：
1. ChatGPT 连接器在「OAuth」与「无鉴权」之间**只能二选一**——本项目 README 也承认了这点，所以「要么裸奔、要么断连」的死结必须用 OAuth 解开。
2. `resource` 参数是**强制**的，不是可选的；漏掉就会在真机上失败。
3. 授权码只放内存 + refresh 一次性轮换，是**低成本的正确性**，不需要数据库也能做。
4. 「无 cookie 的隐藏字段往返」意味着**我们不需要会话来支撑授权页**，与现有 `node:http` 结构天然兼容。

### 2.4 【关键】双协议同端点：同一个 `/mcp` 吃下新旧客户端

devspace/taskquay 的实证契约（`server.ts` 单一路由 `app.all("/mcp")`，先鉴权再分发）：

**现代请求（`2026-07-28`）**——按请求携带信封，无 session：
```
mcp-protocol-version: 2026-07-28
mcp-method: <jsonrpc method>        # 如 server/discover / tools/list / tools/call
mcp-name: <tool name or uri>        # 命中具名目标时
body params._meta["io.modelcontextprotocol/protocolVersion"] = "2026-07-28"
body params._meta["io.modelcontextprotocol/clientCapabilities"] = {}
响应不带 mcp-session-id
```

**旧版请求（2025 世代）**——无任何 `mcp-*` 头，被**无状态**服务：
```
initialize 携带 params.protocolVersion: "2025-06-18"
→ 200，结果里有 protocolVersion，mcp-session-id: null
后续 tools/list 不带 session id 也能成功
```

分流开关是 `legacy: "stateless"`（隔离测试里用 `legacy: "reject"`）。`server/discover` 必须返回 `result.supportedVersions`。

**对本项目的具体含义**：我们整个 `state.sessions` Map、`StreamableHTTPServerTransport` 每会话实例、`pruneSessions()` 空闲回收、会话级 todo 存储，**都是 2025 世代的形状**。现代协议是**请求导向**的，与「每个客户端一条长会话」的模型在根上不同。这不是加个分支就完事，而是传输层要重构；但**可以保留旧路为 fallback**（自托管客户端继续用会话，公网连接器走无状态），两条路并存正是 v2 的设计意图。

**能力清点：现代路不会丢掉什么。** 逐一核对我们的会话级状态：

| 我们现在挂在会话上的东西 | 现代无状态路的影响 |
| --- | --- |
| `open_shell` 持久 shell、`state.commands` 进程表、服务定义、资源锁、用量计数、活动日志、审计日志 | **全部是进程全局的，与 session 无关** → 零影响 |
| `set_todos` / `get_todos` | 现在**每会话一份**、落盘却是全局 `todo-store`。现代路没有会话 → 需要一个新锚点（见 §5 P1 第 11 条） |
| `report_progress` → MCP `notifications/message` | 依赖请求内的 SSE 流；v2 保留 `text/event-stream` 与 `keepAliveMs` → **可用** |
| 断线重连取回未读事件（`eventStore`） | v2 仍导出 `eventStore` / `NodeStreamableHTTPServerTransport` → **可保留** |

**结论：只有「会话级 todo」一项真正需要重新设计，其余不受影响。** 这是升 v2 的主要真实成本。

### 2.5 其余可打包搬走的成熟做法

- **按请求可观测性**（`mcp-request-diagnostics.ts`）：`mcp_exchange_started/finished` 事件；字段全部是**白名单枚举**（非白名单值退化成 `"other"`），身份值必须匹配 `^ws_[a-f0-9]{6,64}$` / `run_…` / `agt_…` 否则丢弃，会话值只记 `sha256(...).slice(0,24)`，错误文本只记 `sha256(message).slice(0,16)` 指纹，响应体 monkey-patch `res.write/end` 最多留 64 KiB、超限丢弃并标 `over_limit`；**所有日志调用包在 `try{}catch{}` 里，日志失败绝不改变传输语义**。
- **优雅停机**（`server-shutdown.ts`）：`httpServer.close()` 后**立刻并行**跑应用清理（不是等 drain 完），10 s `.unref()` 心跳仅做存活日志、不杀 drain；阶段事件严格有序；HTTP close 错误在清理完成后才抛出。
- **错误语义**：`{code, message, blocking?, nextAction?}` 结构化错误码（`EXECUTION_CONFLICT` / `AGENT_CONFLICT` / `WORK_STATE` / `INVALID_TASK`），把「谁占着、等什么、下一步做什么」交给模型，而不是让它瞎重试。
- **关闭式进度词表作为隐私边界**：`phase ∈ {queued,preparing,provider,tool,finished}` + `toolCategory ∈ {build,test,command,read,edit,tool}`；命令行、stdout、推理文本**永不落盘**。`decodeAgentProgress` 拒绝表外值。**廉价、可审计，而且让「不把你 shell 历史漏进模型上下文」这个承诺变得可测。**
- **双重 revision + 有界长轮询**：`taskRevision` 与 `progressRevision` 分开哈希，`revision` 由两者合成；**累计 token 数刻意不进任何 revision**——120 次用量更新不得唤醒轮询（有测试断言）。`waitMs ≤ 25000`，`includeResponse` 在终态可反复取回（断线不消费结果）。
- **锁不抢、权限不外借**：`execution-coordinator` 的「**Active claims have no timeout-steal path**」——活跃 claim **永不超时、永不被窃取**。这是全仓库最好的一条设计。另有跨进程实证（另起一个 Node 进程验证互斥）。
- **能力派生的只读**：只读并发由 driver capability（`readOnlyConcurrency === true`）决定，**绝不从 prompt 推断**。
- **用量不造数**：`complete | partial | unavailable | not_used` 四态，原则是「缺失的边界永不记为 0」；写入是**替换而非累加**，累计值变小（provider 重置/过期）直接拒绝。
- **路径规范化**：`canonicalExecutionRoot()` 向上走到 `.git` 再 `realpath` + 大小写归一，让嵌套目录/符号链接别名坍缩到同一身份；另有 `normalizeWslPath` 处理 `\\wsl.localhost\<distro>\…`。

### 2.6 【新发现·正确性缺陷·已复现】我们正在**偷窃活跃进程的资源锁**

这是本轮对照 taskquay 的「**Active claims have no timeout-steal path**」时查出来的**我们自己的问题**，与安全无关，是真实的能力/正确性损失：

证据链（全部可复核）：

1. `src/bridge/resource-locks.ts:126-136` — `attachHoldTimer` 给**每一个** holder 挂 `holdTimeoutMs` 定时器，到期执行 `tuning.onReclaim?.(...)` 然后 `releaseHolder(holder)`。
2. `src/bridge/dispatcher.ts:159` — 声明了 `resource_keys` 的 spawn 走 `handOffToProcess(lease.release, result)`，注释承诺「the resource stays reserved for the process's **lifetime**」。
3. `src/bridge/dispatcher.ts:173-191` — `handOffToProcess` **只**做 `command.releaseResourceLocks = combined`，**从不清除 holder 的 hold 定时器**（全仓库 `holdTimer` 仅 6 处，清除只发生在 `releaseHolder` 内部）。
4. `src/bridge/resource-locks.ts:141-153` — `releaseHolder` 在释放 key 后调用 `pump()`。
5. `src/bridge/config-defaults.ts:29` — `concurrency.holdTimeoutMs` 默认 **300_000**（5 分钟）。

**后果（决定性）**：`start_process` 带着 `resource_keys: ["port:5173"]` 起了一个 dev server。5 分钟后 hold 定时器触发 → 锁被回收 → `pump()` 把 `port:5173` 授予排队中的第二个调用。**而第一个 server 仍在运行。** 这恰好是 README 第 102 行对 `resource_keys` 的承诺所否认的情形（「Two calls naming the same key never start at once, so a reserved port or output directory cannot be claimed twice」），也是工具描述里 `run_command`/`start_process` 的 `resource_keys` 文案所承诺的。

代码里甚至有一处注释承认了这个时序：「an auto-restart can carry the handle onto a replacement command and **the hold-timeout backstop may fire first**」（`dispatcher.ts:180-181`）——即作者知道定时器会先开火，但把它当成「backstop」而非缺陷。

#### 已实测复现（不是推断）

用临时探针直接调 `acquireLocks`（跑完即删，工作树未留文件）：`holdTimeoutMs: 150`，acquire `port:5173` → **不释放**（模拟 hand off）→ 等 400 ms → 用第二个调用者抢同一 key：

```
PROBE_RESULT {"reclaimedByHoldTimeout":true,
              "reclamationDetail":["spawn dev server held 161ms"],
              "secondCallerAcquiredSameKey":true,
              "verdict":"BUG CONFIRMED: lock reclaimed + re-granted while the process still holds it"}
```

**缺陷成立**：hold 定时器确实回收了锁，且第二个调用者**成功拿到同一个 key**——此时第一个进程仍在运行，正是 `resource_keys` 承诺要阻止的情形。默认值 300 s 意味着**任何活过 5 分钟的 dev server / build watcher / 模拟器都会失去它的资源保护**。

**修复方向（不许用「加沙箱」搪塞，这是纯正确性问题）**：
- `handOffToProcess` 成功后**必须清除该 holder 的 hold 定时器**——锁的寿命从此由**进程退出**决定，而不是由时钟决定。这正是 taskquay「活跃 claim 无超时窃取路径」的含义。
- 定时器只应作为**「调用已返回、但锁未释放」的兜底**（即同步调用路径的卡死保护），不应覆盖「锁已交给一个活着的进程」的路径。
- 保留 `holdTimeoutMs: 0 = never reclaim` 的语义；`waitTimeoutMs` 不变（等待方超时是**拒绝**，不是窃取，语义正确）。
- 必须补一条测试：短 `holdTimeoutMs` + hand off 到未退出进程 → 断言锁**不会**被回收、且第二个调用**拿不到**该 key。

> 这一条优先级高于本报告其他所有建议：它不需要任何依赖、任何架构改动，却能立刻消除一类「两个进程抢同一端口/输出目录」的静默故障。

### 2.7 【新发现·性能】鉴权路径是 O(n) 磁盘读，且会拖慢 OAuth

| 位置 | 现状 | 代价 |
| --- | --- | --- |
| `src/http/auth.ts:72-76` `readRecords()` | **每个请求**都 `host().secrets.get(...)` 并 `JSON.parse` 整个 token 数组 | 一次 IPC/文件读 + 一次 JSON 解析 / 请求 |
| `src/http/auth-core.ts:96-113` `verifySecret()` | **遍历全部记录**，对每条做 `digestEquals`（`Buffer.from(hex)` ×2 + `timingSafeEqual`） | O(令牌数) 次 Buffer 分配 + 常量时间比较 / 请求 |
| `src/http/auth-core.ts:198-206` `evictIfFull()` | 达到 1000 键上限时 `[...entries()].sort()` | O(n log n)，仅在异常流量下触发 |

代码注释解释了「为何不留缓存」：跨进程一致性（CLI 铸造的令牌必须立刻被服务进程看到）。**这个正确性要求应当保留**，但实现方式可以既正确又 O(1)：

- 令牌记录以 **`hash` 为键的 Map** 查找（sha256 hex 是天然主键），把 `verifySecret` 的线性扫描降为一次查表；`timingSafeEqual` 仍用于最终确认，**常量时间属性不丢**。
- 缓存以 **`(mtimeMs, size)`** 为失效键，而不是时间 TTL——另一进程写入后 mtime 变化即失效，**跨进程正确性不丢**，而稳态下每请求只剩一次 `stat()`。
- `evictIfFull` 改为丢弃**最早窗口**的单次线性扫描（无需排序）。

**为什么必须现在处理**：OAuth 接入后，`verifyAccessToken` 会成为**每个公网请求**的热路径，而 ChatGPT 连接器发起的是高频小请求。如果沿用「每请求全量解析 + 线性扫描」，我们就是把一个已知的 O(n) 成本乘以更高的请求率——**这才是真正的「为安全牺牲性能」**。把查找改成 O(1) 属于**同时改善两者**，不是取舍。

---

## 3. 取其精华

### 3.1 从 devspace 取

| # | 精华 | 为什么值得 | 移植成本 |
| --- | --- | --- | --- |
| D1 | **OAuth 2.1 + DCR + PKCE + `resource` 校验** | 唯一能同时满足「ChatGPT 连接器」与「公网不裸奔」的路径；解开 README 里承认的死结 | 中（见 §5 P0） |
| D2 | **双协议 `/mcp`（v2 `createMcpHandler` + `legacy: "stateless"` + `toNodeHandler`）** | 官方 v2 路线；新旧客户端同端点，无需让用户选模式 | 中高（传输层重构） |
| D3 | **授权页「无 cookie 隐藏字段往返」** | 不需要会话就能支撑 OAuth 同意流程，和现有纯 `node:http` 结构天然契合 | 低 |
| D4 | **重定向 host 白名单 + `token_endpoint_auth_method: "none"`** | ChatGPT 是公共客户端，这两条是可连通性的硬门槛 | 低 |
| D5 | **refresh 一次性轮换（`changes === 1` 否则整笔回滚）** | 重放防护，成本极低 | 低 |
| D6 | **按请求可观测性（白名单字段 + 哈希身份 + 响应截断）** | 我们已有 `audit.log` 与活动流，但缺「一次 MCP 交换」的因果闭环 | 低 |
| D7 | **优雅停机的并行 drain + 严格阶段事件** | 我们已处理 ECONNRESET，但清理是一次性的、可观测性弱 | 低 |
| D8 | **`canonicalExecutionRoot` 式路径身份归一** | 我们的 `workspace-path.ts` 已做「不解析符号链接的父级遍历」防逃逸；可再补一层别名坍缩，让锁与幂等键更准 | 低 |
| D9 | **`AGENTS.md` / `CLAUDE.md` 注入 + skills 发现** | 我们已注入项目说明（`projectInstructionSuffix`）；**skills 发现是真缺的一块** | 低中 |

### 3.2 从 taskquay 取（**只取已有真实消费者验证的部分**）

| # | 精华 | 为什么值得 | 移植成本 |
| --- | --- | --- | --- |
| T1 | **结构化错误 `{code, blocking, nextAction}`** | 直接提升模型自纠错率；我们有 `error-hints.ts` 可挂钩 | 低 |
| T2 | **关闭式进度词表（phase + toolCategory）作为隐私边界** | 廉价、可审计、可测；我们的 `report_progress` 目前是自由文本 | 低 |
| T3 | **双重 revision + 有界长轮询（`waitMs` ≤ 25 s，`includeResponse` 断线可重取）** | 直接解决「轮询浪费 token」与「断线丢结果」，且**不引入任何依赖** | 中 |
| T4 | **幂等键（`requestKey` / `taskKey` + 请求哈希；同哈希返回既有结果，异哈希拒绝）** | MCP 客户端会重试；没有请求哈希就会重复付费或重复写盘 | 中 |
| T5 | **活跃 claim 永不超时/永不被窃取** | 我们 `resource-locks` 有 `holdTimeoutMs: 300000`——**这一条是对我们现有设计的直接质疑**，需评估是否会误伤长时间构建 | 低（决策） |
| T6 | **能力派生只读，不从 prompt 推断** | 一句话原则，防止「模型自称只读」被当真 | 低 |
| T7 | **用量四态 + 「缺失边界永不记为 0」+ 单调性护栏** | 诚实性设计；我们 `usage-store` 只有 successes/failures 计数 | 低中 |

### 3.3 从 DesktopCommanderMCP 取

| # | 精华 | 为什么值得 | 移植成本 |
| --- | --- | --- | --- |
| M1 | **模糊匹配失败时的「最近似区域 + 漂移原因」提示** | 我们的 `edit_block` 已有同类能力（`fuzzy-match.ts` + 错误含最近似区域）——**这条我们已达标，属交叉验证** | 已有 |
| M2 | **跨平台进程/终端管理的成熟度** | 它 28 个依赖里有一半是文档处理；**终端部分**才是可比的，其余已被我们的 `shell-sessions` + `processes` + `output-buffer` 覆盖并更克制 | 不建议 |
| M3 | **`file-type` / 二进制嗅探、图片元数据** | 我们的 `read_files` 有 base64 模式但没有类型嗅探；**仅在确有需求时**引入，且应自行实现而非拖入 sharp | 低（按需） |

> **注意**：DesktopCommanderMCP 对本次判断的贡献主要是**反面对照**——它证明「靠堆依赖扩工具数」会把一个本地桥接器拖成 28 依赖的文档平台。我们 1 个依赖 + 54 工具是更健康的比例。

---

## 4. 弃其糟粕

### 4.1 明确拒绝

| 拒绝项 | 来源 | 理由 |
| --- | --- | --- |
| **引入 Express 以满足 v1 的 `mcpAuthRouter`** | devspace / taskquay | 本项目 61 个源文件、81 处 `node:` 引用、零框架，是刻意的架构资产。**改用 v2 的 Web 标准中间件即可完全避免** |
| **better-sqlite3 + drizzle-orm 状态层** | devspace / taskquay | 我们 `state.json` / `secrets.json` / `audit.log` / `runtime-<hash>.json` 已够用；引入原生编译依赖会破坏「一个 Node 进程、零配置」的核心卖点 |
| **整层「委派本地 Coding Agent」** | taskquay（≈550 KB 独有代码） | 它要拉 `@anthropic-ai/claude-agent-sdk`、`@opencode-ai/sdk`、`@agentclientprotocol/sdk`、`@earendil-works/pi-coding-agent`。**兑现条件是我们不做的事**：托管外部 Agent 进程。我们本身就是那个被连接的一方 |
| **工作台账 / 用量回执 / trajectory audit / codex-project 控制** | taskquay | 价值真实但**依赖上面那层委派**才有消费者。没有 Codex 会话可管，这些表就是空转。**等真有委派需求再谈** |
| **`execution_waiters` 有序队列**（FIFO sequence、64 槽容量、TTL 过期、`expired_pending_settlement`、`waitingState()` 投影） | taskquay | 评审结论：每 checkout 单写者独占 + 「冲突即稍后重试」覆盖几乎所有流量。有序队列只有在**持久化 agent 行**存在时才划算 |
| **具名 `resources` 键（最多 16 个、128 字符校验面）** | taskquay | 与 checkout 锁概念重叠。**但注意**：我们 `run_command`/`start_process` 已有等价的 `resource_keys`（`maxItems: 16`）——所以「概念」我们有，「建表 + 校验 + 等待队列」这层不要 |
| **可执行文件命令分类表**（gradle/go/maven/pytest 正则） | taskquay | 26 个夹具里启发式与真值差 12 个，测试很强，但产出只是一个 `build`/`command` 徽章。**保留关闭词表，丢掉分类表** |
| **`agent-reasoning-limit` 的 provider 断言** | taskquay | 19 行模块硬绑 `provider.id === "codex"`。通用做法是 `{modelPattern → maxEffort}` 钳制，无需 provider 断言 |
| **以赞助/货币化换取功能（Rebates 类）** | devspace README | 该段落在其 README 中**已被 HTML 注释包裹**（未实际启用），但方向上与本项目定位不符：我们不做「看广告/挂赞助换功能」。记录在此是为了明确边界，不是因为上游正在这么做 |
| **PDF/Excel/Word/图片重栈**（tiptap×7、exceljs、sharp、pdf-lib、unpdf、pizzip、md-to-pdf、supabase） | DesktopCommanderMCP | 与「把工作区交给 AI」无关；`sharp` 是原生模块，会拖累安装与跨平台。要文档能力应作为可选插件而非核心依赖 |
| **`test-listener-bug.js`、`setup-claude-server.js` 等散装脚本** | DesktopCommanderMCP | 仓库根目录的临时脚本与十几份 `*_EXPLANATION.md`，是历史欠账 |
| **pnpm 硬绑** | devspace / taskquay | README 要求 `pnpm@11.25.0`（`packageManager` 钉死）。我们 npm + `package-lock.json` 更省事，无必要换 |
| **devspace 的手搓协议/鉴权中间层** | devspace | 它正是为了绕开 v1 的框架耦合才自己写。我们**直接升 v2** 就不必重走一遍 |

### 4.2 「糟粕」的另一类：**宣传与实证的落差**

taskquay 的 README 有 222 行，其中**多处自我披露未验证**，值得引以为戒：

- 「本次文档修改没有重新验证『TaskQuay 全私网 OAuth + 官方 Tunnel』的真实完整流程」
- 「此前零推理空线程实验没有完成真实恢复验证」
- 「自动不可变快照、任意节点 fork、保证缓存命中和完整自动中断恢复**不属于已完成承诺**」
- 统计状态命名在 README 里写作「未知 / 未调用」，而**代码里的真实枚举是 `unavailable` / `not_used`**——文档与实现对不上。

**对我们的启示**：`CHANGELOG.md`（36 KB）与 README 的口径一致性，是我们已经做得比它好的地方，应当保持；新增能力时**不要把「设计意图」写成「已验证」**。

---

## 5. 建议路线（按优先级，尚未执行）

> **贯穿全线的红线**：每一步都必须是**能力/性能的净增益或中性**。任何一步如果需要「收窄权限、裁剪工具、降低并发」来成立，就说明做错了——退回重设计。

### P0 — 修掉「偷窃活跃进程锁」（§2.6，**已实测复现**，零依赖、立即见效）

0. `handOffToProcess` 成功后**清除该 holder 的 hold 定时器**，让锁的寿命由**进程退出**决定；`holdTimeoutMs` 退化为「调用已返回但锁未释放」的兜底。补测试：短 `holdTimeoutMs` + 进程未退出 → 锁不被回收、第二个调用拿不到 key。
   - **为什么排第一**：已用探针确认「锁被回收 + 第二个调用者拿到同一 key，而进程仍在跑」。这是纯正确性缺陷（两个进程抢同一端口/输出目录），不修就会继续静默发生；而修复本身**不引入任何依赖、不改架构、不降能力**。
   - 修复后同一探针应输出 `reclaimedByHoldTimeout: false` / `secondCallerAcquiredSameKey: false`。

### P1 — 解开「OAuth 还是裸奔」的死结（纯叠加）

1. 升级到 v2 稳定线：`@modelcontextprotocol/server@2` + `@modelcontextprotocol/node@2`（`core` 为传递依赖）。**移除** `@modelcontextprotocol/sdk@1.x`。
2. 用 v2 的 `OAuthServerProvider` 实现，**不引入 Express**（v2 的 `requireBearerAuth` 吃标准 `Request`/`Response`）。
3. 新增 `src/http/oauth-store.ts`：只存 `sha256(secret)`；授权码纯内存 + 5 分钟 TTL；refresh 一次性轮换（整笔事务，`changes === 1`）。
4. 新增 `src/http/oauth-routes.ts`：`/.well-known/*`、`/register`、`/authorize`(GET 渲染 + POST 同意)、`/token`、`/revoke`，**挂在应用根而非 `/mcp`**。
5. `resource` 校验设为**强制**；重定向 host 白名单默认 `["chatgpt.com","localhost","127.0.0.1"]`，本地三件套永久放行。
6. 与既有 PAT **并存**：PAT 继续服务自托管客户端，OAuth 服务连接器。两者都走同一 `authorizeRequest` 裁决点。**OAuth 只是多一把钥匙，不是多加一道锁**——不开 OAuth 的实例行为必须与今天逐字节一致（`auth.enabled` 默认仍为 `false`）。
7. 控制台「令牌」页扩展为「凭据」页：分别展示 PAT 与 OAuth 客户端/授权记录，保留两步确认。
8. **顺手把鉴权热路径改成 O(1)（§2.7）**：令牌记录改以 `hash` 为键查表；缓存以 `(mtimeMs, size)` 失效，**保留跨进程一致性**；`evictIfFull` 去掉排序。这是**性能净增益**，且是 OAuth 接入前的必要准备。

**验收（必须真机，不能只跑单测）**：真实 ChatGPT 连接器完成 DCR → 授权页 → `/token` → `tools/list`；然后**故意重放已消费的 refresh token**，断言换不到新 token。

### P2 — 双协议 `/mcp`（能力扩容，不是重构）

9. 接入 `createMcpHandler(() => …)` + `toNodeHandler`，`legacy: "stateless"`；**先做预研**：实测 `server/discover` 的 `supportedVersions` 是否真含 `2026-07-28`（§2.1 的未确认项）。
10. 分流从 header 判定（`mcp-protocol-version` / `mcp-method` / `mcp-name` + `_meta`），**不按 session 判定**。
11. 旧路**原样保留**为 fallback：`StreamableHTTPServerTransport` 每会话实例继续服务 2025 世代客户端，`keepAliveMs: 15_000` / `retryInterval: 2_000` / `eventStore` 照搬（已实测 v2 均支持）。**不删除任何现有客户端路径。**
12. 只有会话级 `set_todos` 需要新锚点（其余状态本来就是进程全局的，见 §2.4 清点表）。参照 `_meta["openai/session"]` 的防御式读取：**非空字符串才接受**，否则退回实例级。
13. 给工具补 `readOnlyHint` / `destructiveHint` 标注（taskquay 的做法）：**只告知、不阻断**，能力零损失。

### P3 — 可观测性与错误语义

14. 按请求追踪：`mcp_exchange_started/finished`，白名单字段 + 哈希身份 + 64 KiB 响应截断；**日志失败不得改变传输语义**。
15. 优雅停机改为「`close()` 与清理并行 + 严格阶段事件 + `.unref()` 心跳」。
16. `error-hints.ts` 升级为 `{code, blocking, nextAction}` 结构化错误。
17. `report_progress` 增加关闭式 `phase` + `toolCategory` 词表（**自由文本保留为附加字段，不替换**）。

### P4 — 后续（有真实需求再做）

18. 幂等键（`requestKey` + 请求哈希）——防的是客户端重试导致的重复写盘/重复付费。
19. 双重 revision + 有界长轮询——省 token；**不引入依赖**。
20. skills 发现（`~/…/SKILL.md`）——纯增能力。
21. 用量四态与单调性护栏。
22. **多根工作区：只做「更容易开第二个实例」，不做 `allowedRoots` 强制边界。** 我们已有 `allowedDirectories` + `unrestrictedFileAccess`（默认 `true`），保持默认值不变；`--root` 与「一个目录一个实例」的既有契约优先。

---

## 6. 落地前的验证清单（不要跳过）

| # | 待验证 | 方法 |
| --- | --- | --- |
| 1 | v2 是否真支持 `2026-07-28` 分流 | 装 `server@2`，打 `server/discover`，读 `supportedVersions` |
| 2 | **TypeScript 版本** | 当前 **5.9.3**；v2 的 `.d.mts` README 提示「TS ≥6.0 不再自动包含 `@types/*`，需显式 `"types": ["node"]`」。我们 `skipLibCheck: true` 可能掩盖问题——**升级后必须跑 `npm run typecheck`** |
| 3 | zod 版本 | 已确认 `node_modules/zod` 为 **4.6.1**，`server@2` 要求 `zod@^4.2.0` ✅ |
| 4 | Node 版本 | 我们要求 `>=22`；v2 要求 `>=20` ✅ |
| 5 | v1→v2 迁移面 | 我们只用了 `Server`、`StreamableHTTPServerTransport`、`ListToolsRequestSchema`、`CallToolRequestSchema`、`EventStore`（`lifecycle.ts` + `state.ts`），面很窄，可控 |
| 6 | 测试栈是否仍成立 | 现有集成测试是**裸 JSON-RPC over HTTP**，不依赖 SDK 客户端 —— 换 SDK 后应大体不变，但 `mcp-protocol-integration.test.mjs` 需复核 |
| 7 | 合规 | 三个参照项目均为 **MIT**（taskquay 另有 `NOTICE` + `THIRD_PARTY_NOTICES.md` 保留上游 `Copyright (c) 2026 Waishnav`）。我方同为 MIT：**移植代码必须保留上游版权声明**，并在 `NOTICE`/`THIRD_PARTY_NOTICES` 中登记来源 |
| 8 | **窃锁缺陷可复现（§2.6，已复现）** | 临时探针：`holdTimeoutMs: 150` → acquire → 不释放 → 等 400 ms → 第二个调用者抢同一 key。**实测输出 `reclaimedByHoldTimeout: true` + `secondCallerAcquiredSameKey: true` → 缺陷成立**。修复后应双双为 `false` |
| 9 | v2 流式能力（§2.2，**已实测通过**） | `keepAliveMs` / `retryInterval` / `eventStore` / `legacy: 'stateless' \| 'reject'` 均已在 `@modelcontextprotocol/server@2.0.0` 的 `.d.mts` 中确认存在；仅需在集成测试里复核 SSE 保活与断线续传行为不变 |

---

## 7. 明确不做（Non-goals）

**能力优先红线（来自本轮的硬约束）**
- **不引入 `allowedRoots` 式的强制文件边界**：`unrestrictedFileAccess` 保持默认 `true`，`allowedDirectories` 保持默认 `[]`。想收紧是操作员的自选动作，不是新的默认值。
- **不引入沙箱**（`@anthropic-ai/sandbox-runtime`、seatbelt/bubblewrap、网络 allowlist、写入模式三档）。taskquay 需要它是因为它托管外部 Coding Agent；**我们本身就是被连接的一方，加沙箱等于自我阉割**。
- **不因安全理由裁剪工具集或降并发**。`destructiveHint` / `readOnlyHint` 只做**告知**，永不做**阻断**。
- **不把 `auth.enabled` 的默认值从 `false` 改成 `true`**；OAuth 是新增的第二把钥匙，不是新的门禁。

**架构边界**
- 不把本项目变成「Coding Agent 调度器」——我们的身份是**被连接的工作区端点**，不是 Agent 宿主。
- 不引入任何原生编译依赖（`sharp` / `better-sqlite3`）。
- 不引入 Web 框架（Express/Fastify/Hono）。
- 不用「provider 专属」逻辑换取通用能力；工具集保持宿主无关（`lsp`/`get_diagnostics` 这种宿主能力门控是正确范式，继续用）。
- 不为「看起来功能多」而增加工具数：**56 定义 / 54 公布**是优点。

---

## 8. 附：复现命令

```powershell
# 量化基线
Get-ChildItem C:\Users\aolia\Desktop\codex\GitHub -Directory
Get-ChildItem -Recurse -File <proj>\src | Measure-Object -Property Length -Sum     # 体积
Select-String -Path <proj>\package.json -Pattern 'dependencies' -Context 0,40      # 依赖树

# 生态换代（§2.1）
foreach ($p in '@modelcontextprotocol/server','@modelcontextprotocol/node','@modelcontextprotocol/core','@modelcontextprotocol/sdk','@modelcontextprotocol/ext-apps') {
  $r = Invoke-RestMethod "https://registry.npmjs.org/$([uri]::EscapeDataString($p))"
  "$p latest=$($r.'dist-tags'.latest)"
}

# v1 鉴权是否绑 Express（§2.2）
Get-Content <repo>\node_modules\@modelcontextprotocol\sdk\dist\esm\server\auth\router.d.ts -TotalCount 1
# → import express, { RequestHandler } from 'express';

# v2 的协议版本常量（§2.1 未确认项）
npm pack @modelcontextprotocol/core   # 解包后 grep LATEST_PROTOCOL_VERSION
# → const LATEST_PROTOCOL_VERSION = "2025-11-25";  且 SUPPORTED_PROTOCOL_VERSIONS 不含 2026-07-28

# 本项目自身事实
Select-String -Path src\host\node-host.ts -Pattern 'NODE_CAPABILITIES'    # → { lsp: false }
select-string -Path src\bridge\config-defaults.ts -Pattern 'unrestrictedFileAccess'  # → true
```

---

## 9. 一句话收尾

**devspace 给了我们「对外的门」——OAuth 2.1 与双协议 `/mcp`；taskquay 给了我们「对内的规矩」——结构化错误、隐私词表、幂等键，以及「活跃 claim 绝不被偷」这条照出我们自己缺陷的镜子；DesktopCommanderMCP 给了我们「反面教材」——依赖越多，越不像一个桥。**

本项目的 1 个依赖、纯 `node:http`、**能力优先（`unrestrictedFileAccess: true`、鉴权默认关、56 工具全开）**、多实例 CLI 与 42 个测试文件是要**守住**的资产。要补的是协议与身份层，**并且要修掉一个正在偷锁的定时器**——但**一样能力都不许换**。

### 本次修正确认的能力/性能净收益清单

| 动作 | 能力 | 性能 |
| --- | --- | --- |
| P0 修 hold 定时器窃锁 | ⬆️ 资源互斥恢复承诺的语义 | 中性 |
| P1 OAuth 2.1 | ⬆️ 新增 ChatGPT 连接器可达（**不减少任何现有能力**） | 中性（不开则零开销） |
| P1 鉴权热路径 O(1) | 中性 | ⬆️ 每请求去一次全量 JSON 解析 + 线性扫描 |
| P2 双协议 `/mcp` | ⬆️ 新旧客户端同端点；旧路原样保留 | 中性（`keepAliveMs`/`retryInterval`/`eventStore` 照搬） |
| P2 `destructiveHint` 标注 | 中性（只告知不阻断） | 中性 |
| P3 可观测性 | 中性 | ⚠️ 仅受 64 KiB 截断约束；**日志失败不影响传输** |
