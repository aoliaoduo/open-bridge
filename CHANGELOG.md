# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- **控制台设置页终于有了 OAuth 的开关。** `oauth.enabled` 之前只能 `open-bridge config set`（或直接打
  `/api/settings/action`）——设置页里根本没有这一项，README 却说「或者用控制台设置页」。现在新增
  「OAuth 2.1（可选）」卡片：开关、重定向主机白名单（`oauth.allowedRedirectHosts`，空 = 内置名单）、
  以及从 `/api/oauth` 读到的已注册客户端与在用凭据数量（只有 `client_id` / 名称 / 回调地址 / 注册时间，
  不含任何摘要或密钥），并在卡片里写明开关两侧的后果。
### Fixed
- **`npm run build:core` 不再顺手删掉控制台前端。** `build:core` 走的是同一支 `scripts/clean.mjs`，
  而它整目录删 `dist/`——连同 vite 产物 `dist/ui`。**运行中的实例是按请求从 `dist/ui` 读控制台的**：
  一跑 `build:core`，正开着的网页面板立刻变成 `{"error":"Console UI is not built. Run \`npm run build\`..."}`，
  而那条提示不会告诉你是刚跑的那条命令干的（本轮就是这么把 18080 的面板弄哑的）。现在 `clean.mjs` 分两个
  范围：`all`（默认，完整构建用，全删）与 `core`（`build:core` 用，保留 `dist/ui`）；`test/clean-scope.test.mjs`
  三条用例钉住（core 保留 ui、all 全删、首次构建时 dist 不存在不算错）。
- **打开 OAuth 不再把已经持有令牌的客户端挡在门外。** `oauth.enabled=true` 而未开个人令牌门禁时，
  `authorizeRequest` 直接按 OAuth 判定并返回：一个带着有效个人令牌（`Authorization: Bearer` 或
  `?token=`）的请求照样 401——与 README「不会让原来用路由令牌或 Bearer 令牌的客户端断线」的承诺相反。
  现在只要请求**出示了**凭据，就继续走个人令牌校验（门禁开不开都校验），只有「什么都没带、只凭 URL」
  的请求才被 OAuth 拦下。个人令牌校验失败时也带上同一个 `WWW-Authenticate`，好让过期客户端改用 OAuth。
  顺带把那段声称「不会断线」却与实现相反的注释改成实情：路径里的路由令牌是路由键不是凭据，
  OAuth 关上的正是「只凭 URL」这扇门。`test/oauth-integration.test.mjs` 新增两条用例钉住行为。
- **`wait_process` / `interact_with_process` / `send_to_shell` 的时间参数不再被 NaN 打穿。**
  `Math.max(Number(args.timeout_ms ?? …), 0)` 遇到 LLM 传来的 `"30s"`、`null` 会得到 NaN：
  `setTimeout(cb, NaN)` 约 0 ms 就触发，wait_process 不等就返回、send_to_shell 直接把命令标成
  timed_out 并挂上 pendingMarker 卡住会话。这些入口（连同 `ready_timeout_ms`、`restart_process`
  的 `delay_ms`）统一走新的 `clampMs()`，非法值回落到文档默认值——与 run_command 当年修过的是
  同一类问题，这次把漏掉的三处补齐（`test/clamp-ms.test.ts`）。
- **共享 JSON 存储的写失败不再静默成功。** `withFileLock` 抢锁 60 次仍拿不到时，旧实现返回
  undefined 而 `write()` 照常 resolve——config/secrets/state 的更新可能根本没落盘，调用方却以为
  成功（症状：签发了令牌却永远 401）。现在锁超时抛错，且每个调用者的 promise 单独可拒绝（串行
  tail 依旧吞错防污染后续写入）。
- **日志轮转失败不再清空当前文件。** audit.log / bridge.log / 服务日志的轮转 rename 在 Windows 上
  因句柄占用失败时，旧回退是 `writeFile(file, "")`——把这次没能轮转的历史直接销毁。现在跳过本次
  轮转照常追加，下一次再试；最多暂时超限，不再丢历史。
- **未配置隧道域名不再是一次 ERROR。** 开箱 `open-bridge serve`（没填 ngrokDomain）以前每次启动
  都在活动日志与 audit.log 里记 "Tunnel failed; local Bridge stays up: 未配置隧道域名…"——用户什么
  都没做错，活动页首屏却永远是红的。现在按「状态」处理：一条 progress 说明 + 干净的本地模式；
  保存域名后点 Start 仍会照常发起隧道。
- **同一目录的并发 `serve` 不再产生双实例。** 原来的 runtime 记录检查是先读后写：两次 serve 在同一
  秒内启动都看不到对方，各自绑上随机端口，后写的 runtime 文件把先者藏掉。现在绑定前先在数据目录
  创建 `serve-<workspace>.lock`（`wx` 原子创建），持有方退出或 pid 已死时自动回收；`open-bridge stop` 在本目录没有实例可停时
也会清掉这种死锁文件——只清 pid 已死的，正在启动的实例照样受保护。
- **`/api/sessions/close` 的 id 前缀必须唯一。** 旧实现取第一个 `startsWith` 命中，短前缀撞上多个
  会话时会关掉插入顺序里的第一个——不一定是想关的那个。现在匹配到多个返回 400 并提示加长前缀。
- **`open-bridge logs --follow` 不再在竞态下崩溃。** 初始 `statSync` 与前面的读取之间文件被轮转/
  清空会让 CLI 直接抛错；现在从 0 开始跟踪，文件回来后继续。
- **控制台：设置页不再静默破坏或伪造配置。**
  「文件访问」的目录白名单改用 `<textarea>`——HTML 会把 `<input type=text>` 值里的换行剥掉，
  编辑一次就把多个目录合并成一个非法路径直接保存；数值字段（端口/健康检查/并发上限/日志上限）
  失焦校验失败时弹提示并回弹为已保存值，不再无声地显示一个配置里根本没有的数字；UI 边界改为
  与服务端 `CONFIG_SPEC` 一致（logMaxBytes 上限 1 GiB、并发上限 3 600 000 ms）。
- **控制台：破坏性动作补上防重。** 「创建令牌」飞行中禁用——双击曾铸造两个令牌且一次性明文被
  第二个覆盖，留下一个永远无法认证的幽灵令牌；`ConfirmButton` 支持 `disabled`，体检页「开启第二道锁」
  arming 时真正禁用；会话页「断开」进行中同样禁用。
- **控制台：轮询不再让旧响应覆盖新状态。** 状态/统计/服务/会话四个页面的轮询加了过期丢弃：
  服务页点「停止」后，一个先前发出、尚未返回的轮询曾把"已停止"又翻回"运行中"到下一轮才自愈。
  文件锁表的 React key 补上序号（两个 waiter 等同一资源时 key 曾重复）。
- **控制台小项。** 保存域名失败不再清空输入；日志 SSE 断开/重连有页面提示（此前断线段静默缺失）；
  `getJson` 对非 JSON 响应给出带 HTTP 状态的报错而非裸 SyntaxError；`vite.config.ts` 纳入
  `typecheck` 范围。

### Added
- **OAuth 2.1 授权服务器（可选，默认关闭）。** 有些 MCP 客户端只认标准授权流程，不认「URL 里
  带令牌」。打开 `oauth.enabled` 后，客户端可以走完整的 2026 规范流程：从
  `/.well-known/oauth-protected-resource` 发现，`/oauth/register` 动态注册（RFC 7591），
  `/oauth/authorize` 授权（PKCE），`/oauth/token` 换 access + refresh，`/oauth/revoke` 吊销
  （RFC 7009）。**为什么要它**：路由令牌能给「只填 URL」的客户端凭据，但给不了**按客户端签发、
  可单独吊销**的凭据——这才是 OAuth 唯一不可替代的收益，也是它不取代路由令牌、只作为第二把钥匙
  的原因（两条路并存，开 OAuth 不会让原客户端断线）。
  安全取舍写死在这几处：**只支持 S256**（公开客户端没有 secret，PKCE 是唯一持有证明，`plain`
  一律拒绝）；`resource` 必填且必须是本机（RFC 8707，否则这里签发的 token 能拿去打别的服务）；
  授权码**仅内存** + 5 分钟 TTL（重启丢掉只是让客户端重新授权，比持久化一个重放窗口安全）；
  refresh **一次性轮换**（消费与读取在同一步，重放找不到东西）；access 1 小时、refresh 30 天；
  所有密钥**只存 sha256**，与个人令牌同一套比较方式；重定向 host 走白名单且**精确匹配解析后的
  host**（`https://evil.com/?x=chatgpt.com` 不通过）；授权页的口令默认就是路由令牌，可用
  `OPEN_BRIDGE_OAUTH_OWNER` 覆盖，且受与 Bearer 同一套失败锁定保护。
  实现不引入 Express：发现文档与 bearer 校验用 v2 的 Web 标准 helper，四个授权路由按 `node:http`
  手写。新测试 `test/oauth-protocol.test.ts`（11 项，纯规则）与
  `test/oauth-integration.test.mjs`（14 项，真起进程走完整流程，含单次性、PKCE 失败、重定向
  未注册、越权 scope、跨 resource、轮换重放、吊销后 401）。
- **`logs/bridge.log` 会轮转了。** 长到上限（`logMaxBytes`，默认 10 MiB）就改名成
  `bridge.log.1`，只留上一代——和审计日志、服务日志同一套做法——磁盘不再只涨不落。
  设置页新增「日志」卡片可改上限，`open-bridge config set logMaxBytes <字节>` 也行，
  `0` = 不轮转（旧行为）。轮转失败（例如 Windows 上另一个实例正持有文件）退化为清空当前文件，
  永远不把错误抛给写日志的调用。
- **会话页补上「首次连接」与「调用数」两列。** `list_sessions` 与 `/api/sessions` 都带上
  `connected_at` 与 `calls`：前者回答"这个客户端是什么时候进来的"（此前只能看空闲时长），
  后者回答"它到底用了多少"（按会话累计，batch 内部子调用不重复计数）。
- **同一个 `/mcp` 端点现在同时服务两代协议，客户端不用选模式。** 2026-07-28 起 MCP 改成
  **按请求**：没有 `initialize` 握手、没有 session id，每个请求自带信封
  （`params._meta["io.modelcontextprotocol/protocolVersion"]` + `MCP-Protocol-Version` /
  `MCP-Method` / `MCP-Call-Name` 头）。这类请求现在走 `@modelcontextprotocol/server@2` 的
  `createMcpHandler`，`server/discover` 如实回答 `supportedVersions: ["2026-07-28"]`；
  原来的 2025 世代会话式客户端走原路径，一行未改——`eventStore` 断线续传、15 s SSE 保活、
  会话表都照旧。分流由 v2 自己的 `classifyInboundRequest` 判定（请求体是主判据），所以边界
  就是规范说的边界。工具清单、用量计数、审计行在两条路上是同一份代码。
  新测试 `test/mcp-modern-protocol-integration.test.mjs`（9 项）真起进程走 HTTP 验证两代共存。
- **工具带上了 MCP 行为标注（`readOnlyHint` / `destructiveHint` / `idempotentHint` /
  `openWorldHint`）。** 这是**纯告知**：客户端据此决定怎么展示或提示，Bridge 自身不因此
  拒绝任何调用、不裁剪工具、不新增确认。标注表在 `src/bridge/tool-annotations.ts`，
  对全部 56 个定义齐备；两代协议与「工具」页从同一处取，不会各说各话。注意几个刻意的取舍：
  能覆盖既有内容的工具（`write_file`、`run_command`、`delete_file`…）**不声明**
  `destructiveHint: false`——规范里缺省就是"可能破坏"，声明 `false` 是 Bridge 兑现不了的承诺；
  纯新增的（`create_directory`、`copy_file`）才明确声明 `false`；`batch` 继承其中最弱的保证。
- **`report_progress` 的 `phase` / `category` 改成封闭词表。** `phase` 取
  `queued|preparing|running|verifying|done`，`category` 取 `read|edit|command|test|build|other`，
  **词表外的值被丢弃**（结果里就是没有这个字段），而不是被强行归到某个默认值——否则存下来的
  值就不再反映调用方，封闭集合也就不再约束任何东西。自由文本照旧放 `message`。
  这三个词表在运行时 `Object.freeze`，因为集合本身就是成员检查读取的依据，一次误 `push` 就能
  悄悄把它撑开。`src/bridge/progress-vocabulary.ts`，测试 `test/progress-vocabulary.test.ts`。
- **每次 MCP 交换留下一条有界的追踪行。** 活动日志此前只回答"哪个工具跑了、成不成"，
  回答不了传输层的问题：这次交换是哪个协议世代服务的、耗时多少、客户端是不是没等回包就走了。
  现在每个 `/mcp` 请求结束（含客户端中途断开——`close` 事件，`end` 抓不到这种）都会记一行
  `era/method · HTTP 状态 · 耗时 · 格式 · session 哈希 · tool 哈希 · client-aborted`。
  **不泄漏是硬约束**：方法名走白名单，白名单外一律记为 `other`；session id 与工具名只留
  sha256 前 12 位（够关联两行日志，不够反推）；错误只留 16 位指纹 + 截断到 160 字符的单行摘要，
  换行折叠成空格以免一条错误伪造出多行日志；**不碰**请求体、请求头、参数，也没有任何"原始内容"
  逃生口。成功的 `ping` / `notifications/initialized` 不记（否则会把真正要看的那条埋掉），
  但失败的、被中断的一律记。`src/bridge/request-trace.ts`，测试 `test/request-trace.test.ts`。
- **停机过程在活动日志里可见。** 原来那 1.5 秒宽限是静默的：看不出是在等客户端排空、
  还是卡住了、还是把谁掐断了。现在按阶段记录——开始关闭监听 → 正在排空 N 个会话（没有会话就不记，
  空闲停机仍然只有一行）→ 全部排空 / 宽限期到、开始关闭未排空的连接 → 完成。

### Changed
- **控制台的一次整体视觉与可用性 pass。** 内容宽度 920 → 1040px，九条页签得到悬停/圆角与
  键盘焦点环，表格行有 hover、数字列用等宽数字（`tabular-nums`），输入框聚焦有 3px 光环，
  按钮 disabled 不再有假 hover 且光标为 `not-allowed`，暗色模式通过 `color-scheme` 让原生
  控件跟随主题。补 favicon（内联 SVG，data URI，符合现行 CSP）与顶栏 logo，窄屏 padding 收敛。

### Fixed
- **声明了 `resource_keys` 的进程不再在 5 分钟后丢掉资源锁。** `handOffToProcess` 把租约交给
  派生进程后**没有关掉 hold 超时定时器**，而默认 `concurrency.holdTimeoutMs` 是 300000 ms：
  一个 dev server 活过 5 分钟，锁就被 `onReclaim` 回收、`pump()` 立刻授予排队中的第二个调用
  ——此时第一个进程还在跑，两个进程可以同时占住 `port:5173`。这正好违反 README 对
  `resource_keys` 的承诺（"Two calls naming the same key never start at once"）。
  现在 `LockRelease` 带一个 `handOff()`，移交时**只关定时器、不释放锁**：holder 仍在
  `lockSnapshot()` 里、仍占着 slot，锁的寿命从此由**进程退出**决定。定时器退化为它本来的
  职责——兜住"调用没返回也没释放"的卡死。回归测试在 `test/resource-locks.test.ts`
  （短超时 + 不移交 → 仍被回收；短超时 + 移交 → 不被回收且第二个调用拿不到 key）。
- **鉴权热路径不再是每请求一次全量 JSON 解析 + 线性扫描。** `readRecords()` 每个请求都
  `JSON.parse` 整个令牌数组，`verifySecret()` 再对每条记录做 `digestEquals`（每条分配两个
  Buffer）。现在令牌以 **digest 为键**建索引做 O(1) 查找，解析结果**按存储原文缓存**：
  `SecretStore.get` 本来就在 mtime 变化时重新加载，所以原文一变（别的进程铸造/吊销）缓存即
  失效——**跨进程正确性一格没让**，而稳态下每请求只剩一次 `stat`。用内容而非 TTL 作失效键是
  刻意的：TTL 缓存会让 CLI 刚吊销的令牌在 TTL 内继续通过。`AuthFailureLimiter.evictIfFull`
  同时去掉了为了删一个条目而排序整个 Map 的写法，改成一次线性扫描。
- **一个畸形请求不再能整死 Bridge 进程。** 绝对形式的请求行指向越界端口时 `new URL()`
  抛 `ERR_INVALID_URL`，`/console/%zz` 这类非法转义让 `decodeURIComponent` 抛
  `URIError`——两者都从 async 监听器里逃到进程顶层并把进程带走，MCP 会话、后台服务、
  终端会话一起没了。现在处理器内全部兜住（400），外面还有一层 `unhandledRejection`
  记录到 `bridge.log`；`/console` 的路径也改用 `path.relative` 判定，`dist/ui-extra`
  不再被当成 `dist/ui` 内部，`..%2f` 无法上跳。
- **令牌的新增/吊销立刻生效，跨进程也是。** 授权层原先把令牌表读进模块级缓存，于是
  CLI 新建的令牌在跑着的实例上是 401，CLI 吊销的令牌要等重启才失效。现在每次都从
  `secrets.json` 读，写入时在 `<file>.lock` 内合并再原子落盘。
- **文件写入原子化，读取不再把错误当成空文件。** `persist.ts` / `file-tools.ts` 写文件
  一律 temp + rename（跨盘 `EXDEV` 退化为 copy + unlink）；`readFileOrAbsent` 只吞
  `ENOENT`（以前任何读失败都返回空串，会把「没权限」读成「空文件」并被后续写覆盖）；
  `append` 支持 `expected_sha256` 乐观校验。
- **`apply_patch` 修掉四个会静默改错/拒绝真实 diff 的形状**：`\ No newline at end of
  file` 标记、`+++ /dev/null` 的删除段、无内容的 `*** Add File`（应建 0 字节文件）、
  以及以 `--`/`++` 开头的补丁内容行不再被误认成下一个文件头；另外补了二进制/NUL 守卫、
  `(?=@@)` 边界、目标目录预检和失败回滚。
- **串流读取的窗口边界。** 范围读取在剩余尾巴很小时继续读到 EOF，好让 schema 承诺的
  整文件 `sha256` 仍然给出（深范围读大文件仍提前停止，不为此扫全文件）；`stream_search`
  修掉跨 chunk 的 CR 残留；shell 会话 marker 与 ready-pattern 扫描各自带上重叠窗口，
  不再因跨块截断而漏判或报错退出码；glob 的花括号现在按嵌套深度拆分，
  `{src,lib}/{a,{b,c}}.ts` 能匹配到 b、c。
- **锁的两处语义。** `start_all_services` / `stop_all_services` 展开成具体服务键——
  字面量 `svc:*` 与 `svc:<名字>` 从来不会冲突，全量操作可以和单个 start/restart 交错；
  `holdTimeoutMs: 0` / `waitTimeoutMs: 0` 现在真的等于「不限」（之前会把 0 当成极小值
  或反之），控制台上那两句「0 = 不限」由新的回归测试兜住。
- **控制台。** 设置页改为失焦/回车才提交（此前每敲一个字符都写一次 `config.json`，
  半截的端口号、低于下限的超时值一路弹错误提示）；令牌有效期白名单改为直接从服务端契约
  导入（UI 自己那份多出「90 天」，服务端一直 400）；会话页的 30 分钟改成实际的 60 分钟。
- **CLI。** HTTP 请求加 5 秒超时（桥接没起来时不再挂死）、`--port` 类型校验、
  `taskkill /T /F` 连子进程一起收、`unhandledRejection` 记日志。
- **A second instance no longer drops the first one's route token.** `secrets.json`
  (and, by the same construction, `config.json` and `state.json`) was read once in
  the constructor and written back whole, so two instances sharing the data dir
  each published a snapshot taken before the other's key existed — the last writer
  won and one Bridge's token vanished. All three now share one store
  implementation that re-reads when the file changes and merges immediately
  before writing, atomically (temp file + rename) so a direct reader such as the
  CLI never sees a half-written file. Writers also serialise on a `<file>.lock`
  (created with `open(..., "wx")`, with a staleness escape) and re-read inside
  it: merging "just before writing" still left a gap where two instances
  starting in lockstep each published a map missing the other's key — the first
  attempt at this fix passed on Windows and on ubuntu 22 and still lost a token
  on ubuntu 24. Found by the new multi-instance suite on Linux CI, where the
  timing differs from Windows.
- **`open-bridge stop` no longer reports failure when the instance really did
  stop.** The shutdown endpoint answers and then closes the listener, so a reset
  socket can race the reply: the CLI now retries once, treats "the process is
  gone" as success, and only falls back to killing the process when it is still
  alive.
- **控制台表格里的标识符列不再被挤成逐字竖排。** `.mono` 的 `word-break: break-all` 让自动布局
  表格中该列的最小内容宽度塌缩到 1 个字符（工具目录的名称列整列竖排），CJK 表头与徽章也会任意
  断行。现在表头不换行、表格内 `.mono` 单行 + 340px 上限 + 省略号（长内容另给 `title`），
  需要换行的长文本用 `.mono.wrap`（体检「详情」列）。会话/锁/令牌/体检/工具五个表格同时受益。
- **服务页的表格补上了 `token-table` 类**——它曾是全页唯一裸 `<table>`，无样式、与其他页不一致；
  测试现在会断言这个类，防止再次漏掉。
- **「扩展」徽章有了基础样式**（原先透明底、默认色，看起来像渲染错误）；徽章与 pill 一律不换行。
- **Toast 的淡入淡出真正生效。** 原实现用 `key` 强制重挂载，元素天生带着 `.show` 挂上去，
  过渡永远不会触发；改为常驻节点切换类，并按错误与否使用 `role="alert"` / `role="status"`。
- **浏览器标签页标题跟随页面**：`/console/sessions` 的标签是「会话 · Open Bridge 控制台」，
  同时开着几个实例的控制台时，标签页是唯一能区分它们的地方。
- **轮换端点后的自动重载走命名接缝** `reloadConsole()`：测试改为直接断言这个接缝，不再去改
  `window.location`（jsdom 与不同 vitest 池对它能否被重定义的答案不一致）。

### Added
- **「一键开启第二道锁」。** 开启 Bearer 鉴权一直是两步：先在「令牌」页签发令牌、复制，
  再回「设置」页打开开关——而这套流程恰恰是"失败关闭"设计下最容易做错的地方。现在公网可达
  且未开鉴权时，「体检」页会出现一个两步确认的按钮，一次动作 = 签发令牌 + 打开 Bearer，明文令牌
  照旧只在弹层里显示一次；开启后页面自动复检，`public-open` 会变成 `public-authed`。
  边界都处理了：已有可用令牌就复用而不是再签一个；已经开着就返回幂等的 no-op；
  万一打开开关失败，会把刚签发的令牌删掉，绝不留下"有密钥却没有锁"的中间态。
  接口是 `POST /api/settings/action` 的 `armPublicLock` 命令（标签与 TTL 都可省，缺省用配置里的默认有效期）。

### Added
- **The console has real pages, one path each.** The panel was a single page
  whose "tabs" were component state: the address bar never moved, nothing could
  be linked, bookmarked, reloaded into place or opened in a second window. Every
  page now lives at `/console/<name>` — 状态 / 会话 / 工具 / 体检 / 服务 / 日志 /
  统计 / 令牌 / 设置 — the nav items are real `<a href>` links (ctrl-click and
  "open in new tab" keep working), the address bar follows, and back/forward move
  between pages. No server change was needed: `/console/*` already answers with
  the SPA shell.
  The bundle is referenced absolutely (`/console/assets/...`) and a missing asset
  under `/console/` is a 404 rather than the HTML shell — both were real defects
  the page paths exposed: the relative form resolved against the page path, so
  `/console/sessions/` asked for `/console/sessions/assets/...` and rendered a
  blank page, while the shell-for-everything fallback turned a lost asset into a
  MIME error instead of a clear failure.
- **会话: who is connected, and a way to act on it.** `active_sessions` was a
  number with nothing behind it. `GET /api/sessions` returns the table — client
  name from the MCP handshake (`clientInfo`), idle time, in-flight requests, todo
  count — together with the file-lock snapshot, and `POST /api/sessions/close`
  closes one session without touching the instance or the other clients.
- **工具 and 体检 pages.** `GET /api/tools` returns exactly what `tools/list`
  advertises (tool profile, then the host-capability filter, with core tools
  flagged) so "54 tools" is inspectable instead of asserted. `GET /api/health`
  runs the checks server-side and really sends a request through the tunnel for
  the public leg — the only way to know a client could connect — with the
  exposure verdict next to it.
- **One Bridge per directory, and the CLI knows which is which.** `open-bridge
  serve` has always used the current directory as its workspace root, but the
  app could not actually keep that promise for two directories at once: runtime
  records went into a single shared `runtime.json`, so a second `serve` in
  another directory overwrote the first record and then refused to start at all
  ("已有实例在运行"). Records are now keyed by the same per-workspace suffix the
  route tokens use (`runtime-<suffix>.json`), the legacy file is still read for
  its own root only, and `serve` refuses only when *this* directory already has
  an instance. `stop` / `status` / `url` / `prompt` / `health` resolve this
  directory's instance, fall back to the single live one with a printed note,
  and never guess between several.
- **`open-bridge instances`** — every live instance sharing the data dir: pid,
  port, workspace, tunnel role, exposure, session and tool counts, with the
  current directory marked.
- **`open-bridge logs [--tail N] [--follow] [--clear]`** — the log file was
  reachable from the extension's terminal, copy and clear commands but not from
  the standalone CLI.
- **`open-bridge health`** — listener, workspace, state, tool count, tunnel role,
  exposure, plus a real round trip through the public URL when one is published,
  which is the only check that proves a client could connect.
- **`workspace_root` on `get_bridge_status`** and a 工作区 row in the console
  status card: with one instance per directory, "which workspace am I talking
  to" is a real question.
- **A port that is taken is no longer a dead end.** An explicitly requested
  `--port` still wins and now fails with the exact alternative command; a port
  that came from configuration falls back to an ephemeral one with a notice.
- **`test/multi-instance-integration.test.mjs`** — boots two real instances in
  two directories against one data dir and asserts the whole story: each reports
  its own workspace root, route tokens differ, `status` answers for the
  directory it is typed in, `instances` lists both and marks the current
  directory, `stop` in A leaves B serving, and a duplicate `serve` in the same
  directory is refused by name.
- `paths.workspaceSuffixFor(root)` — the per-workspace key is now derived in one
  place instead of being re-implemented wherever it was needed.

- The console gained the four surfaces the VS Code panel had and the standalone
  app was missing, each wired to the implementation that already existed:
  - **服务 tab** — the saved services (`save_service` definitions) listed with
    live state and 启动 / 停止 / 重启, behind `GET /api/services` and
    `POST /api/services/action`. `controlService()` had been sitting unused, so
    a service the agent saved could only be controlled by asking the agent again.
  - **健康检查** (状态 tab) — `runHealthCheck()`, also previously unreachable,
    now returns a structured report: the loopback endpoint answers, the advert-
    ised tunnel answers, and with the bearer gate on an anonymous request is
    really refused (a gate that silently fails open is worse than no gate).
  - **清空统计** (统计 tab) — `usage-store.resetUsageStats()` existed with no
    caller; cumulative counters could only ever grow.
  - **复制日志** (日志 tab) — the extension's `openBridge.copyLog` equivalent,
    copying the buffered stream.

- CI pipeline (GitHub Actions): typecheck, lint, build, unit + API integration
  tests, and a CLI smoke test, across Ubuntu (Node 22 / 24) and Windows (Node 24).
- README section on ripgrep resolution across platforms.
- A quick start that actually works today: the README told readers to
  `npm install -g open-bridge`, which cannot succeed until the package is
  published. It now leads with the from-source path, names the console address
  explicitly, and documents `npm start` as the one-command route. `npm start`
  runs local-only (the default tunnel provider is ngrok, so an unconfigured
  domain would otherwise warn on every start); exposing the Bridge through a
  tunnel is its own section, including the one-session-per-domain rule.
- Onboarding, reachable from all three surfaces: `open-bridge prompt` prints the
  ready-made opening message, `GET /api/prompt` serves it to local scripts, and
  the console's endpoint card gained a "复制接入提示词" button. `serve` now points
  at it in its startup banner.
- Console test suite (vitest + jsdom + Testing Library, 21 tests) covering the API
  client, the endpoint card's tunnel-vs-loopback resolution, and the app shell's
  tabs, toasts and one-time secret mask.
- `tsconfig.ui.json`, so the React console and its tests are type-checked. The
  core tsconfig only covers `src/**`, and Vite transpiles without checking types,
  so `ui/` had never been type-checked at all.
- Integration coverage for teardown ordering: a rotation must answer with the new
  endpoint before the listener rebinds, and the console's stop action must answer
  before the process exits. `test/api-teardown-integration.test.mjs` owns the
  latter because it consumes the process the main suite still needs.

### Added
- **The integration coverage the extension had and the app did not.** The VS Code\n  extension carried two end-to-end suites over HTTP that were never ported with\n  the code: a guards suite (18 checks over the bearer gate — self-lockout refusal,\n  anonymous rejection, wrong/right secret, `?token=`, the readiness probe staying\n  exempt, per-client rate limiting with `Retry-After`, revocation re-closing the\n  gate, purge/delete semantics) and a protocol suite (29 checks over session\n  identity, body limits, CORS, usage accounting, result shapes). The app's\n  integration suite covered the app-shell surface but not the guarantees the MCP\n  endpoint makes to every client — which is why an external evaluation found\n  behaviour our own suite could not. Ported and adapted to the standalone host:\n  `test/guards-integration.test.mjs` (14 checks) and\n  `test/mcp-protocol-integration.test.mjs` (8 checks), both wired into\n  `npm run test:core`. Integration tests are now 41, up from 19.\n
### Changed
- `ConfirmButton` moved out of TokensTab into its own component: the two-step
  destructive-action pattern now has one implementation instead of one per tab.
- Every swallowed error now says why swallowing is safe (ten bare `catch {}`
  blocks were documented) — a silent catch is indistinguishable from an
  oversight.

- **Minimum Node.js is now 22** (was 20.3). Node 20 reached end-of-life in
  March 2026, so it receives no further security fixes — not a defensible
  support floor for a tool that exposes a local workspace over HTTP. The old
  floor was inherited from the VS Code extension, where it tracked the
  editor's bundled runtime; a standalone CLI has no such constraint.
- **`public_url` now means what it says.** The status payload used to put a
  loopback URL in `public_url` whenever no tunnel was published, so every reader
  had to guess which of the two things it was holding — which is how the CLI came
  to print a private address under "public MCP URL", and how the health check
  came to probe loopback as if it were a tunnel. Internally the field is now
  `tunnelUrl`, set only while a tunnel is live; `public_url` is absent without
  one, `local_url` is unchanged, and a new `mcp_url` carries the URL worth
  handing to a client. `SettingsState.publicUrl` is renamed `mcpUrl` to match.

### Removed
- **`autoStart` is gone from every surface.** The key came from the VS Code
  extension, where the host provides activation; in the standalone app nothing
  read it, so the settings page offered a switch that could not cause anything
  to happen. Legacy `autoStart` values in `config.json` are simply ignored.
- Dead code, found by scanning every export for references outside its own file:
  `lifecycle.switchWorkspace` (VS Code workspace folders), `host.hostOrNull`,
  `auth.resetAuthCache`, and `src/mcp/lsp-format.ts` — 106 lines kept alive
  solely by its own test, since the Node host never advertises the editor-only
  `lsp` / `get_diagnostics` tools.

### Fixed
- **A rotation no longer interrupts the listener.** Rotating the MCP URL flipped
  the route token and then rebound the listening socket — but every route
  compares `state.routeToken` per request and the port does not change, so the
  rebind propagated nothing. What it did do was drop the listener for a moment
  (which on a loaded Windows runner surfaced as `ECONNREFUSED`/`ECONNRESET` for a
  rotation that had actually succeeded, leaving the console holding a dead token)
  and, with a tunnel up, tear the tunnel down and re-publish it — an outage risk
  on ngrok Free's one-session-per-domain budget. Rotation is now a pure token
  swap plus a refresh of the public URL and the peer registry row, and
  `restartListener()` / `SettingsActionResult.deferRestart` are gone with it.
- **The onboarding prompt no longer hands over a local-only address as if it were
  reachable.** `clientMcpUrl()` resolves correctly (published tunnel URL first,
  loopback only as a fallback), but the copied text said nothing about which one
  it held: with no tunnel the console card read "当前仅本机可访问（未开启隧道）"
  while "复制接入提示词" handed over `http://127.0.0.1:...` with no caveat — and
  that prompt exists to be pasted into a client that is usually not this machine.
  The text is now built by a pure, unit-tested function
  (`src/bridge/onboarding.ts`), the loopback variant leads with the caveat and the
  way to publish the instance, and the console toast repeats it instead of saying
  "粘贴给 AI 客户端即可".
- **The app can borrow the tunnel that is already running next to it.** The
  instance holding the public tunnel forwards requests for other instances'
  tokens by looking them up in `bridge-peers.json` — but the standalone app keeps
  that file under its own `--home` while the VS Code extension keeps it in the
  editor's `globalStorage`, so on a machine running both the tunnel answered 404
  for the app's token and the app sat in "domain belongs to another instance"
  without ever becoming routable, despite its `blocked → adoptSharedTunnel() →
  follower` path already existing. The app now advertises its row in every
  registry that already exists (its own plus the editor flavours it finds; only
  existing files are adopted, nothing is created inside another product's
  storage), looks peers up across all of them, and publishes before probing for
  adoption — so `open-bridge serve` with `ngrokDomain` set publishes a real
  public URL whenever another instance holds the domain, and takes over as owner
  when it does not. `sharedPeerRegistry` overrides the discovery with one
  explicit path.
- **The public URL now says where it comes from, and the default run can publish.**
  `getBridgeStatus()` carries `tunnel_role` (`owner` / `follower` / `none` /
  `blocked`), and the console appends "该地址由本机另一个实例的隧道转发，那个实例停止后
  此地址会失效" when the URL is borrowed — a public URL that silently depends on
  another process is the kind of thing an operator should not have to discover
  from an outage. `npm start` no longer forces `--no-tunnel` (the app is the main
  product now); local-only keeps its own name, `npm run start:local`.
- **The shared peer registry keeps one row per instance.** It merged on the token
  digest, so every rotation added a row whose digest could never match a token
  again — one dead credential entry per rotation, in a file other windows read,
  until the process exited. Publishing now replaces the row for the same pid
  (other instances untouched, re-publishing idempotent).

- **The server no longer races the client's keep-alive timer.** It inherited
  Node's 5 s `keepAliveTimeout`, which destroys idle connections; a pool that
  owns such a connection (undici keys its own timer off the advertised
  `Keep-Alive: timeout=5`, plus slack) would then reuse a socket the server had
  just destroyed and fail with ECONNRESET while writing the request — an
  intermittently red API test on CI's Windows runner, never locally. The
  listener now advertises 60 s (`headersTimeout` 66 s, which Node requires to
  exceed it), so the client is always the one to close an idle connection;
  leftovers are still closed explicitly by `stopLocalServer()`. Reproduced
  deterministically: with the default, a pooled connection idle for 6 s and then
  reused fails with ECONNRESET; with 60 s it answers 200. The api-integration
  suite now pins that behaviour.
- **A rotation or a stop could still reach the caller as a connection reset with
  no response body.** The deferral added earlier waited for the response's
  `finish` event, but the teardown then destroyed the very socket that reply had
  travelled on (`stopLocalServer` → `closeIdleConnections`), while the bytes were
  still only in the peer's kernel buffer — and Windows discards an unread body
  when a socket is reset, so the caller lost a response the server had already
  written. Measured on one machine: 2 failures in 6 runs, and 8 in 8 once the
  teardown was deferred differently. The replies that outlive their own listener
  — stop, rotate, shutdown, and the settings actions that defer them — now go out
  through `jsonAndClose()`, which marks the connection non-reusable: Node closes
  the socket gracefully (FIN *after* the body) instead of leaving one behind for
  the teardown to destroy. `/shutdown` also moved off `setImmediate` onto the
  same deferral, for the same reason. The api-integration suite passes 8 of 8
  runs after the change (it failed 2 of 6 before, and 8 of 8 with the teardown
  deferred slightly differently).
- **A tunnel ngrok refuses no longer retries forever, and no longer advertises a
  dead https endpoint while it does.** `ERR_NGROK_313` (a reserved subdomain the
  account may not serve), a rejected authtoken and a refused proxy are
  configuration errors: they fail identically on every attempt. They were treated
  as transient blips, so the reconnect chain respawned ngrok every 2 s → 5 s →
  15 s → 60 s, indefinitely, and each doomed attempt published an https URL — via
  `status`, the console and the prompt — that answered nothing. New
  `src/network/ngrok-failure.ts` recognises ngrok's own `ERR_NGROK_<code>` marker
  in the failed attempt's output (the exit code cannot be used: ngrok exits 1 for
  both kinds); such a failure is surfaced once, in ngrok's own words, and the
  reconnect chain is cancelled. Transient exits — a killed agent, a dropped
  session, a network that was not up yet — still reconnect as before.
  `waitForTunnelReady` also gained a racer for the process's `close` event, so a
  doomed attempt is reported in ~3 s instead of sitting out the 20 s
  public-health budget; and `state.tunnelUrl` is now published only once the
  tunnel actually answers, and cleared when the tunnel process dies.
- `open-bridge status` reported 「未运行」 while the console was already serving.
  `runtime.json` — how `status` / `url` / `stop` find the running instance — was
  written only after `await start()` resolved, and with a tunnel configured that
  can be seconds later (or never, if the tunnel cannot come up). The CLI now
  publishes it from a `setLocalServerReadyHook` callback the moment the loopback
  listener binds, with the post-`start()` write kept as a safety net.
- Test suite: `path casing cannot split one file's lock on Windows` asserted a
  Windows-only invariant on every platform, so it failed on Linux. It now pins
  what each platform must do — fold case on Windows, keep paths distinct on POSIX.
- Test script used a `**` glob that only Node 21+ expands for `--test`; a
  single-star pattern lets POSIX shells expand it while Windows still globs
  through Node.
- CI bumped to actions/checkout@v7 and actions/setup-node@v7 (v4 targets the
  Node 20 action runtime, which current runners have deprecated).
- `webAiPrompt()` — the "connect this MCP" text — was exported but never called
  anywhere in the standalone build. The VS Code extension offered it from its
  settings page; the port left it unreachable.
- Three `resource-locks` tests were cancelled on Node 22 with "Promise
  resolution is still pending but the event loop has already resolved". Every
  timer in `resource-locks` is deliberately `unref()`d so a pending lock can
  never pin a process open; with nothing else holding the loop in a test
  process, it drained before the deadline fired. The test now holds the loop
  open across the wait — the product keeps its `unref()` call, since a real
  server always has its listening socket holding the loop open.
- **Rotating the endpoint, and stopping, no longer reach the caller as a
  connection reset with no response body.** Both actions tore down (or rebound)
  the listener and only then replied — but the reply travels over the very socket
  they close. The console's "rotate endpoint" button therefore reported a failure
  for a rotation that had succeeded, and left the page holding a token that no
  longer worked: every action from then on answered 403 until the operator
  thought to reload by hand. Responses are now flushed first and the teardown
  runs on the next tick; a rotation also tells the console to reload, so it picks
  up the freshly injected token instead of asking the operator to guess.
- **The teardown ordering only holds if the response has actually left.** The
  first attempt deferred the stop/rebind by a tick, but `res.end()` merely hands
  the bytes to the socket; under load the client could read most of the body and
  then get a socket error as the listener went away. The teardown now waits for
  the response's `finish` event — the last byte handed to the OS — with a
  disconnect and a 2 s backstop so a stop can never be stranded.
- **A rotation no longer relocates the instance to a new port.** The default
  config asks for port 0, so the rebind that follows a rotation came up on a
  brand-new ephemeral port, abandoning everything already pointing at the old
  one: the console page that issued the rotation, the port `runtime.json`
  advertises to the CLI (`status` / `url` / `stop` all stopped finding the
  instance), and whatever the tunnel forwards to. The port the listener last
  bound is now remembered across rebinds.

## [1.0.0-alpha.1] — 2026-09-11

First standalone release: the VS Code extension (0.5.17, final) is now an
independent Node process serving the MCP endpoint and the web console from a
single port. The core (tool set, concurrency locks, auth model) carries over
byte-for-byte; the host changed from VS Code to a local CLI plus a browser
console.

### Added
- `open-bridge serve` / `stop` / `status` / `url` / `config` / `token` / `doctor`
  CLI, plus a React web console (`/console/`) with status, settings, tokens,
  logs and statistics tabs.
- Host abstraction (`src/host/`) so future shells (Tauri/Electron) implement one
  interface instead of touching the core.
- File-backed configuration and secrets under `~/.open-bridge` (override with
  `OPEN_BRIDGE_HOME` or `--home`).

### Fixed
- **Console was unopenable (deadlock).** `/console/` demanded the console token,
  but the token is delivered *by* that page (injected into `<head>` server-side),
  so no browser could ever load it. The console route is now loopback-gated only;
  the token gate applies to mutations (non-GET/HEAD) alone, which keeps the
  cross-site request path dead by construction.
- **`open-bridge status` / `url` returned HTTP 403.** Both called `/api/status`
  without the `X-Open-Bridge-Console` header, so they could never talk to their
  own instance.
- **CRASH on Windows when a CLI command exited.** `process.exit()` raced undici's
  closing keep-alive sockets, tripping a libuv assertion
  (`!(handle->flags & UV_HANDLE_CLOSING)` in `src\win\async.c`). The CLI now uses
  a one-shot `node:http` request with `agent: false` for every local call.
- **`tool_count` disagreed with `tools/list`** (reported 56 where 54 are
  advertised). The catalog is now computed in one place
  (`src/bridge/tool-catalog.ts`) and shared by `tools/list`, `getBridgeStatus`
  and `workspace_brief`.
- CLI printed "public MCP URL: http://127.0.0.1:…" with no tunnel running. The
  label now only appears for a real `https://` tunnel URL.
- README stated 56 tools where the standalone advertises 54 (56 definitions
  minus the editor-only `lsp` / `get_diagnostics`).
- Bundled ripgrep resolution is platform-aware: `vendor/rg.exe` on Windows,
  `vendor/rg` elsewhere, PATH's `rg` as fallback, built-in scanner as the last
  resort.

### Tests
- 258 unit tests and 9 API integration tests (up from 7). New coverage locks in
  token-free loopback reads, the console page being loadable without a token,
  and the CLI `status` / `url` commands exiting cleanly against a live instance.

