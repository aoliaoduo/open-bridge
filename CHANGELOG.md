# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **控制台的一次整体视觉与可用性 pass。** 内容宽度 920 → 1040px，九条页签得到悬停/圆角与
  键盘焦点环，表格行有 hover、数字列用等宽数字（`tabular-nums`），输入框聚焦有 3px 光环，
  按钮 disabled 不再有假 hover 且光标为 `not-allowed`，暗色模式通过 `color-scheme` 让原生
  控件跟随主题。补 favicon（内联 SVG，data URI，符合现行 CSP）与顶栏 logo，窄屏 padding 收敛。

### Fixed
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

