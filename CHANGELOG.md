# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`notify` 新增 `waiting` 事件：AI 提问后必须推送，否则对话会卡死。** 起因是一个真实的失败模式：AI 在对话里请用户做选择，用户不在电脑前，没人回答 —— 对话就永远停在那里。从服务端看，「AI 答完了」和「AI 在等你选」**是同一个观测结果**：调用停了。服务端分不出来，也不该猜，所以让模型自己说：问完问题立刻发 `waiting`。它和 `attention` 一样**不受任何开关影响**，永远送达 —— 没人回答的问题会无限期阻塞对话，那不是设置该吞掉的东西。工具描述、连接指令与 `docs/tools.md` 都把这条写成硬要求。

- **控制台与 CLI 讲两种语言了：中文 / English。** 这个项目一直只有中文界面，而它要接的 MCP 客户端和用它的人并不都读中文。现在控制台按浏览器语言自动选，顶栏那个按钮在**跟随系统 → 中文 → English** 之间轮换并把选择记在 `localStorage`（刷新、重启都还在）；CLI 没有浏览器可问，就按 POSIX 的老规矩读 `LC_ALL` → `LC_MESSAGES` → `LANG`，另给一个 `OPEN_BRIDGE_LANG` 强制覆盖——系统是英文但想看中文输出的人，不该被迫改整个 locale。

  译文**成对内联**写在用到它的地方（`t("中文", "English")`），没有集中的消息表，也没有 key。理由很实际：改一句文案时两种语言就在同一行，漏译当场可见；而消息表最常见的结局是 key 还在、某一种语言的值早已过时，且谁也不知道。两个参数都是必填的，半边翻译根本编译不过。

  两处坑值得记下来。其一，`STATE_LABEL`、`ACTIVITY_LABEL` 这类模块级映射表全部改成 getter（`() => string`）：模块初始化只发生一次，若存的是字符串，切语言后拿到的仍是首次加载时那门语言。其二，有个 `kind: "持有" | "等待"` 被当成**比较用的值**而不只是展示文本，翻译它会让判断在英文界面下静默失效——先换成英语哨兵值，再在渲染处翻。文件锁那一栏的中英切换就是靠这个才没坏。

  另外 jsdom 的 `navigator.language` 是 `en-US`，于是上线自动检测后，所有断言中文的既有 UI 测试会集体变红——不是代码坏了，是测试环境默认成了英文。新增的 `vitest.setup.ts` 在每个用例前把语言钉死在中文，让语言成为显式前提而不是运气。

- **控制台新增「任务」页：看得见 AI 正在做什么。** `set_todos` 写的清单从第一天起就存在（`todo-store.ts` 按工作区持久化、断线也留着），但控制台里它只以**一个数字**露过面——会话表里那列 `todos: 3`。于是「有个 AI 在忙」看得到，「它在忙什么」看不到，而后者才是人盯着屏幕时唯一想知道的事。现在是真正的清单：进度条 + `已完成 N/M`、**正在做的那条单独提到最上面**（Cursor/Codex 那种一眼看到当前项的读法）、每条一个状态图标（已完成打勾、进行中转圈、待办空心圈）、完成项标题划掉。数据走新端点 `GET /api/todos`，2 秒轮询，带**过期响应守卫**（沿用服务页那套 `pollSeq`，防止先发后到的慢响应把新答案盖回旧的）。

  **刻意只读**：清单是 AI 的工作记忆，控制台若能替人勾选，就等于在对面跑到一半时改它的计划，两边会对「做完没有」产生分歧。页面只呈现，不写入。

  数据源有两个且**故意不合并**：有活跃 MCP 会话时读会话里的实时清单，没有就回落到持久化存储，并用 `stale` 字段明确标成「已离线」——上一个 AI 断开时留下的计划仍然有用（崩掉的网页 AI 正是无反应监视要处理的场景），但它**不能看起来像正在推进**。空清单不是空白页，而是告诉你「连上来的 AI 调用 set_todos 后计划会出现在这里」。另外 `report_progress` 的最后一行也终于有了去处，作为「最新进展」卡片显示。转圈动画遵守 `prefers-reduced-motion`。

- **手机通知（Bark）：网页 AI 干活时把进展与「需要你回来」直接推到 iPhone。** 控制台「设置 → 手机通知」粘贴 Bark 显示的整条链接（`https://api.day.app/<设备密钥>/…`），写入即解析出密钥；两种模式：**频繁**（任务清单每勾选完一条，服务端在 `set_todos` 落盘时自动推一条汇总，不靠 AI 自觉）与**免打扰**（只送 attention/finished——需要选择/回复、对话结束；进展类一律 `delivered:false, reason:"mode"`，是结构化的「没送」而非错误）。新增 MCP 工具 `notify`（`event`: progress/attention/finished，39 个工具）；连接指令随配置注入使用说明（会话建立时快照，模式判定每次发送实时读）。**无反应监视**：连接静默超过 `notify.idleMinutes`（默认 60，0 = 关）且清单还有未完成项时服务端自己推一条 attention——网页 AI 标签页崩死时唯一能叫回人的通道（骑在既有 60 秒会话清扫节拍上，不新增定时器）。防轰炸：真实发送共享 60 秒 6 条窗口 + 相同内容 60 秒去重，被挡的调用得到结构化原因；控制台「发送测试」是人手动作，绕过账本但保留开关/模式判定。**密钥单进不出**：`get_config`、`set_config_value` 回显、设置页视图、审计摘要、运行日志一律掩码或形状（`set_config_value` 写入 barkKey 的审计行记 `<set:N chars>`）；发送走既有 `probeHttpHealth` 通路（先解析后钉 IP、不跟随重定向、只读响应头），`notify.serverUrl` 默认官方 api.day.app，自建服务仅允许 https 或回环 http。

- **设置页拆成真子页面**：`/console/settings/<段>`（`tunnel`/`network`/`files`/`shell`/`notify`/`locks`/`logs`），原「单页长滚动 + 锚点跳转」改为每个子页一个真实路径——地址栏可深链、可刷新、前进后退可用；页头随子页显示对应标题与说明；侧栏与旧书签（`/console/settings`）落在默认「隧道」页。`SectionNav` 由内部锚点滚动改为受控路由切换。
- `notify` 支持 AI 按次自选 Bark 推送参数：`sound`（铃声）、`level`（`active`/`timeSensitive`/`passive`）、`call`（1 = 持续响铃，上限 10）、`badge`（0-9999）、`url`（点击跳转）；非法值按参数名拒绝。无反应监视与控制台测试推送固定 `timeSensitive`。无反应提醒默认值 10 → 60 分钟。

### Changed
- **通知从「频繁 / 免打扰」二选一，改成两个独立开关。** 原来 `notify.mode` 是个 enum，于是「每项任务完成都通知」和「对话结束时通知」**只能选一个** —— 而这两个恰恰是最该同时打开的组合。现在是 `notify.onTaskDone` 与 `notify.onFinish`，可以都开、都关、开一个。被开关挡住的事件返回 `delivered:false, reason:"switch_off"`（原 `"mode"`）。旧的 `notify.mode` 写入会被**明确拒绝并告知新键名**，而不是静默忽略：还在用旧键的脚本应该收到报错，而不是眼看写入成功却什么都没发生。

- **服务端兜底通知不再断言「对话已结束」。** 45 秒静默后那条推送原文是「这轮对话已经结束」，但服务端根本没有能力区分「答完了」和「在等你回答」——**有一半的时候它在撒谎**，而且是朝着代价更大的方向撒：看到「已结束」的人不会赶回来回答一个正卡住全局的问题。现在措辞改成「AI 停下了 —— 可能在等你回复，也可能已经做完。去看一眼。」一条通知覆盖两种情况，不误导。

- **拆分 `src/cli.ts`：1111 行 → 418 行，其余按「命令需要什么」分到 `src/cli/` 六个模块。** 原文件里唯一的边界是注释横幅。新的分组依据不是字母序，而是**每个命令依赖什么**，因为那决定了它会怎么失败：`query-commands`（stop/status/url/prompt，需要一个活着的实例）、`inspect-commands`（instances/logs/health）、`local-commands`（config/token/doctor，只碰本地数据目录）、`registry`（运行时记录 + 回环 JSON 客户端）、`args`、`format`、`version`。`cli.ts` 只留三样：帮助文本、`serve`（唯一在本进程里启动整个 Bridge 的命令）、分发表。

  一个约束值得记下来：`AGENTS.md` 规定 `node-host.ts` **只许有两个 import 方**，而拆分天然会诱导新模块直接去 import 它。这里改成由入口点**注入**（`setDefaultHome` / `setHostInstaller`）——拆文件不该悄悄放宽架构约束。复核命令仍是恰好 2 条命中。

- **`AGENTS.md` 里「核心零宿主依赖」那句改成了可验证的说法。** 原文读起来像「`src/bridge|http|mcp|network|process|shell|workspace` 不许 import `node:fs`」，而实测核心里有 17 个文件直接用 `node:fs` / `node:fs/promises`、8 个用 `node:child_process`（`file-tools.ts` 是个文件工具，它当然要用 fs）—— 省字的架构描述，正是下一个改代码的人拿去"清理"正常代码的依据；本仓库已经为「与代码不符的注释」修过 6 处，这是同一类病。真正的约束从来是**依赖方向**：`node-host.ts` 只允许被 `src/cli.ts`（安装宿主）与 `src/server/api-router.ts` import，`grep -rnE 'from "[^"]*node-host\.js"' src/` 恰好 2 条命中即为干净 —— 这条命令本身也是现写的现验：第一版写成 `grep -rn '"node-host' src/`，实测**零命中**（真实 import 是 `from "./host/node-host.js"`，引号后面紧跟的是 `./`，不是 `node-host`），照着它去"复核"会得到「怎么到处都没引」的错误结论。写一条检查命令，就得连它一起证伪。`src/host/host.ts` 的模块头同一种措辞一并改准 —— 它还自相矛盾：写着核心 "must never import a host API directly"，而核心每个模块都 import 本文件的 `host()`。顺带补上 `AGENTS.md` 漏记的两件事：这份文件会被注入给每个连上实例的模型（`mcp-endpoint.ts` 各切 8000 字符，写错一条就被反复消费，所以别把 README 抄进来）、UI 测试跟组件放在 `ui/src/**` 而不是 `test/`（`vitest.config.ts` 的 include 只认那个位置，放错就是静默不跑）。
- **新增 `CLAUDE.md`：一行指针，正文永远只在 `AGENTS.md` 维护。** 服务端本来就会把根目录的 `AGENTS.md` 与 `CLAUDE.md` 都注入连接说明、README 也早就这么承诺，而仓库里只有前者 —— 默认读 `CLAUDE.md` 的工具于是拿到零份约定。是指针不是副本：两份"约定"必然漂移成互相矛盾的说法。
- 控制台导航重组：新增「安全」页收敛暴露面、Bearer 门禁、个人令牌与 OAuth 2.1（原「令牌」页、体检页暴露面卡、设置页 OAuth 卡迁入），「第二道锁」退役统一叫 Bearer 门禁，路由令牌不再称为凭证（只是地址）；体检回归只读诊断，状态页警告改为跳转；文件锁表以「文件锁明细」搬到状态页；/console/tokens 跳转新页，书签不断。纯前端重组，后端 API 零改动。
- **行为不变的重复合并与清理：**UI 里「暴露面 → 文案/语气」原本在状态页与安全页各养一份且措辞已漂移，合并为 `ui/src/exposure.ts` 一张表；`regex-worker` 两个仅差一行输入形状的 worker 源（行批量匹配 / 单次测试）合并为一个；`theme.ts` 只被测试引用的三个函数收回私有；`App.tsx` 拆掉只有一个实现的 `SettingsStateGuard` 中转层；`paths.ts` 删掉无人用的 `unrestricted()` 转发；`processes.ts` 删掉一段重复注释；`session-table` 把 `pruneSessions` 与 `makeRoomForSession` 逐字重复的 LRU 驱逐块提取成 `evictOldestIdleSession()`；`safe-probe.classifyIpv4` 删掉三条永远走不到的保留段子句（`100.100.100.200` 已被 100.64.0.0/10 覆盖，`192.0.2.0/24`、`192.88.99.0/24` 已分别被更宽的 192.0.0.0/16、192.88.0.0/16 判断覆盖），分类行为逐 IP 不变；一键启动脚本的示例路径从作者本机桌面换成通用示例。

### Fixed
- **通知的审计行现在说的是实际发生的事。** 三个毛病挤在同一行代码里：`record("notify", "progress", ...)` 把活动状态**写死成 progress**，于是一条成功送达的 `finished` 事件在日志里长成 `[notify] progress: push finished` —— 「progress」在这里同时是活动生命周期状态和通知事件类型，两个意思撞在一行；这行还写在**发送之前**，所以网络失败时它已经宣称推送过了，而控制台活动面板会把它永远画成「进行中」，因为没有任何后续把它移出那个状态。现在状态由真实结果推导：送达记 `completed: sent <event>`，失败记 `warning: send failed (...)`。

  顺带补上一个真正的缺口：**被挡住的推送以前完全不写日志**，每条 gated 分支都是静默 return。于是「我手机怎么没响」这个问题在日志里查不到答案 —— 上个提交加的两个开关还让这件事更严重了，因为「合理地不响」的路径变多了。现在会记 `warning: not sent (switch_off|duplicate|rate_limited)`。唯一的例外是通道本身被关掉或没配密钥：那是用户自己按的开关，每次 set_todos 都警告一遍只是噪音。这条行为由集成测试钉住了 —— 原来那行从来没有测试，这正是它能漂这么远的原因。

- **AI 做完却忘记发通知时，服务端替它说一声。** 既有的无反应监视只管「有未完成任务却长时间没动静」——它的判据里明确要求**存在未完成项**。这就漏掉了正好相反、而且更常见的一种：模型勾完最后一条、在聊天里写完总结，然后**根本没调 `notify`**；不盯着标签页的人因此什么都不知道。指望模型自觉是已经反复失败过的办法（本轮对话里就连续漏了两次），所以改由服务端陈述它自己看得见的事实。

  触发条件收得很紧，因为**误报「已完成」比漏报更糟**：清单存在且**全部完成**、当前**没有请求在飞**（不是做到一半）、最后一次调用后**静默满 45 秒**（留出「`set_todos` → 总结 → `notify`」这个自然收尾的时间，让模型自己的通知先发，本机制绝不抢跑）、且**该完成时刻之后 AI 没有自己推送过任何东西**。闩锁用的是完成时刻，因此一份清单只播报一次，新任务推进了时刻才会重新武装。跑在既有的 60 秒会话清扫节拍上，**不新增定时器**，`idleMinutes = 0` 同时关掉两个监视（不另造开关）。

  「AI 自己发过就闭嘴」这一条是靠**任何一次成功推送都打标记**实现的，这顺带让它自动适配两种模式：频繁模式下清单勾完时完成推送早就响过了，标记已置位，兜底保持沉默；免打扰模式下那些推送被压制、标记不会置位，兜底就成了唯一会出声的东西。判定逻辑是纯函数 `finishNoticeVerdict`，7 条单元测试逐条钉住上述每个条件（含「一份清单只播报一次」和「idleMinutes 很小时结算延迟随之缩短、不会反过来超过阈值」）。

- **日志时间戳按本机时区显示，不再是 UTC。** `bridge.log` 与控制台日志流同源（`FileLog.write()` 一行字符串同时喂给 SSE 监听器和文件），行首时间戳一直是 `new Date().toISOString()` —— 恒定 UTC。在 UTC+8 的机器上，控制台里刚刚发生的一条 `[run_script] running: …` 显示成 8 小时前，人要在脑子里做时区加法才能把日志行和自己刚做的动作对上。现在改用本机挂钟时间并**把偏移量写进文本**：`[2026-09-14 20:02:43.248+08:00]`。保留偏移是有意的——日志文件会被拷走、会被贴进聊天窗口，裸的本地时间一旦离开这台机器就无法解释。格式仍是**前缀零填充、字典序即时间序**，`tail`/`sort`/肉眼扫读都不受影响。**只改人读的这一处**：`audit.log` 的 `at` 字段仍是 ISO-8601 UTC，因为 `activity_log` 的 `since` 过滤会把它反解析成毫秒（`src/mcp/activity-log.ts`）—— 机读要绝对时刻，人读要挂钟时间，这本来就是项目既有取向（内存活动视图早就用 `toLocaleTimeString()`）。仓库里没有任何代码回读这个前缀（已 grep 证实），唯一断言旧 ISO 形状的是 `test/file-log.test.ts` 自己的一条正则，已随之更新；`test/ngrok-failure.test.ts` 里的 ISO 前缀是喂给 ngrok 错误解析器的固定 fixture，不经 `FileLog.write()`，不受影响。

- **无法识别的 `TZ` 会让整个进程静默跑在 UTC —— 现在启动时自动纠正，并由 `doctor` 报出来。** 上面那条改完后实测**仍然**显示 `+00:00`，根因不在代码而在环境：`~/.bashrc` 里的 `export TZ=CST-8`。这是 POSIX 风格的写法，glibc 和 Git Bash 都认（`TZ=CST-8 date` 确实给 `+0800`），但 Node 走 ICU，只认 IANA 名称 —— `Intl.DateTimeFormat().resolvedOptions().timeZone` 返回 `Etc/Unknown`，于是 **Node 一声不吭地把整个进程跑在 UTC**，而系统时区明明是 China Standard Time。没有报错、没有警告、没有日志，唯一症状就是「时间看着不对」，而人第一反应永远是怀疑代码——这次就是这样，改完格式化逻辑才发现真凶在别处。

  更麻烦的是**没有一个 `TZ` 值能同时满足两边**：`CST-8` 对 Git Bash 对、对 Node 错；`Asia/Shanghai` 对 Node 对、对 Git Bash 反而错（实测输出 `+0000`）；只有**不设 `TZ`** 两边才都正确。所以这不能靠「让用户改配置」了事，程序自己得扛住：`main()` 在任何代码有机会打日志之前调用 `normalizeTimezone()`，把 POSIX 写法折算成等价的 IANA 零区名 —— `CST-8` → `Etc/GMT-8`（POSIX 与 `Etc/GMT*` 用的是**同一套反转符号**约定，整点偏移可以原样搬过去，符号不会错）。

  刻意做得很窄，因为「猜」在这里是有代价的：**只在时区已经解析不出来时才动手**（此时进程已经确定是错的，没有正常行为可破坏），**只接受「缩写 + 整点偏移」**，折算完还要再验一次、没变好就原样退回。带夏令时规则的、半小时偏移的（`IST-5:30`）一律不碰 —— `Etc/GMT*` 不含夏令时，硬折算等于把「明显错」换成「隐蔽地错」，那更糟。

  `doctor` 相应新增 timezone 一项，并且**区分三种状态**而不是简单的对错：解析不出来 → `[!!]`，把那个值原样引回来并给出可用的 IANA 名称；被自动折算过 → `[OK]` 但明说「偏移已对，但这是折算来的固定偏移、不含夏令时，根治办法是去掉 shell 配置里那行 `TZ`」；本来就正常 → `[OK]` 回显时区名与**它将要写进日志的那个偏移**（`Asia/Shanghai（+08:00）`），让人一眼确认，而不是等下次读日志时再嘀咕一次。三种状态都有测试（`test/cli-surface-integration.test.mjs` 用子进程 env 分别注入 `TZ=CST-8`、`TZ=IST-5:30`、`TZ=Asia/Shanghai`），外加一条单元测试钉住「环境正常时它必须完全不作为」。

- **刷新 `/console/logs` 之后日志是空的，而磁盘上的 `bridge.log` 有两万多行。** `LogsTab` 的行数组每次挂载都从 `[]` 开始，而它唯一的数据源 `/api/logs/stream` **只推送连接之后新产生的行**，从不回放历史 —— 于是每次刷新都退回「等待日志…」，在一个安静的实例上永远停在那里，看着像功能坏了。全仓库搜过 `onLine|logs/stream`，喂这条 SSE 的地方只有 `api-router.ts` 一处，**没有任何补拉端点**，所以这不是前端少了一次请求，是服务端从来没提供过历史。现在 SSE 一连上先回放文件尾部再转直播：`recentLogLines()` 用 `fs.open` 从**文件末尾**读一个 512 KiB 的窗口（日志按 10 MB 轮转，不把整个文件读进内存），丢掉窗口边界上那半行，取最后 800 行 —— 与前端本来就有的 800 行上限对齐，免得回放比前端肯留的还多。回放走**与直播同一个 `redactSensitiveText()`**：两条路进的是同一个浏览器，脱敏就不该有两套。读不到文件（首次运行、正在轮转）时回放为空而不是让整条流失败 —— 历史是锦上添花，直播才是这条流的本职。`--- log stream connected ---` 仍然是回放与直播的分界，集成测试拿真实 SSE 帧断言「新连接的首批帧里有既有日志行」，并先证伪过：把回放循环删掉，它确实红。
- **对话结束的通知不再挂在任务清单上。** 服务端兜底的 `finishNoticeVerdict()` 原先第一道门就是 `if (!hasTodos || !allCompleted) return false` —— 也就是说**只有写过清单、且清单全部完成**的会话才配得到一次推送。可日常里占多数的恰恰是没有清单的那种：问一个问题、跑一条命令、改一个文件，结束得同样真实，人也同样不在电脑前，而这套机制对它们完全沉默，等于为最需要它的场景关掉了自己。现在「没有清单」是一种合法的结束，只有「**有清单但没做完**」才否决 —— 那份沉默属于上面那条闲置看门狗，两条看门狗不该为同一段沉默各响一次。两种结束给两种沉淀期，因为证据强度不同：清单整份翻完是一句明确的「做完了」，沿用 45 秒，让走开的人一分钟内听到；**没有清单时唯一的证据只有沉默本身**，而沉默也可能只是人在读一段长回答，所以必须等满运维自己设的整个 idle 阈值，否则就会在对话中间喊「已完成」。`completionSnapshot()` 相应地在无清单时用**最后一次调用的时间**当闩锁键：原来那个 `completedAtMs = 0` 会让每一次推送都被否决，不改这里，上面的解绑一行也不会生效。推送文案区分两种结束，手机上扫一眼就知道是哪一种。
- **`read_files` 的 `sha256` 会在截断读时整个消失，而不是给 `null`。** 工具说明与 `docs/tools.md` 都写着「返回的 `sha256` **始终覆盖整个文件**，可作 `expected_sha256`」，连接说明里还有一条总契约：「absent facts are explicit nulls or empty strings, so parse by field name and **never by line presence**」。实现却是 `...(fullyRead ? { sha256: r.sha256 } : {})` —— 键被 spread 掉了。后果是 `'sha256' in result` **随文件大小与读法静默翻转**：同一个文件，整读有键、`max_bytes` 截断没键，而「读 → `expected_sha256` 写」这条乐观并发链在截断读之后直接断掉，且沿途不报任何错。**行为本身（不为了一个哈希去重读 2 GB 文件）是对的，改的是字段形状**：现在恒为 `sha256: string | null`，`lines_total` 与两条 base64 路径（含 `readAsBase64` 的 `sha?: string` 签名）同一类问题一并改齐；截断读后要摘要就用 `get_file_info`，文档改成说这件事。`readAsBase64` 的截断分支原本连**前缀的哈希**都不给（正确，给了会让每一次 `expected_sha256` 写入都失败），现在显式写成 `null` 并注明原因。
- **这个洞能溜过 139 条集成测试，是因为 `sha256` 的断言全都在 `streamReadLines` 的单元测试里**，而那一层**内部一直是 `sha256: null`**（`stream-read.ts:51` 的返回类型就这么写的）—— 把键 spread 掉的是上面的工具处理器，单元测试在结构上就看不见它；`max_bytes` 在整个 `test/` 目录只出现过 1 次。新断言因此加在**工具边界**（`test/file-op-guards-integration.test.mjs`，走真实 HTTP 的 `tools/call`），并且是先证伪过的：把修复还原成旧写法，它确实红。
- **CORS 头从「对所有响应发 `*`」改成「只发给需要被浏览器跨源访问的路径」，堵住路由令牌的外泄。** `http-listener.ts` 原先在进入路由之前，无条件给每个响应挂上 `Access-Control-Allow-Origin: *`（连带 `/api`、`/console`、`/healthz`），而 `/api` 有**三条只读接口的回包里就带着路由令牌**：`settings`（`state.mcpUrl`，注意信封是 `{ ok, state }`，不是顶层字段）、`prompt`（给客户端粘贴的接入文本）、`status`。回环 Host 门在这里保护不了任何东西：真正危险的读发起方就运行在同一台机器上，它发往 `127.0.0.1` 的请求完全满足那道门，浏览器只要允许跨源读就拿到令牌；私有网络访问（PNA）是各家浏览器的策略而非规范，服务端不能拿它当防线。现在 CORS 只授予 `/mcp/`、`/oauth/`、`/.well-known/`（浏览器托管的 MCP 客户端要走端点与授权流程），管理面回到它本来就该有的「仅同源」—— `api-router.ts` 的安全模型注释早就写着「不发出 CORS 头」，那条一直是假的，现在它成了事实并被 `test/api-integration.test.mjs` 两侧钉住（带令牌的读没有授权、`/mcp` 的预飞行仍有授权；连「回包里确实有令牌」这半边也钉住，否则下一个人只会觉得那道断言多余）。写操作侧不受影响，它靠的是 `X-Open-Bridge-Console` 不在 `Access-Control-Allow-Headers` 白名单里。
- **实例打自己端口的两条自检，会在停机时把整个进程崩在 Windows 的 libuv 断言上。** 现场：CORS 改动落地后，`api-integration` 末尾「shutdown endpoint stops the process」拿到的退出码是 `3221226505`（`0xC0000409` fastfail），serve 自己吐的最后一行是 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` —— 一次干净停机长得像崩溃。第一反应是「新测试害的」，而这条**证伪**得很快：把新测试整条 skip 掉，崩；只留两条老测试（体检 + shutdown）也崩。真正的原因在 `runHealthCheck` 与启动自检：它们用**全局 `fetch` 打自己的 `127.0.0.1:<port>`**，undici 的全局 dispatcher 于是把这条回环连接留在**同一个进程**的 keep-alive 池里；收尾时 `closeIdleConnections()` / `closeAllConnections()`（`http-listener.ts:59,81`，为的是别让活跃连接把停机挂死）摧毁服务端那一侧，客户端句柄还活着，libuv 断言直接 abort。修法是新增 `src/bridge/self-probe.ts`：本地自检一律走 `node:http` + `agent: false`，读完就关，池子里不留自连接（`agent:false` 就是全部机制，不是又一层抽象）；公网隧道那条**故意**继续用 `fetch` —— 它打的是别人的主机，8 秒预算的语义属于那条路。**一条没解释清的观察留在这里，别装作知道**：那四个 CORS 头存在与否决定崩不崩（把 `corsGrant` 恒真 → 2/2 干净；在非授权路径上改加一个无关头 → 照旧崩），所以诱因不是响应大小也不是时序抖动，但未消费的响应体、我的测试、策略本身都被逐个排除过；能实测到的范围是：**进程自己池化的自检连接**在收尾时被摧毁 → abort；这与 CORS 无关（CORS 只是改变了哪条路径带那四个头）。**「为什么四个头左右了崩不崩」已经查清**（见下条），此处不再是悬案。顺手把 `assert.equal(code, 0)` 改成把 serve 的输出尾巴放进断言消息 —— 光一个 `3221226505` 在 Windows 上永远查不动。
- **上条留作待查的「为什么那四个 CORS 头决定崩不崩」，查清了：诱因是响应头的**数量**，不是 CORS，也不是响应大小。** 拿一个 40 行的最小复现脚本把变量一个一个拧（同进程建 server → 用全局 `fetch` 打自己 → 照 `http-listener.ts` 的顺序 `closeIdleConnections()` / `closeAllConnections()` / `close()`），在 Node 24.18.0 / Windows 上得到一条很干净的阶跃：**6 个额外响应头干净退出，7 个就 abort**（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94`，退出码 `3221226505`），8 个、16 个照崩。**「是不是响应变大了」这条直接被证伪**：把同样的字节数塞进**一个** 400 字符的头里，完全干净 —— 所以起作用的是头的**条数**（undici 解析响应头时的分块/回调次数），不是总字节。那四个 CORS 头当初之所以像开关，只是因为它们恰好把某些路径的头数推过了这道坎；换四个无关的头一样崩，这也解释了当时「加一个无关头照旧崩」那条观察。**真正的必要条件仍然是自连接**：同样的头数，把客户端换成 `node:http` + `agent: false`（也就是 `self-probe.ts` 已经在做的事），8 / 16 / 32 个头**全部干净退出**。也就是说修复本身没选错，只是当初没能解释触发阈值；现在两半都对上了 —— 池化的自连接是必要条件，头数≥7 是把它引爆的那一下。复现脚本是一次性的，结论记在这里，不留进仓库。
- **`search_files` 不再为必然失败的正则白烧一个 ripgrep 进程，也不再只留一句没有信息量的「ripgrep failed」。** 内置扫描用的是 JS `RegExp`，而 ripgrep 默认引擎**不支持先行/后顾（`(?=`、`(?<=`…）与反向引用（`\1`）**：这类查询每次都派生一个进程、拿一次 exit 2、被 catch 成审计日志里那句不带原因的 `ripgrep failed; using built-in scan.`（`record` 是 `progress`，永远进不到调用方的结果里）。这条消息在仓库根那份运行残留的 `audit.log` 里出现过 27 次，而在在线实例的 `~/.open-bridge/audit.log` 里是 0 次 —— 因为消息本身不带原因，无法把这 27 条归因到某一类正则，**能确定的是机制存在**（先行/后顾与反向引用必被 rg 拒绝，`test/search-ripgrep.test.ts` 拿真实二进制对过）。现在 `ripgrepPatternRejection()` 在派发前认出这些构造、直接走内置扫描并把**构造名**写进审计；真失败时（非法正则、读不了的目录）把 ripgrep 自己的诊断压平限长带出去，下次再出现就有据可查。判定只是路由提示，**判错也不会改变答案**：漏判 → rg 报错 → 照旧回落到同一个引擎；误判 → 少跑一次进程，慢一点。`test/search-ripgrep.test.ts` 里那条交叉断言拿真实二进制核对「检测器说是的，rg 真的拒绝」；`docs/tools.md` 补上两个后端的语义差别，免得把空结果当成没命中。
- **`run_script` 沙箱 worker 源码混入 TypeScript 注解，Node 22 上整个工具瘫痪。**`SCRIPT_WORKER_SOURCE`（`String.raw` 模板）里的 `makeHarness()` 在上一次重构时带上了 `: Record<string, unknown>` 等注解——worker 用 `eval: true` 以纯 JS 解析这段字符串，而 Node 22.x（`package.json` engines 下限、CI 矩阵最低档）对 eval 源码不做类型剥离，解析即 SyntaxError，每次 `run_script` 都以 worker 错误收场；本机 Node 24 恰好默认剥离 eval 的类型注解才一直没暴露。字符串内容本就逃过 tsc 与 eslint，这次把注解还原为纯 JS，并在原位注明「这串只能是 JS」的原因。
- **控制台 OAuth 客户端「注册时间」显示成 1970 年。**服务器按 RFC 7591 存秒（`client_id_issued_at: Math.floor(Date.now()/1000)`），安全页却把秒直接喂给要毫秒的 `new Date()`，每行都渲染成 1970 年；现在乘 1000 再渲染，测试夹具改为真实的秒值并断言不再出现 1970。
- **终端输出对齐：手工垫空格改按显示列宽对齐。**中文/全角字符占两列、按字数只算一个，手工垫空格必然错位（`serve` 横幅里「本地/公网 MCP URL」的值就比别的行后退了一列）。`src/cli.ts` 新增 `displayWidth`/`padLabel`，横幅、`status`、`health`/`doctor`、`config list`、`token list`、`instances` 的标签列统一走它（纯 ASCII 标签输出不变）；告警块第二行改为与首行同级缩进（不再假设 ⚠️ 占两列）；`test/display-width.test.ts` 钉住列宽语义。README 架构图的改成两个 Markdown 表格（流程 + 出口：渲染器自动对列，不依赖等宽字体、前导空格和任何宽字符的宽度），serve 示例输出去掉行首缩进，并把三处「宿主能力过滤 / 40 个定义」的过期说法改成 v6 之后的现实（当时 38 个定义、只剩配置档过滤；同一未发布周期里加进 `notify` 之后是 39，以 `README.md` 与运行中的 `tools/list` 为准）。纯显示层改动，不碰任何行为。
- **`README.md` 与 `docs/tools.md` 各有一条 bullet 被逐字粘贴了两次。** notify 那轮往两份文档里加说明时贴重了：README 的「无反应监视」连着两行完全相同，`docs/tools.md` 的「模式是服务端门，不是约定」在两条其它 bullet 之间又出现一次。两份各删重复的那一份。之所以一直没被发现：钉文档的那组测试只要求「每个工具都被覆盖、且两个共有小节还在」—— 重复一条既不违反覆盖也不违反预算，**覆盖率测试看不见冗余，它只会因为缺失而红**。

## [1.0.0-alpha.6] — 2026-09-14
### Added
- **新增 `AGENTS.md`：把「踩过才知道」的那部分写下来。** `README.md` 是用户视角、`docs/tools.md` 是工具行为全集，都没有承载贡献者约定的地方，于是同一些坑被反复踩（「集成测试跑的是 `dist/` 不是 `src/`」这一条本轮就撞了两次）。里面记的是四件事：改完源码之后该跑什么、参数守卫的既有约定（只拒绝「没有」和「无法兑现」，绝不收紧能力；不要用 `Math.max(0, Number(x))` 兜底）、**哪些「类型说不可能」的守卫不能删**（`JSON.stringify` 会返回 `undefined`、可选捕获组与数组越界在运行时是 `undefined`、只在闭包里赋值的 `let` 会被 TS 收窄成字面量）、以及 `Host` 接口的边界 —— **保留它，但不再新增 host 形状的间接层**：一层间接如果只有一个实现、且没有第二个实现的现实计划，它就不是抽象，是绕路。

### Changed
- **死代码 / 过度设计 / 重复实现清理一轮（四路审计 + 逐条证伪）。** 每条都以「能否证伪它存在的理由」为准，而不是「看起来没人用」：
  - **`persist.ts` 的编辑器宿主残留**：`ensureWritableBufferTarget(_fullPath, _allowDirty)` 两个参数都不用、函数体是空的，**连一个调用点都没有**；`PersistOptions.allowDirty` 从不生效；`allow_dirty` 一路从 `write_file`/`edit_block`/`apply_patch` 三个工具的 schema 传下来最终被丢掉。注释说的「kept for interface parity with the editor host」在这个独立 Node 应用里**没有第二实现可兼容** —— `AGENTS.md` 批评的正是这种绕路。整簇删除，`persist.ts` 52 → 19 行。**顺带修掉一个假承诺**：`docs/tools.md` 曾写「`allow_dirty: true` 才会覆盖编辑器里未保存的改动（默认拒绝）」，而该 flag 完全被忽略、写入永远成功。
  - **`visible` 终端镜像整条链路删除。** `showVisibleTerminal` 是空函数（宿主里根本没有终端面板），它喂的捕获文件**被创建、然后被删除，从来没有任何读者**；`tailCommandForShell` 自始没有生产调用者，只被测试保活。schema 却在承诺「mirror live output into a user-visible terminal」，`docs/tools.md` 也在承诺「在用户可见终端里跑」—— 而 `README.md:301` 早就写明这件事在独立应用里**有意不做**。现在 schema 字段、`CommandState.visibleTerminal`、`visible_terminal` 输出字段、空模块与捕获路径、以及只被测试保活的两个函数全部移除，服务日志那半（`read_service_log` 真的会读）保持不变。
  - **`oauth-store` 手写的密码学原语合并到 `auth-core`，并修掉一处已发生的漂移。** `hashOAuthSecret` 与 `auth-core.hashSecret` 逐字相同；而 `oauthDigestEquals`（手写 XOR 循环）与 `auth-core.digestEquals`（`timingSafeEqual`）**对同一输入的答案已经不一致**：`digestEquals("","")` 是 `false`（有测试钉住），`oauthDigestEquals("","")` 是 `true`；`"zz…z"` 同理。两者都在 OAuth 安全路径上。现在共用 `hashSecret`/`digestEquals`。`generateOAuthSecret` **没有**合并 —— 它的前缀参数是真在用的（`obc_`/`oba_`/`obr_` 三种），而 `auth-core.generateSecret` 硬编码 `ob_`。
  - **原子写规则从两份并成一份。** `file-tools.writeAtomic` 与 `persist.persistText` 的唯一差别是 `fs.writeFile` 的 encoding 参数（对 Buffer 无效、对 string 默认即 utf8），合并为 `persist.writeFileAtomic(fullPath, Buffer|string)`。
  - **`toNative` 的本地副本（两处）合并到已存在的 `workspace/eol.applyEol`** —— 同一份 EOL 还原规则，`applyEol` 早就在 `patch.ts` 里干这件事。
  - **`stringEnv` 合并到 `processes.ts`**：`process-tools` 与 `service-tools` 各有一份逐字相同的 env 过滤。
  - **删除的死导出**：`bridge/review.ts` 的 `summarizeFiles` 再导出（无人从该模块导入该名字，测试直接从 `mcp/review-parse` 取）；`dispatcher.ts` 一条紧邻自己长版本、内容重复的一行 JSDoc。
  - **修掉六处「与代码不符」的注释**（这类是最高价值的，因为它会误导下一个改代码的人）：`network/safe-probe.ts` 的 `ProbeNetworkScope` 文档声称 `any`「never link-local, multicast…」，而同文件的 `case "any"` 明确写着「no address-class filtering at all」并 `return true` —— **安全相关的假文档**，会让后来者以为传 `any` 仍然拦得住云元数据地址；`process-tools.ts` 的 `validateTodos` 声称「读路径是宽松的、会丢弃坏条目」，而 `loadTodoStore` 只是把非数组换成 `[]`、条目一律原样通过（真正的宽松读取器早已不存在）；`shell-sessions.ts` 的 sentinel 注释声称用 `;` 拼接，代码用的是换行（照注释「改回」`;` 会让尾随注释或后台命令吞掉哨兵，正是注释声称支持的场景）；`tunnel.ts` 一段「重连隧道而不拆掉本地服务」的文档错挂在**取消**重连的 `stopReconnectChain` 上方（已移到 `scheduleReconnect`）；`lock-plan.ts` 把 `get_file_info` 描述成「读取文件内容」——它只读元数据，但**仍然必须持共享锁**（大文件 sha256 期间不能被并发写入插入），注释已改写并显式警告不要据此删锁；`oauth-store.ts` 模块头声称授权码也被散列，实际它是内存 Map 的**明文键**（紧邻的下一段自己就写明了）。
  - **净变化**：`src/` 减少 1 个文件（`visible-terminal.ts`），删除 3 个死导出与 2 个只被测试保活的函数，合并 6 组重复实现，改正 6 处假注释。`npm run verify` 全绿（405 单测 + 126 集成；较清理前少 2 个测试，均属被删函数的用例）。
  - **明确保留、不动**（审计逐条判定为「正确的防御」，删了会引入 bug）：`AGENTS.md` 保护的「类型说它不可能」守卫、`safe-probe` 的整个 SSRF 分类器与失败即拒绝策略、认证门的失败关闭与限流器、`patch.ts` 的回滚与 hunk 坐标逻辑、`file-tools` 的自毁/EXDEV/ENOENT 守卫、`SharedJsonStore.withFileLock` 的持有者令牌、路由与监听器的安全门、`regex-worker` 两个函数刻意分离的错误契约、`probeWithTimeout` vs `resolveWithDeadline`（解析 vs 拒绝的结算形状不同）、五处端口校验器（范围与文案各不相同），也没有为「去掉重复」去合并 `readBody` 的三个变体（64 KiB 抛错 / 8 MiB 继续排水 / 64 KiB 表单，契约不同）。
  - **一次自我否决**：`regex-worker` 的 `matchLinesInWorker` 与 `testReadyPattern` 有约 25 行逐字相同的 worker 生命周期骨架，我抽了共享 helper —— 结果文件从 185 行变 197 行（helper + 两个调用方各自的错误工厂），净增代码换一个带泛型参数与四个回调的骨架。已回退，不拿「消除重复」当选美。
  - 顺带记录一条方法论教训：**「值导出零死代码」这个结论不能靠把 `test/` 当成消费者得出** —— 第一版扫描因此漏掉了 `tailCommandForShell` 这类「只被测试引用、生产已死」的符号；第二版把测试单独列为一类后才看见它。
- **清理（上一轮）：两处死代码删掉，两对重复 helper 各自并成一份。** 按当时「过度设计 / 防御式编程」审计逐条核对后只动有证据的部分：
  - `DirtyBufferError`（`src/workspace/persist.ts`）**全仓库从未被 `new`/`throw` 过**，删掉；独立宿主没有「编辑器脏缓冲」这回事，`PersistOptions.allowDirty` 的说明同步改成「仅编辑器宿主、为兼容保留」。**本轮已把 `PersistOptions` 与 `allowDirty` 一并删除**（见上一条）。`describeCanonicalCall()`（`src/bridge/tool-call-shape.ts`）则是**只被本模块的 `normalizeToolCall` 用到**（别名提示里的 `call` 字段），所以只去掉 `export`、实现留着 —— 审计里「单次使用的导出」说的正是它。
  - `json()`（`src/http/oauth.ts` ↔ `src/server/api-router.ts`）两份实现并成 `src/http/json-response.ts` 的 `sendJson()`。这两份**已经漂移**（api-router 那份多 `charset=utf-8`、多 `headersSent` 守卫；oauth 那份多两个跨域头），信封从此只有一份，OAuth 只在自己那层加 `referrer-policy` 与 `access-control-allow-origin`；`api-router.ts` 31 个、`oauth.ts` 6 个调用点行为不变。
  - `pick()`（`tool-call-shape.ts` ↔ `tool-families.ts`）只留 `tool-call-shape.ts` 一份，`tool-families.ts` 改为导入。
  - 审计里点的另一对 `readBody` / `readJsonBody` **没有合并**：两者除了名字几乎什么都不一样（MCP 那条 8 MiB、`aborted`/`close` 也要结算 promise、文案带 `MCP`；控制台 API 那条 64 KiB、超限直接抛错、没有断连监听）。硬合并要么加一个开关参数、要么偷偷改掉其中一边的契约，比留着重复更差。
- **控制台的实例启停按钮全部撤掉：实例归终端管。** 规则本来就一条，也是用户的原话 —— **终端开着 = 实例在跑，终端关掉 = 全停**（一键启动脚本就是这个语义）。控制台再放一套「启动 / 停止」不但多余，而且会误导：停止会关掉承载页面的那个监听器，页面随之失效，「再启动」根本点不到。前两个提交（`6f88dd4` 的「退出进程」、`053d099` 的「重启」）方向错了 —— 为了让一个**不该存在的按钮**能用，把生命周期从终端手里夺走：重启后实例变成后台进程，关窗口不再停止它，复杂度却成倍上升。现在：
  - 控制台去掉「启动 / 停止 / 重启 / 退出进程」四个按钮，卡片改为说明这条边界，只保留「轮换端点」（进程内换令牌，不碰进程）与「健康检查」（只读探测）；
  - 服务端撤掉 `restart` 动作、`setRestartHook` 与 `src/bridge/restart.ts`（及其两个测试文件）；
  - 「磁盘上的构建比本实例新」的提示改成终端能真正做到的动作：**关掉承载实例的窗口，再双击一次一键启动脚本**（或在该窗口 Ctrl+C 后重新 `open-bridge serve`）——这也正是「重新加载新构建」在本模型下的唯一正解；
  - `/api/bridge/start|stop|rotate`、`/api/shutdown` 这些接口**保留不动**（CLI、脚本、以及将来的桌面壳仍在用），只是不再从网页暴露；`test/api-surface.test.ts` 的守卫改成：任何路由若无人调用即失败，而「控制台不驱动生命周期路由」变成一条显式断言。
- **局部变量遮蔽模块级同名导入的 15 处已全部改名，`no-shadow` 现已强制。** 源码 7 处：`paths.ts` 的参数 `root` 遮蔽同文件导出的 `root()`、`service-tools.ts` 的局部 `host` 遮蔽导入的 `host()`、`host.ts` 的 `setHost(host)` 遮蔽同文件导出的 `host()`、`node-host.ts` 的局部 `nodeHost` 遮蔽导出的 `nodeHost()`、`auth.ts` 两处 `record` 遮蔽导入的 `record()`、`patch.ts` 的 `toNative(text)` 遮蔽同一作用域上一行解构出来的 `text`；测试里另有 8 处用局部 `before`/`after`/`token` 遮蔽 `node:test` 的同名导入与本文件自己的 `token()` OAuth 助手。**纯重命名，无行为变化**（`tsc` 本来就能挡住真正的误用，这 15 处没有一处是活的），但每一处都会先被读成 bug、再花一次重读去确认；而 `host`、`root`、`record`、`before`/`after` 恰恰是本仓库已在模块作用域使用的名字，混淆不是假设性的。规则一并写进 `eslint.config.mjs`（TS 用 `@typescript-eslint/no-shadow`，基础规则在 TS 上会误判 enum / namespace / 声明合并），免得回归。

- **做了一次类型感知 lint 审计（`no-floating-promises` / `await-thenable` / `no-misused-promises` / `no-unnecessary-condition` / `no-unnecessary-type-assertion` / `eqeqeq` / `radix` 等），122 条命中，逐条判定后只改了上面两条。** 判定结果本身值得留下来，因为它决定了哪些「看起来该修」的东西**不能动**：
  - `no-floating-promises` **零命中** —— 没有漏 `await` 的悬空 promise。
  - `no-unnecessary-condition` 74 条里，绝大多数是**类型在撒谎、守卫是真的**：`JSON.stringify` 声明返回 `string`，但 `JSON.stringify(undefined)`（以及 replacer 对函数返回 `undefined`）运行时返回 `undefined`，`script-sandbox.ts` 正是靠这个判断「返回值没有 JSON 形态」；正则的可选捕获组未参与匹配时 `hunk[1]` 运行时是 `undefined`（`patch.ts`）；`.sort(...)[0]` 在过滤结果为空时是 `undefined`（`session-table.ts` 两处靠它判断「无可淘汰会话」）；`rest[i+1]` 越界是 `undefined`（CLI 参数解析）；`process-tools.ts` 的 `timedOut` 见上。**删掉这些守卫会真的引入 bug。**
  - 根因是 `noUncheckedIndexedAccess` 没开。实测开启后 `tsc` 报 **85 处**（`patch.ts` 21、`safe-probe.ts` 20 占一半）。当时判断那是严格度迁移而不是修 bug、且要动仓库里最 delicate 的补丁应用器，所以只记录代价 —— **紧接着的一轮已经把它做完了**，见下面那条。
  - `eqeqeq` 2 处是 `== null` / `!= null` 惯用法（一次覆盖 `null` 与 `undefined`），是正确写法；若要开这条规则应配 `{ null: "ignore" }`。
  - `http-listener.ts:138` 的 `no-misused-promises`（async 函数交给 void 回调）是**有意为之且已加固**：整个 handler 体包在最外层 try/catch 里，源码注释说明得很清楚 —— 异步 handler 的 rejection 会变成 unhandled rejection，而 Node 的默认处置是杀进程，一行畸形请求就够了。
  - `require-await` 9 处、`no-unnecessary-type-assertion` 29 处、`return-await` 6 处：无行为影响，未动。
- **`noUncheckedIndexedAccess` 已在两份 tsconfig 里开启：索引访问不再被当成一定有值。** 上一条把这 74 条 `no-unnecessary-condition` 判成「类型在撒谎、守卫是真的」，并实测开启这个开关要付 85 处报错的代价、当时只记录未执行。这轮做完了（core 85 处 + ui 4 处，共 15 个文件），因为**留着不做才是风险**：`arr[i]`、`match[1]`、`map[k]` 运行时确实可能是 `undefined`，而类型说不是，于是每个读代码的人都得自己把边界重推一遍。判据只有一句 —— **如果它真的是 `undefined`，你希望炸掉，还是希望得到一个看起来合理的错答案？** 想要后者的地方就绝不能用 `??` 兜底。
  - **能消掉索引访问就消掉**：`batch-plan` 把 push 进去的值存成局部变量，而不是回读 `results[results.length - 1]`；`stream-search` 的 `emitReady` 改成先读队首再判断，顺带把 `pending.shift()!` 也去掉了；`cli.ts` 的实例解析把 `live[0]` 提成 `only`。
  - **兜底语义无害时用 `??`**：`split()[0] ?? ""`、ripgrep 的上下文行文本、脚本失败的代码预览行、glob 的首段。
  - **兜底会把错误悄悄算错时用 `!`，并在旁边注明它凭什么成立**：两处 Levenshtein 的 DP 表（`?? 0` 会把一次越界折成一个看起来合理的编辑距离）、补丁的 `chosen` 偏移量（`undefined` 会让 slice 算术变 NaN 并静默改坏文件）、`ipv6Bytes` 的八位组（`?? 0` 会**伪造出另一个 IP 地址**，而这个解析器喂的正是决定「哪些地址允许探测」的分类器）。
  - **循环头一处收窄，整个函数体受益**：`cli.ts` 的参数解析、`glob.ts` 的 `ch`、`stream-search` 的 `text`、`patch.ts` 的 `block` / `header`（后两者顺带把 `i + 1 < X.length ? X[i + 1].index! : …` 简化成 `next ? next.index! : …` —— `next` 为 `undefined` 恰好就是「这是最后一块」）。
  - **安全边界一律失败即拒绝**：`classifyIpv4` 读不出前两个八位组时返回 `"reserved"`，而不是往下走到 `"public"`；`classifyIpv6` 同样抛 `INVALID_HOST`。这两处若图省事写 `?? 0`，一个畸形地址就会判成公网并被放行探测 —— SSRF 闸门上的 fail-open。
  - 顺带修掉一个真实的类型盲点：`patch.ts` 里 EOL 保持那段原来只靠 `Number.isInteger(start)` 把关，但 **`Number.isInteger` 不是收窄守卫**，所以后面的 `start < 0`、`end > rawNext.length` 一直是拿 `number | undefined` 在比较。现在显式加了 `=== undefined` 分支，走同一条「已验证的回退」。
  - 收益不止于少撒谎：开关一开，上一条那批「恒假 / 类型无交集」里凡是数组越界与索引访问类的误报就**自动消失**了 —— 类型不再撒谎，守卫也就不再像死代码（`session-table` 的 `.sort(...)[0]`、`tool-call-shape` 的 `LEGACY_REWRITES[name]`、CLI 的 `rest[i + 1]`、`patch.ts` 的 `hunk[1]` 都属于这类，它们的守卫本来就是对的，只是编译器看不见）。
- **`npm run audit` 现在能用了，依赖漏洞不再是盲区。** 本机 registry 指向 `registry.npmmirror.com`（国内镜像），而它没实现 npm 的安全通告端点：`npm audit` 会 POST `/-/npm/v1/security/advisories/bulk`，镜像回 **404 `[NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet`**。既不是依赖有问题、也不是 npm 坏了，但结果就是这一项长期查不了。新脚本只给这一条命令换回官方源（`--registry=https://registry.npmjs.org`，经已配置的代理可达），安装依赖仍然走镜像。当前结果：`found 0 vulnerabilities`。

- **小合并三项（第四项经证伪后否决）。** `mcp-endpoint.ts` 的 2025-era `tools/call` 处理器约 40 行与 `runToolCall` 逐行重复（计数器、审计、changes 摘要、structuredContent 规则全同，仅错误形状按时代不同），而文件头注释早已声称“两时代共用一个 tool surface”——现在 legacy 也走 `runToolCall`，注释成真；错误分支保留 `{ isError: true }` 的时代形状，wire 行为不变。`settings-handler.ts` 的 `fallbackState()` 把 11 处手写字面量换成 `CONFIG_DEFAULTS` 引用（已逐项核对与默认值相等，零行为变化），数组拷贝而非别名（之前 `oauth.allowedRedirectHosts` 直接别名了共享数组）。`service-tools.ts` 的日志路径内联块与 `processes.ts` 的 `serviceLogPathFor` 逐行等价（De Morgan 恒等式两侧），现导出共用一份。否决：`readEditableText` ≡ `readPatchableText` 看似重复，但错误文案按工具名与文件 label 定制且面向用户，抽公共函数要加回调参数化文案，行数不减反增间接层——与上一轮否决的 `regex-worker` 伪合并同一类，保持刻意重复（`patch.ts` 注释已写明两者的关系）。

- **`search_files` 默认按正则解析 `query`（行为变化）。** 之前默认字面匹配，`query` 里写 `a|b` 会静默返回空 —— 与 ripgrep 后端默认相反，现在对齐：默认正则，`regex: false` 才字面匹配。非法正则也不再静默：ripgrep 失败（exit 2 且零匹配）直接抛错，错误里带 rg 原文，与内置扫描路径的响亮失败一致。另修正了描述里过时的"path must be a directory"（单个文件路径早就能用）。
- **删除编辑器专属工具与宿主 capabilities 概念。** `get_diagnostics` / `lsp` 的 handler 是纯 stub（直接 throw），唯一的宿主实现硬编码 `lsp: false`，`tools/list` 永远过滤掉 —— 按仓库自己的规则（只有一个实现且无现实第二计划的就是绕路），连同 `EDITOR_ONLY_TOOLS`、`HostCapabilities` 接口、stub、标注、文档一并删除。`host().globalState` 改名为 `host().state`（VS Code Memento 术语残留，内部接口）。
- **注释与文档里的 VS Code 扩展时代残留清扫。** 约 30 处注释把已不存在的"extension host / vscode 模块 / commands.ts 镜像"当现行运行时描述，全部改写为独立版词汇；历史事件引用保留但泛化主体。附带：`AGENTS.md` 里写反的换行声明改对（库里是 LF，Windows 工作区是 CRLF），新增 `.gitattributes` 锁定；eslint 允许 `_` 前缀的未使用参数；`read_process_output` 描述注明默认 128 KiB/次；`tools.md` 注明链式命令 exit_code 取最后一段。

### Fixed
- **`run_script` 的沙箱能被逃逸成任意命令执行。** 沙箱给 context 的东西里，`tools.*` 是**宿主 realm 的箭头函数**，所以它的 `.constructor` 就是 worker realm 的 `Function` —— 而 `codeGeneration: { strings: false }` 只管得住 vm context 内部，管不住从外面递进去的函数。现场探针：`typeof process` 在沙箱里确实是 `"undefined"`，但 `tools.read_files.constructor("return process")()` 拿回了真的 `process`（正确的 pid 与 `argv[0]`），再接 `process.getBuiltinModule("node:child_process").execSync` 就是任意命令。`RESERVED` 名单挡得住 `tools.constructor`，挡不住**返回值**的 `.constructor`。后果是审计日志、`resource_keys` 资源锁、`redactSensitiveText`、`allowedDirectories` 与工具调用预算**全部绕过** —— 沙箱存在的唯一意义就是不让脚本绕过这些。现在改为：context 只收到纯数据 harness，`tools.*` 与 `console.*` 的函数都在 context realm 内由 bootstrap 生成，harness 里的宿主函数在脚本编译前就被删除。原始 payload 现在被沙箱自己的策略顶回：`Code generation from strings disallowed for this context`。工具调用、枚举、`in`、以及未知名回落到 dispatcher 的 did-you-mean 建议全部保持。顺带记一个坑：bootstrap 必须用 `vm.compileFunction(..., { parsingContext })`，用 `runInContext` 求值只能把 IIFE *创建* 出来而不会调用它。
- **OAuth 的公开元数据把路由令牌送给任何人，而它同时是授权口令。** `oauthResource()` 把 `state.routeToken` 拼进 `resource`，而 `/.well-known/oauth-protected-resource` 按 RFC 9728 是**无鉴权公开**的（`:639` 的注释写明「by design」），`ownerCredential()` 的默认值又正好是同一个令牌。于是远端攻击者一条链走到底：读元数据拿令牌 → `/oauth/register`（localhost 回调总是放行）→ 拿令牌当口令过 `/oauth/authorize` → 换 access token → `run_command`。讽刺的是 `state.ts` 到处擦这个令牌，`test/oauth-integration.test.mjs` 还断言它「never leaves the server」。现在 `resource` 不再内嵌令牌（它本来也不是资源标识，而是端点路径段）；**只停止发布、不停止接受**带令牌的旧值，所以早先注册、回传旧 `resource` 的客户端不会失配 —— 把披露 bug 修成一次故障是没有道理的。回归测试断言 discovery 文档里不含令牌。
- **取消待执行的重启会静默丢掉进程持有的 `resource_keys` 锁。** 关闭处理器**刻意保留**已排定重启的 `releaseResourceLocks`（资源仍被即将回来的进程占着），而 `dispatcher.handOffToProcess` 早就把该锁的持有超时兜底**解除**了。于是三条取消重启的路径 —— `terminateProcess`（清掉 `restartTimer` 后 `if (done) return true`）、`set_process_policy{auto_restart:false}`、`cancelPendingRestarts` —— 全都只是清了定时器，没有释放句柄，而那个句柄从此再没有任何人会调用。后果：后面每一个声明同一个 `resource_keys` 的调用都要等满 `concurrency.waitTimeoutMs`（默认 120 s）然后失败，控制台还一直把一个**已经死掉的命令**显示成持有者。`process_control{restart}` 更糟：它 `state.commands.set(s.id, replacement)` 换掉了唯一持有释放闭包的旧对象，连 `pruneCommands` 那条 1 小时兜底都救不回来，**泄漏到 bridge 进程结束**。现在所有取消路径统一走一个 `cancelPendingRestart()`，取消与释放同时发生。
- **`resource-locks` 的超时等待者出队时不 `pump()`，丢掉一次唤醒。** 写者优先会让一个读者排在一个更早的冲突写者后面（哪怕读者自己要的 key 是空的）。写者等待超时后被 `splice` 出队，但没有任何人 `pump`，于是那个读者继续排在一个**根本没人持有**的 key 后面，最后被自己的截止时间拒绝，报的还是「另一个工具调用仍持有它」。每条释放路径都会 `pump`，这条也必须。一行修复，外加一条钉住「被移出的写者会唤醒它后面的读者」的测试。
- **`apply_patch` 部分失败时不回滚它已经删除的文件 —— 静默、永久的数据丢失。** 回滚只遍历 `written`，而 `written` 只在非 delete 分支被 push，删除走的是 `fs.unlink`。于是「先 Delete 一个文件、后 Update 一个被占用的文件」这种补丁：前者已经删掉，后者抛错，回滚只处理了后者 —— 被删的文件永不恢复，即便 `originalContent` 里明明存着它的字节，而报错文案还写着「the files it had already written were restored」。同一处记账还有第二个错：「这个文件原本存在吗」用的是**最后一次**操作的类型，而块语法允许 `*** Add File: x` 后接 `*** Update File: x`，于是回滚会往一个由补丁自己创建的文件里写空串，留下一个空文件当作「恢复后的状态」。现在按文件的**第一次**操作判定，并把删除也记进回滚列表（`writeText` 是原子的，恢复同样是）。
- **`patchFilePath` 连剥两层 `a/` 与 `b/` 前缀，会改错或删错文件。** 连锁两次 `replace` 会把 `b/notes.txt` 变成 `notes.txt`、把 `a/b/notes.txt` 变成 `notes.txt`：一个仓库只要有顶层 `a/` 或 `b/` 目录（夹具里极常见）就中招，而 `*** Delete File:` 的后果是不可逆的。现在按语法区分：经典 diff（`--- a/…` / `+++ b/…`）剥**恰好一层**，因为这里的 `a/`、`b/` 是 diff 的侧标记；ShunCode 块头（`*** Update File: <path>`）是**字面路径**，不剥 —— 块语法自己从不添加这个前缀，所以原先剥一层本身就是 bug。代价是块头不再支持「按 diff 风格写 `b/<path>`」这种语法，而那不是块语法会产生的形式。
- **`read_files` 读单行大文件时全量缓冲。** 字节预算与 `utf8SafePrefix` 只在 `handleLine` 内部运行，也就是**只有在一整行被收齐之后**才跑；于是没有任何换行的文件被完整读进内存之后才截断。实测：64 MiB、单行、无换行的文件，`max_bytes: 1024` 回答正确，但 RSS 涨了 137 MiB、耗时 14.5 s；而默认预算是 512 KiB，意味着一个 500 MiB 的压缩包或一条巨型 JSONL 记录会按 `paths` 里每个路径各花 500 MiB，与模块自己承诺的「O(requested range)」直接矛盾。现在给待处理缓冲加上限，超限时只保留可返回的前缀（UTF-8 安全）并停止；范围在超长行**之后**时，整行按行号跳过、其余字节永不解码。修复后同一用例：**−23.5 MiB、3 ms**。
- **`SharedJsonStore` 的锁可以被非持有者删掉，并发写入静默丢更新。** 锁文件原本不记录任何东西（存在即锁），持有者 `finally` 里无条件 `rm`。于是：持有者 A 卡住超过 5 s（休眠唤醒、杀毒扫描、调试断点）→ B 判定其已死、删掉 A 的锁并取得新锁 → A 恢复后 `finally` 删掉了**B 的**锁 → C 与 B 同时持锁，各自读-改-写同一份 JSON，后 rename 的那个把对方的 key 悄悄抹掉，正是这个类存在的理由（「第二个实例吃掉了第一个的路由令牌」）。现在锁文件里写入持有者令牌，只删自己仍持有的那一把。
- **OAuth 同意限流按 socket 地址计数，运维会被匿名攻击者永久锁在授权之外。** ngrok agent 跑在本机，所以每个请求的来源都是 `127.0.0.1`：任何人向公开的 `/oauth/authorize` 连发几次错口令，运维**自己正确的口令**也会得到 429，而且每个窗口都能重新触发。`auth.ts` 的 bearer 门早就绕开了这个坑并把原因写在注释里（「a socket-keyed limiter would let one remote attacker lock the operator out」），OAuth 这份没跟上。两端现在共用 `remoteKeyOf()`。
- **`unifiedDiff` 的幽灵上下文行与错误的 hunk 计数。** `split("\n")` 会给以换行结尾的文本追加一个空元素，而它不是文件的一行 —— 只是「没有这一行」。把它当真实行处理，就会给**每个以换行结尾的文件**（也就是常态）产出一行内容为空的幽灵上下文行 `" "`，并让头部计数与正文不符。现在它在两侧同时存在时被丢弃；只改变「只有一侧有它」时的计数。
- **`boundedText(text, 0)` 返回全文。** `text.slice(-0)` 就是 `text.slice(0)`，于是 head+tail 截断的「尾部」是整个字符串：`review_changes{max_patch_bytes:0}`（文档写明「不含补丁文本」）会把完整 diff 送回来，而 git 输出最多缓冲 50 MiB —— 这个字段唯一的尺寸上限在 0 处正好失效。预算不足以容纳标记时现在返回空串。
- **`line-diff.ts` 此前零测试覆盖**，这轮补上 `test/line-diff.test.ts`（7 例）。
- 其余新增测试：`test/patch-rollback.test.ts`（6 例：中途失败后删除被恢复、写入被还原、Add-then-Update 不留下空文件、块头路径字面、经典 diff 只剥一层、块 Delete 删的是它写出的那个文件）、`test/process-lock-release.test.ts`（4 例）、`test/host-lock-ownership.test.ts`（3 例）、`test/probe-scope.test.ts`（4 例），以及 `test/script-sandbox.test.ts`（+2）、`test/resource-locks.test.ts`（+1）、`test/stream-read.test.ts`（+2）、`test/oauth-integration.test.mjs`（+1）。
- 编辑 `script-sandbox.ts` 时踩到并记下：`SCRIPT_WORKER_SOURCE` 与 `BOOTSTRAP_SOURCE` 都是 `String.raw` 模板，**模板内部（包括注释里）出现一个反引号就会提前闭合它**，报出来的却是一串毫不相干的语法错误；而 `String.raw` 里 `\`` 的反斜杠会被原样保留，所以内部模板也不能靠转义反引号来写。
- **`interact_with_process` 少了 `input` 不再往进程 stdin 里写 `undefined`。** schema 里 `input` 一直是必填，但处理器用 `String(args.input)` 兜底：调用方漏掉这个字段时，**工具返回成功**，而子进程 stdin 上真的收到了字面量 `undefined\n`（上一轮审计的现场探针：故意启动一个回显 stdin 的子进程，它打印出 `GOT:undefined`）。现在缺字段直接报错并点名 `input`，`read_process_output` 拿去只读；**空字符串照旧是合法输入**（就是一个裸换行），只拒绝「没有」，不收紧能力。端到端测试见 `test/required-args-integration.test.mjs`：漏字段被拒且进程侧什么也没收到、空字符串仍能送达。
- **同一形状还有三处：漏传必填参数不再被静默兜底，而是一律点名。** 上一轮只跑到 `interact_with_process` 就中断了，这次把 `String(args.x)` / `?? ""` 的 69 处全过了一遍 —— `run_command`、`set_todos`、`apply_patch`、`read_files`、`save_service`、`find_files`、`search_files`、`send_to_shell`、`normalizeScriptSource`、`normalizePort`、`parseHttpProbeUrl`、`activity_log` 都已有守卫，未动；剩下三处真的会静默：
  - **`command_id`（`process-tools.ts`，7 处查找）** 走的是 `state.commands.get(String(args.command_id))`：漏传时报 `Unknown command id: "undefined"`，把「参数没给」误诊成「id 过期」，客户端会去翻一个它从来没有过的 id。收敛成一个 `commandStateOrThrow()`：缺失点名 `Missing "command_id"`；**存在但未知仍然报 `Unknown command id` 并列出活跃 id** —— 那条 hint 正是客户端找回 id 的手段，不能连同误诊一起改掉。`get_process_snapshot` 的 `command_id` 是**可选**的（省略＝列全部），原语义保留。顺带把 7 份逐字重复的两行查找并成一份。
  - **`report_progress` 的 `message`** 用 `?? ""` 兜底：漏传时写一条空审计记录、推一条空 logging 通知，然后**返回成功**，调用方完全不知道这次汇报没发生。只拒绝「没有」；显式空串照旧放行（`phase` / `category` / `percent` 本身就能承载一次汇报）。
  - **`connectivity` 的 `url` / `port`** 分别以字面量 `"undefined"` 和 `NaN` 进入探测，回来的是不点名参数的 `INVALID_URL` / `INVALID_PORT`。现在缺失先点名；**给了但非法仍走 `parseHttpProbeUrl` / `normalizePort` 自己的文案**，没有把它们的诊断吃掉。
  - 测试：`test/interact-input-integration.test.mjs` 扩写并改名为 `test/required-args-integration.test.mjs`（复用同一个实例、不增加启动开销），7 例覆盖上面四处，外加三条**能力保全**断言：空 `input` 仍是裸换行、空 `message` 仍能汇报、`get_process_snapshot` 仍可省略 `command_id`。
  - 踩到的一件事，记下来免得下次再踩：**集成测试跑的是 `bin/open-bridge.js` → `dist/`，不是 `src/`。** 源码改完不 `npm run build`，端到端测试会继续报旧行为（本轮就是这样：三处守卫已在 `src` 里、typecheck 与 lint 全绿，测试却仍然失败）。
- **`set_process_policy` 会把 NaN 写到活进程上：自动重启被静默禁用，或退化成崩溃循环。** `Math.max(0, Number("abc"))` 是 NaN 而不是 0 —— 它并不钳位。NaN 落到 `CommandState` 之后，`restartCount < NaN` 恒为 false（自动重启悄悄失效），`setTimeout(NaN)` 约 0 ms 触发（一次崩溃变成崩溃循环）。**这正是 `save_service` 里那条注释记载过的同一次事故**：当时修了 `save_service`，写同两个字段的兄弟函数漏了，于是两个入口对同一条规则给出不同答案。现在两边共用 `processes.ts` 里的 `requireRestartKnob()`（该模块已被两者导入，不新增依赖边），规则不可能再漂移。负数从「钳到 0」改成报错，同样是为了两个入口一致 ——「重启 -5 次」是调用方的 bug，值得点名而不是悄悄改掉。
- **`list_directory` 的 `depth` 传垃圾值时静默退化成一层。** `Math.max(Number("abc"), 1)` 是 NaN，而 `level < NaN` 恒为 false，于是所有目录都不展开：**返回一份 depth-1 的列表，且完全不报错**，调用方以为项目就这么浅。只有非有限值被拒；`0` 与负数照旧钳到 1、超大值照旧递归、数字字符串照旧强转，**原本能用的调用一个都不变**。
- **`save_service` 此前零测试覆盖**，这轮补上：三个垃圾旋钮被拒且**什么都没持久化**、合法值存进去的正是校验过的那个数（而不是重新强转一遍的结果）。`requireRestartKnob` 另有 5 例纯函数单测（`test/restart-knobs.test.ts`），与既有的 `test/clamp-ms.test.ts` 同类同款 —— 那份文件的注释写的就是这一类事故（`Math.max(Number(x), 0)` 放过 NaN、`setTimeout(cb, NaN)` 约 0 ms 触发）。`test/required-args-integration.test.mjs` 从 7 例扩到 10 例。
- **新加的集成测试会被 `npm test` 静默跳过。** `test:core` 把 15 个 `.mjs` 逐个列了出来，而那份清单恰好等于 `test/*.test.mjs` 的全集 —— 纯冗余枚举，代价是**任何新集成测试都不会被跑，而且不会有任何提示**。本轮就撞上了：新写的 4 例超时测试单跑全绿，`npm run verify` 里却根本不存在，集成计数纹丝不动停在 121。改成 glob（Node v24 的 `--test` 原生支持），计数变为 125。
- **`run_command` 的超时分支此前零测试覆盖，而类型系统说它是死代码。** `let timedOut = false` 只在 `setTimeout` 回调里被赋值，而 TS 的控制流分析不追踪嵌套函数中的赋值，于是把 `timedOut` 收窄成字面量 `false`，整条 `if (timedOut && !commandState.done)` 被 `no-unnecessary-condition` 报成「值恒为假」—— 任何信任类型的人或工具都会认为它可以删。它不能删：**这正是 agent 在前台启动 dev server 时拿到的那个答案**（`status:"running"` + `command_id`，进程不被杀）。现在让超时结果**从 promise 流出来**，而不是靠被闭包捕获的可变标志：语义完全不变，类型不再撒谎。新增 `test/process-timeout-integration.test.mjs`（4 例）钉住整条契约 —— 调用在命令结束前返回、进程确实活着并自己跑完后一行输出、`force_terminate` 是真正的出路（`shell_alive:false` + `termination_reason:"terminated"`）、垃圾 `timeout_ms`（`"abc"`、`-5`）回落默认值而不是 0 ms 触发（源码注释记载过这次事故，此前无任何测试钉住）。
- **`open-bridge doctor` 的 ngrok 域名一行，在类型上恒为「未配置」。** `config.get("ngrokDomain", "")` 的 `T` 从字面量 fallback 推断成 `""`，于是 `domain || "未配置…"` 的左支被判定永不可达。运行时是对的（`get` 返回真实配置值），但这是同一类陷阱：读起来像一条永远走不到的分支。补上显式 `<string>`，与仓库里另外三处 `ngrokDomain` 读取点一致 —— 那三处早就写了 `<string>`，只有 CLI 这处漏了。
- **`required-args` 集成测试的偶发失败：固定 `delay(900)` 被当作「子进程已就绪」的代理。** `node --test` 并行跑各集成文件、每个文件各启一个实例，负载高时 node 冷启动超过 900 ms，stdin 监听器还没挂上，第一个用例就输了这场竞速（本轮全量跑时复现过一次，单跑 10/10 通过）。改用产品自己的 `ready_pattern`：`echo-stdin.mjs` 先注册 stdin 监听器、再打印 `READY`，于是「等到 READY」就等于「等到测试真正依赖的那件事」，且不再多等。
- **CHANGELOG 的 `[Unreleased]` 分区错位已修。** 上一条改动把 `### Fixed` 插在了 `### Changed` 的正下方，于是 `### Changed` 变成空标题，而原本属于 Changed 的两条（死代码清理、控制台按钮撤除）被归到了 Fixed 下面。按 Keep a Changelog 的 Added → Changed → Fixed 复位。
- **MCP 与控制台的配置校验漂移：同一设置两套规则，控制台还会静默存错值。** `set_config_value`（MCP）与控制台通用 `setConfig` 各写了一份校验，五个地方给出不同答案：`unrestrictedFileAccess: "yes"` 在 MCP 侧报错、在控制台侧**存成 `false`**；`allowedDirectories` 在 MCP 侧要求绝对路径、在控制台侧接受相对路径；`logMaxBytes` 控制台可设、MCP 不在白名单；`shellArgs` 的数量/长度/去空只在控制台生效；`oauth.allowedRedirectHosts` 只在 MCP 侧小写化。README 还写着两边「共用一套校验」——这句是假的。现在两边委托给同一个零依赖模块 `src/bridge/config-values.ts`（控制台打包不受影响），README 那句成真。以 MCP 为规范：布尔值严格类型、目录必须绝对路径、host 小写化；控制台的无损卫生习惯（trim、去空 shell 参数、枚举归一）保留并扩展到 MCP；控制台原来**静默截断**（超 50 项/超长直接 slice 掉）的部分改成明确拒绝 —— 悄悄改写 spawn 参数或访问白名单比报错更危险。`ngrokDomain` 两边本来就共用 `validateNgrokDomain`（MCP 内联调用、控制台走专用 `saveDomain`），保持不动；鉴权开关、并发、TTL 的专用流程同样不动（它们问的是令牌可用性、TTL 白名单这类「值是否合式」之外的问题，行为已有测试钉住）。测试：新增 `test/config-values.test.ts`（11 例，覆盖共享校验器的全部 19 个键与每个漂移点），`test/settings-model.test.ts` 补漂移回归断言，`test/api-integration.test.mjs` 加端到端用例（垃圾布尔与相对目录被拒且存量不动、合法写入仍成功）。
- **高危子集三项。** `interact_with_process` 的 `wait_ms` 未封顶：它是“等输出”场景里唯一的盲睡等待（`setTimeout` 到点才醒，没有输出或退出能提前唤醒），`clampMs` 又不设上限，于是超大值能把调用方挂起数天，而语义相同的 `read_process_output` 封 60 s。现在 `clampMs` 加可选 `max` 参数，interact 传 60000；其余调用点行为不变（就绪/超时等待都有事件 bound，restart 的 `delay_ms` 虽然也是盲睡、但长延迟可能是维护窗口的真实意图，不动）。schema 与 `docs/tools.md` 补上上限说明。第二，`services.ts` 读存档的重启旋钮走裸 `Number()`：它是第三个写这两字段的入口（前两个已共用 `requireRestartKnob`），存档里的垃圾值（手动改坏、旧版本漂移）会变成 NaN 进运行时，自动重启静默失效或崩溃循环。现在经 `requireRestartKnob` 校验，坏值回落默认值而不是抛错 —— `loadServices` 的契约就是单个坏条目不能掀掉整个加载（抛错会跳过后面所有服务，比静默默认值更糟；数字字符串与两个 live 入口一致，照旧接受）。第三，`rotateToken("")` 会轮换第一个令牌：三个按前缀匹配的兄弟函数里只有它缺空 needle 守卫（空串是任何 id 的前缀，`find` 直接命中第一条）。补上与 `deleteToken` 同文案的拒绝。测试：`test/clamp-ms.test.ts` 加上限用例；新增 `test/services-load.test.ts`（内存 host：垃圾旋钮回落默认、合法值/数字字符串照旧、坏条目不影响其余加载）；新增 `test/token-id-guards.test.ts`（三个函数的空 id 拒绝，守卫在 store 访问之前，不需要 host）。

- **配置/状态存储不再把可变引用别名出去。** `FileConfig.get` / `FileStateStore.get` 直接返回了内存里的 live 对象（存量值）或调用方传进来的 fallback（常常就是 `CONFIG_DEFAULTS` 的数组），任何一处 `push` 都会悄悄改写 store 或进程全局默认值。现在读写两端都做深拷贝；`CONFIG_DEFAULTS` 本体深冻结，误写会响亮地抛 `TypeError` 而不是静默污染。

## [1.0.0-alpha.5] — 2026-09-13
### Added
- **控制台按三个真实项目重做了一遍，路径也是真的。** 之前是单页 + 状态切换的页签。现在外壳来自三份星标参考的合并：
  shadcn-admin 的侧栏 / 面包屑 / KPI 排布、tabler 的表格行与活动列表、kiranism 的单色可折叠侧栏与列筛选；
  **9 条真实路由** `/console/<id>`（带 URL、可刷新、可直达），细节层（列筛选、状态徽章、分块条形图、设置二级导航）
  落在各页里。工具页去掉了「≈tokens」这类估算列（省 Token 不是目标），保留 4 条「描述必须与行为一致」的测试。
  `9b81532` + `e00a6c0`。
- **重建了 `dist/` 却没重启，现在实例自己会说。** 重新编译对**已经在跑**的进程毫无影响：Node 早就把旧模块加载进内存了，新工具、新修复都要**重启**才生效。这件事此前在**任何地方都看不见**——实例照旧公布上一次的工具清单，唯一的发现方式是数一遍工具再和源码对照（本次开发就真的被绊过一次：运行中的实例公布 55 个工具，仓库里已经是 56 个，没有任何提示解释差在哪）。现在实例在**启动那一刻**记下自己加载的构建时间（`dist` 下所有 `.js` 里最新的 mtime），之后对比磁盘：`get_bridge_status` 多一个 `build_stale`，状态页在「运行控制」里显示橙色提醒（磁盘上的构建比本实例新…停止再启动），体检页多一行「构建」，`open-bridge health` 多一行 `[!!] build:`。只在**编译版**实例上有信号：`npm run dev`（tsx 跑源码）没有构建产物可比，返回 `undefined` 而不是假装「最新」——「没有信号」和「是最新的」是两句不同的话。磁盘侧按 5 秒 TTL 记忆，状态端点被控制台每 2 秒轮询也不会每次去走目录。`src/bridge/build-staleness.ts`，单测 `test/build-staleness.test.ts`。
- **`run_script`：把多个工具调用写成一个脚本（Code Mode）。** 借鉴自 Chat-Plus 的 Code Mode：与其一次往返调一个工具，
  不如让调用方写一小段 JavaScript，用 `await tools.<工具名>(args)` 组合调用（循环、条件、`Promise.all`、过滤），
  **只 `return` 它真正需要的结果**。两件事同时变好：往返次数塌缩；更重要的是——**大块工具输出根本不必进入模型的上下文**，
  脚本可以在返回前就把它压掉。要点：每个 `tools.x()` 都是**真实的 Bridge 调用**（资源锁、审计日志、脱敏、会话状态、
  错误语义全部继承，见 `src/bridge/script-sandbox.ts` 的说明）；脚本只能调用本实例**已公布**的工具（`toolProfile` 与
  宿主能力过滤照样生效），`run_script`/`batch` 自身不可从脚本内调用；**沙箱本身什么都没有**——没有文件系统、网络、进程、
  `require`、定时器与 `eval`（`vm` 上下文 + 关闭字符串代码生成），工具名在父进程解析，所以写错的工具名会得到和直接调用
  一样的「did you mean」提示；每次运行都是**全新作用域**，数据只能通过 `return` 传递。失败时返回固定字段的
  `phase`/`error_type`/`line`/`code_preview`/`hint` 信封，让人（或模型）**改代码重跑，而不是道歉**。
  参数：`source`（必填）、`timeout_ms`（默认 30s，上限 300s）、`max_calls`（默认 60，上限 200）；返回体超过 64 KB 会截断并置 `truncated`。
  子调用沿用 `batch` 的口径（`countUsage: false`），保证 `calls == successes + failures` 依旧成立，同时以 `by_tool` 明细
  保留可见性。单测 `test/script-sandbox.test.ts`。
### Changed
- **工具目录收敛：公布 56 → 38，旧名一个都没失效。** 六个 service 动词、四个文件动词、四个自省读、三个日志读、
  两个探针，各自变成「一个工具族 + 判别参数」（`service{action}`、`file_op{op}`、`process_control{action}`、
  `bridge_status{section}`、`activity_log{action}`、`connectivity{target}`、`service_status{detail}`、`wait`、
  `open_shell{list}`）。**能力零损失是结构而不是承诺**：每个族调用的还是原来那个 handler；旧名在**唯一入口**
  （`src/bridge/tool-call-shape.ts`）改写一次，于是 handler 表、锁规划、标注、用量统计只认规范名；24 个旧名全部可用，
  对象结果里多一个 `deprecated`（文本里也有），数组与标量原样返回、不破坏旧调用方的解析；`structuredContent`
  同样按规范名查定义。另一轮把 22 条描述压到 200 字符内，**58/58 个工具的 name/inputSchema/outputSchema 逐字节未变**
  （`staging/t40-aproof.py` 的机器比对），细节移进 `docs/tools.md`。`a020515` + `553307b`。
- **`src/bridge/lifecycle.ts` 拆成 9 个模块，一个文件一个职责。** 原文件 1677 行里同时住着：HTTP 监听与两代 MCP 协议分发、ngrok 进程与域名归属、会话表与回收、peer 注册表发布、路由令牌、健康报告、发给客户端的 instructions。现在：
  - `lifecycle.ts`（277 行）只做编排：start/stop 串行队列、隧道归属决策、路由令牌、`webAiPrompt`、健康报告；
  - `http-listener.ts`（420 行）loopback 监听器：host/令牌路由（含 peer 代理）、预检、鉴权闸门、请求追踪、两代协议分发、会话查找、自检与停机排空；
  - `tunnel.ts`（502 行）ngrok 子进程、重连策略、公开健康探测、共享域名观察（沿用 peer 隧道或接手空出的域名）；
  - `mcp-endpoint.ts`（309 行）instructions 文本、每会话 MCP server、2026-07-28 世代 handler；
  - `session-table.ts`（64 行）会话表、空闲回收、容量与定期清扫；
  - `peer-registry.ts`（114 行）peer 注册表读写与定期重发布；
  - `route-hooks.ts`（55 行）宿主钩子（额外路由 + 「监听已就绪」回调）；
  - `lifecycle-queue.ts`（17 行）转换串行队列；`http/request-body.ts`（59 行）带体积上限的请求体读取。

  **拆法是机械的，不是手抄**：先按「括号深度回到 0」把原文件切成顶层块（注释/字符串/模板插值感知，并断言原文件每一行恰好属于一个块），再由生成器把块分配到模块、**按块里真正出现的标识符重算 import**、给跨模块引用的声明补 `export`。所以 `tsc --noEmit` 与 `eslint` 就是验收条件：漏 import 编不过，多 import 被判 unused（这套流程当场抓出 4 个真实错误：一个从未被 import 的 `ToolCallOutcome`、三个只在注释/字符串/对象键里「出现过」的假引用）。

  **依赖单向、无环**：`lifecycle.ts` → `http-listener.ts` / `tunnel.ts` / `session-table.ts` / `peer-registry.ts` / `mcp-endpoint.ts`；`tunnel.ts` 不 import `lifecycle.ts`，唯一的反向需求（接手空出的共享域名＝重启整个实例）由 `setInstanceRestart()` 注入。独立依赖图检查：`src/` 下 84 个模块、224 条内部 import 边，**没有环**。

  **对外接口一个没动**：全仓库只有 3 个文件 import `lifecycle.ts`（`src/cli.ts`、`src/server/api-router.ts`、`src/server/settings-handler.ts`），签名与行为不变；`cli.ts` 的宿主钩子（`setExtraRouteHandler` / `setLocalServerReadyHook`）改从 `route-hooks.ts` 取，`enqueueLifecycle` 从 `lifecycle-queue.ts` 取。

  验证：`npm run verify` 全绿（355 单测 / 101 集成 / 38 UI，与拆分前完全一致）；声明审计确认原文件 67 个顶层声明**一个不少、没有一个重复**；真机演练 13/13 全绿（临时实例：MCP 握手 + 56 个工具 + 两代协议、`run_command`、`run_script` 调子工具、文件读写往返、`/console/` 与控制台路由、构建新鲜度信号由 false 变 true、停机排空）。
### Fixed
- **参数缺失不再变成「名叫 undefined 的文件」。** `String(args.path)` 把漏传的路径变成一个字面量文件名：
  `copy_file` 写出一个叫 `undefined` 的文件、`delete_file` 删掉它并回答 `deleted: true`；同一处缺陷还覆盖
  `write_file`（**覆盖**了真实存在的同名文件并返回 ok）、`edit_block`、`get_file_info`（都去读写它）、
  `read_files{paths:[null]}`（去 stat 一个叫 `null` 的文件）。现在全部走 `requiredArg`（`Missing "path".`）
  与逐项非空校验；集成测试里**真的放一个名为 `undefined` 的文件**进去，证明这些调用被拒绝且它逐字节未变。
  `cee3a9a` + `89625bf`。
- **文件工具多了自毁护栏。** `file_op{op:"delete", path:".", recursive:true}`（旧名 `delete_file` 同样）会把工作区里的
  文件递归删光，`path:".."` 连父目录内容与 Bridge 自己的数据目录（`secrets.json`、runtime 记录）一起删；
  `move` + `overwrite:true` 落到**已存在的目录**上会把整棵目录换成一个文件，还返回成功。现在目标是工作区根 /
  数据目录 / 盘根或它们的祖先时一律拒绝，文件不能落在目录路径上（错误信息给出正确写法）。
  **`unrestrictedFileAccess` 一个字没改**：工作区外的普通路径照旧可读写可删（有专门用例钉住这个能力），
  真要清空项目仍然可以用 `run_command`。
- **`deprecated` 不再混进 `structuredContent`；字符串布尔按声明归一。** 旧名调用的结构化内容此前带着 schema 里
  没有的 `deprecated`（现在只留在文本块）；`list:"false"` 这类字符串布尔过去按真值走（该开 shell 却去列 shell），
  现在在同一个归一化入口按**目录里声明的布尔入参**处理（清单从 `inputSchema` 读出，不留第二份手写表），
  `"nope"`、`2` 之类仍原样透传给 handler 拒绝。
- **死代码与「导出噪音」按证据清了一遍，另有一处注释与代码互相矛盾。** 两个脚本（`ob-repo-sweep.py` 粗筛 → `ob-repo-sweep2.py` 精判：**定义处就是该符号唯一的出现**才算死）扫过 `src`、`ui/src`、`scripts`、`test`、`bin` 共 19,412 行，结论是只有 **1 个真正没人用的导出**：`src/http/auth.ts` 的 `invalidateAuthCache`——它的注释写着「给测试用」，但全仓库没有任何测试引用它；而且它要失效的那个缓存是**按内容（字符串相等）**记忆的，永远不会过期，所以正确做法是删掉它，并把文件头那段与代码互相矛盾的说明改成实情（原文说「每次读都直连存储、解析很便宜」，代码其实做了内容级记忆化）。另有 **33 个内部符号挂着 `export`**（`TOOL_ANNOTATIONS`、`EDITOR_ONLY_TOOLS`、`MAX_AUDIT_LOG_BYTES`、`startInternal`/`stopInternal`、`cancelPendingRestarts`、`oauthDigestEquals`…）：全仓库（含测试与 CLI）只有自己模块在引用——多出来的 `export` 不是 API，而是一张没人认领的空头承诺，**它的实际危害是让「未被使用」这件事无法被工具发现**。去掉后模块边界与事实一致；类型与接口的导出保持不动（那是模块的对外契约，测试也在用）。顺手消掉一处复制粘贴：`lifecycle.ts` 里发给客户端的 `instructions` 长文本被 `createMcp` 与 `createSpecMcp`（两代协议）**逐字节抄了两份**，现在收敛为 `SERVER_INSTRUCTIONS_BASE` + `serverInstructions()` 一处来源，两代协议的话术不会再各自漂移。
- **窗口标题不再被子进程改乱。** Windows 每个控制台只有**一个**标题字符串，任何挂在该控制台上的进程都能改写它
  （`SetConsoleTitle`），而且**没有恢复机制**。因为我们的子进程是**有意共享控制台**的（关窗要连带停掉隧道与服务，
  见 `child-console.ts`），我们跑的命令也会往标题里写字：**自己拥有控制台**的 `cmd.exe`（双击 .cmd/.bat、`cmd /k` 新窗口）会把镜像路径写成窗口名：
  `C:\Windows\system32\cmd.exe`；**只共享**我们控制台的 `cmd /c …` 实测不动标题。npm 则通过 `process.title` 写「npm …」（`npm/lib/cli/entry.js:4`、`npm/lib/npm.js:153`）。
  子进程退出后窗口就保持它写的样子，操作者看到的就是「窗口名自己乱变」。现在：启动时**认领**标题
  （`Open Bridge - <工作区名> (:端口)`），并在**每个子进程退出后重新认领**（`run_command` 与常驻 shell 两条路径），
  停机时释放。纯外观改动，无控制台时（服务/CI/重定向输出）完全不动手；写入失败也绝不抛错影响服务。
- **公网隧道的接管变快了。** 借用别人隧道的实例（follower）原本每 10 秒固定探一次；持有者退出后，实测
  **约 2 分钟**才完成接管（`bridge.log`：08:46:48 `Public domain is free again; this window will claim it.`
  → 08:46:51 已恢复公网），这段时间对所有远端客户端就是纯宕机。现在探测节奏**跟着上一次结果走**：
  健康时 10 秒一次，一旦发现公网不再服务我们（端点没了/换成别人）就改成 4 秒一次，接管因此提前到
  两次「free」判定之内。判定规则本身抽成纯函数（`src/bridge/tunnel-watch.ts`）并加了单测：**连续两次**
  「ngrok 自己说这里没有端点」才允许抢占；`unknown`（超时/5xx）一律清零计数，绝不在猜测上开抢；
  `busy`（正在重连或已有隧道子进程）时永不抢占，且计数**清零**，保证「连续两次」这条规则字面成立
  —— 抢占永远不会跨着别人的一次重连拼凑出来。
- **`open-bridge serve --help` 不再把服务真的起起来。** 分派把 `--help` 交给 `cmdServe` 后没有任何人看这个标志，
  于是「只想看用法」的一条命令会**真的发布一个实例**：监听端口、写 runtime 记录、占据公网 URL、参与隧道借用。
  这不是理论问题——开发过程中一次脚本里的 `serve --help`（输出还被重定向到了 /dev/null）就起了一台实例，
  事后靠进程父链才查出是谁启动的。现在 `serve --help` / `serve -h` 只打印 serve 的参数说明并退出，
  **不碰锁、不绑端口、不写注册表**；`test/cli-surface-integration.test.mjs` 用「命令必须秒退 + 临时 home 里一个文件都不能有」钉住它。

## [1.0.0-alpha.4] — 2026-09-12
### Added
- **技能发现（skills），补上对照里唯一被点名的「真缺」**（`docs/refactor-comparison.md` D9）。连接时，
  服务端说明里现在除了项目约定（`AGENTS.md`/`CLAUDE.md`）还会带一份**技能索引**：工作区的
  `skills/<名字>/SKILL.md`、`.agents/skills/`、`.claude/skills/`，加上数据目录与 `~/.agents/skills/`。
  索引只含**名字、描述、路径**——正文留在磁盘上，模型判断任务匹配后用 `read_files` 读取，
  十个技能和一两个技能的上下文成本一样。做法取自 DevSpace/TaskQuay 的约定，但**没有引入它们的运行时依赖**，
  也不像它们那样往用户目录里同步「托管技能」：本实现**只读**。
- **新工具 `list_skills`**（只读，标注 `readOnlyHint`）：返回索引 + 扫过的目录 + 被遮蔽的同名技能数。
  它在每次调用时重新扫盘，因此**会话中途新增的技能无需重连**即可被发现；`workspace_brief` 也带上技能摘要。
- 有界：最多 50 个技能、名称 80 字符、描述 200 字符、只解析文件头部 64 KB；说明里最多列 20 行，其余
  指向 `list_skills`。发现过程**永不抛错**（目录缺失/不可读一律跳过），不会拖住会话建立。
- 测试：`test/skills.test.ts`（12 条：front matter、CRLF/引号、无 front matter 回退、未闭合围栏、
  三种目录拼写、同名遮蔽、隐藏目录、缺失文件、数量上限、越界标记、索引渲染与截断、查找顺序）；
  `test/skills-integration.test.mjs`（5 条端到端：说明里带索引、`list_skills` 在目录里且标注只读、
  内容不外泄、用既有 `read_files` 读取、**中途新增技能下一次调用即可见**）。

## [1.0.0-alpha.3] — 2026-09-12
### Added
- **一键启动脚本先问「工作目录」，再启动。** 「工作区」是 AI 权限的边界，而双击启动时它默认等于
  `.cmd` 所在的目录（也就是本仓库自己）——想给别的项目用只能迂回。现在双击后先提示输入目录
  （`"D:\work\my-project"` 与 `D:\work\my-project` 都收，引号自动去掉），
  回车＝沿用上一次输入的目录（记在同目录的 `start-open-bridge.last-dir`，已加进 `.gitignore`）；
  目录不存在会先问一句再建；也可以把目录当第一个参数传（桌面快捷方式/计划任务用得上）。
  启动命令相应变成 `serve --root "<你输入的目录>" --open`。
- **`open-bridge stop` 的「自停保护」。** 用 Bridge 的 MCP 去操作 Bridge 项目本身是安全的（改代码、
  构建、删 `dist/` 都不影响正在服务的进程，本轮已实测），唯一真会把自己弄断线的动作是 `stop`
  ——它停掉的正是承载这次会话的进程。现在 `serve` 启动时给自己的 pid 打一个 `OPEN_BRIDGE_HOST_PID`
  标记，凡它启动的子进程（`run_command`、常驻 shell、服务、隧道）都会继承；当 `stop` 要停的那个实例
  *就是* 这个标记指向的 pid 时，默认**拒绝执行**并说明原因与出路，`--force` 强制。人自己的终端
  没有标记、停别的实例也不会被拦，所以 MCP 的用法与速度完全不变。
### Fixed
- **关窗/挂断不再留下「活着但没人管」的实例。** `serve` 只处理 SIGINT/SIGTERM：控制台窗口关闭（Node 在 Windows 上报成 SIGHUP）与 Ctrl+Break（SIGBREAK）都没人接，于是窗口没了、进程还在，端口、runtime 文件与启动锁都还被它占着——下一次启动因此被拒（「该目录已有实例在运行」）。现在两个信号都走同一条优雅停机，并且停机在任何一步卡住时都有 **10 秒硬期限**（`src/bridge/shutdown-deadline.ts`，在第一次 await 之前就武装好），到点强制退出。
  实测（本轮探针）：控制台成员表证明长驻子进程与 serve 同属一个控制台——`sleep.exe`/`bash.exe` 出现在那个窗口的控制台进程列表里，修复前它们各自持有独立（隐形）控制台、关窗也不会退出。非交互会话里拿不到可关闭的真实控制台窗口，所以「点 X」这一步依赖 Windows 文档化的行为（关闭控制台窗口会终止其成员进程）＋ SIGHUP 处理作为双保险。新增 `test/shutdown-deadline.test.ts` 三条用例（到点触发、完成后取消、默认期限下限）。

## [1.0.0-alpha.2] — 2026-09-11
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

### Added
- **双击一次就能跑起来：`start-open-bridge.cmd`。** 仓库根目录的批处理，双击即可——首次运行时
  自动 `npm install` + `npm run build`，然后在**本窗口**里跑 `open-bridge serve --open`：
  服务端自己的日志和三个地址就在窗口里，浏览器自动打开控制台。**关掉窗口 = 停止服务**：
  隧道、后台服务、常驻 shell 都与这个控制台同属一个控制台，Windows 关窗即终止其成员。
  `Ctrl+C` 是干净停止（删掉启动锁与 runtime 文件）。节点缺失/步骤失败时会留住窗口显示原因。
- 控制台顶栏与「状态」页显示构建版本；`/api/status`、`/api/settings` 与 MCP 的 `status`、
  `workspace_brief` 都带上 `version`，与 `open-bridge --version` 是同一个字符串。
### Fixed
- **长驻子进程不再从终端里「逃逸」。** ngrok、后台服务、常驻 shell 此前一律以 `windowsHide: true`
  拉起，等于各自拿一个**独立（隐形）控制台**：关掉终端窗口后它们活着，隧道继续占着域名，
  下次启动只会得到 `ERR_NGROK_334` 并退回本地模式，屏幕上没有任何线索。实测（Win32
  `AttachConsole` + `GetConsoleProcessList`）证明 `windowsHide: false` 的子进程会挂在**我们**
  的控制台上、而隐藏的那个不会。现在只要我们自己有控制台（`stdout`/`stderr` 是 TTY）就共享它，
  只有在确实没有控制台时（输出被重定向、或 GUI 父进程如旧的 VS Code 扩展宿主）才隐藏。
- **版本号只剩一处来源。** `src/host/node-host.ts` 曾把 `"1.0.0-alpha.1"` 写成兜底字面量：
  任何没传 version 的构建（测试、嵌入方、手工重建的 dist）都会带一个过期版本号。现在从
  `package.json` 读，并由集成测试把 `/api/status`、`/api/settings` 与它钉在一起。
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

