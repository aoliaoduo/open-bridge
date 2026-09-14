# 工具详解（每个工具的完整说明）

`tools/list` 里每个工具的描述只留**一句做什么 + 现场必须知道的规则**（≤200 字符）。完整的行为、边界、字段约定，以及在相似工具之间怎么选，都在这里。

阅读方式：客户端把这份文件当普通工作区文件读（`read_files docs/tools.md`），或按标题跳到你关心的那个工具。

**本版对应工具族的合并**（v1.0 起）：服务、文件系统操作、进程控制、桥状态、审计日志、连通性六组近义工具，各自合并成一个带 action 参数的工具。**旧名字一个都没删**，仍然可用，会转发到新工具并在结果里标注 `deprecated`；对照表在文末。

---

## 结果字段约定（所有工具通用）

- 返回值是 JSON 对象，**每个工具的字段集是固定的**：缺失的事实表现为 `null` 或空字符串，**不会**靠"某个字段不在"来表达。所以永远**按字段名解析，不要按行数/行是否存在来解析**。
- 命令类工具（`run_command`、`start_process`、`send_to_shell`、`interact_with_process`）返回**合并输出 `output`**，同时给出**分离的 `stdout` / `stderr`**；分页读取还带 `offset` / `next_offset` / `truncated`。
- 命令**非零退出码不是调用失败**：调用可以返回 `status: "completed"` 且 `exit_code != 0`，必须自己看 `exit_code`。
- 声明了 `outputSchema` 的工具同时返回 `structuredContent`（类型化数据）；数组结果会包一层 `{ items: [...] }`。文本块始终保留。
- 出错时返回 `isError: true` 与一句话原因；错误信息通常给出下一步（例如"先 `read_files` 再重试"）。

---

## 工具族：一个名词，一个 action 参数

六组工具按"同一类对象上的动作"合并。判别参数写在定义里（`action` / `op` / `section` / `target` / `detail`），值域封闭：**给一个表里没有的值，会得到一条列出全部合法值的错误**，不会猜。

| 工具 | 判别参数 | 取值 | 原来是谁 |
| --- | --- | --- | --- |
| `service` | `action` | `start` · `stop` · `restart` · `delete` · `start_all` · `stop_all` | `start_service` · `stop_service` · `restart_service` · `delete_service` · `start_all_services` · `stop_all_services` |
| `service_status` | `detail` | `live`（默认） · `definitions` | `service_status` · `list_services` |
| `file_op` | `op` | `create_directory` · `copy` · `move` · `delete` | `create_directory` · `copy_file` · `move_file` · `delete_file` |
| `process_control` | `action` | `restart` · `terminate` | `restart_process` · `force_terminate` |
| `bridge_status` | `section` | `overview` · `auth` · `locks` · `sessions` | `get_bridge_status` · `get_auth_status` · `get_lock_status` · `list_sessions` |
| `activity_log` | `action` | `recent`（默认） · `search` · `clear` | `get_recent_activity` · `search_activity_log` · `clear_activity_log` |
| `connectivity` | `target` | `port` · `http` | `check_port` · `check_http` |
| `wait` | 看参数 | `ms`＝睡一会儿；`command_id`＝等该进程退出 | `wait` · `wait_process` |
| `open_shell` | `list` | `list: true` 返回已开的 shell，否则开一个 | `open_shell` · `list_shells` |

`connectivity` 的 `target` 可以省：带 `url` 按 HTTP 走，带 `port` 按 TCP 走。

---

## 在相似工具之间怎么选（路由表）

| 场景 | 用哪个 | 不用哪个 |
| --- | --- | --- |
| 一次性命令、看完就结束 | `run_command` | 不要用 `start_process`（它面向长驻进程） |
| 服务器 / 守护进程 / watcher | `start_process`（可 `ready_pattern` 等启动完成） | 不要用 `run_command`（会一直等） |
| 需要保持 cwd / venv / 导出变量的连续交互 | `open_shell` + `send_to_shell` | 不要用 `run_command` 反复 `cd` |
| 想反复重启的命名守护进程 | `save_service` 定义，然后 `service{action:"start"/"stop"/"restart"}` | — |
| 看服务现在的状态 | `service_status`（带健康检查）或 `service_status{detail:"definitions"}`（只列定义） | — |
| 单文件精确替换 | `edit_block` | 不要用 `apply_patch`（多文件才划算） |
| 多文件改动、新建/删除文件 | `apply_patch` | — |
| 建目录 / 复制 / 移动 / 删除 | `file_op{op:…}` | — |
| 就绪探测 | `connectivity`（`{url}` 或 `{port}`） | 不要用 `run_command curl`（慢且要自己解析） |
| 连续多次相关调用、或结果很大 | `run_script`（在脚本里循环、过滤、聚合，只把需要的返回） | 逐个调用会浪费往返与上下文 |
| 手机响一声 | `notify`（或清单勾选自动推） | 不要 `report_progress`（那只进客户端日志流，不碰手机） |
| 想批量并行调用 | `batch`（`mode: "parallel"`） | 嵌套 `batch` 会被拒绝 |

---

## 逐个工具

### 工作区读取

**list_directory** — 列目录。`depth` 1–3、`include_hidden`、`max_entries`；结果是 `[{name, type}]`。

**find_files** — 按 glob 找文件（`*`、`**`、`?`、`{a,b}`、`[abc]`）；纯名字/前缀仍按 basename 匹配，`src/**/*.ts` 这种按完整相对路径匹配。

**search_files** — 在工作区文件里搜文本：有 ripgrep 就用（快、尊重 `.gitignore`），否则内置扫描。`query` 默认按**正则**解析（`regex: false` 才按字面匹配；非法正则直接报错，不会静默给空）；`include` 限定文件（如 `["*.ts"]`）；`context`（0–20）在每处匹配前后带若干行；`offset` + `max_results` 翻页。`path` 可以是目录或单个文件。

- 正则语义是 **JavaScript** 的（内置扫描用的就是 `RegExp`）。ripgrep 的默认引擎不支持先行/后顾（`(?=`、`(?!`、`(?<=`、`(?<!`）与反向引用（`\1`），这类查询会由内置扫描回答 —— 结果一致，只是慢一些，不会因此少给或不报错。看到空结果时先确认不是正则写错或 `include` 太窄。

**read_files** — 读一个或多个文件；大文件用 `start_line` / `end_line`（1 基、含两端）读区间。`sha256` 要么是**整个文件**的摘要（可直接作 `expected_sha256` 做乐观写入），要么是 `null` —— 它**永远是一个存在的字段**，绝不会因为读法不同而消失。只有读到文件末尾时才有值：`max_bytes` 截断、或没读到最后一行的区间读，都拿不到整个文件的摘要，此时为 `null`（不会为了一个哈希去重读整个文件，那会让「2 GB 日志取 5 行」退化成全量扫描）。需要截断读之后的摘要，用 `get_file_info`。`encoding: "base64"` 读二进制。

**get_file_info** — 元数据。≤128 MiB 的文件带 `sha256`；更大的返回 `null`，而不是把整个文件读进内存。

**workspace_brief** — 一次拿到项目全貌：工作区路径、顶层结构、清单文件、`AGENTS.md` / `CLAUDE.md`、git 分支与脏文件数、近期活动。**刚接手不熟悉的项目先调用它一次。**

**list_skills** — 列出工作区可用技能（含 `SKILL.md` 的目录）。服务端 instructions 里是**连接时**的快照；中途新增技能后用这个刷新，再 `read_files` 对应 `SKILL.md` 照做。

**review_changes** — 自上次查看以来全部改动的累积 git diff（含编辑与 shell 侧效应）。需要 Git 仓库且至少一次提交；`mark_reviewed`（默认 true）展示后推进基线。一批编辑做完后调用，让用户看完整改动集。

**get_todos** — 读任务清单与 `last_progress`。

### 工作区写入

**write_file** — 新建或覆盖。`content` 或 `content_base64`；`mode: "append"` 追加；`expected_sha256` 防止覆盖已变化的文件。

**edit_block** — 单文件精确替换：`old_text` 必须**恰好匹配一次**（除非用 `expected_replacements` 指定次数）；也可一次给 1–20 个 hunk（`edits`），**全部命中才写**。零匹配时错误里附**最接近的一段文本**与可能的漂移原因。带 `expected_sha256` 防陈旧编辑。

**apply_patch** — 两种语法：经典 unified diff（只能改已存在文件）与 ShunCode 块（`*** Add File:` / `*** Update File:` / `*** Delete File:`，可新建与删除）。`patch` 与 `patch_file` 二选一；`expected_sha256` 按路径映射校验。

**file_op** — 见上文工具族：`create_directory`（`path`）· `copy` / `move`（`source`、`destination`、可选 `overwrite`）· `delete`（`path`、可选 `recursive`）。

- `path` / `source` / `destination` 缺失时**直接报错**（`Missing "path".`），不再被 `String(undefined)` 变成名为 `undefined` 的文件。
- **自毁护栏**：`delete` / `move` 的目标若命中**工作区根、Bridge 数据目录（`~/.open-bridge`）、盘根**，或它们的祖先目录，一律拒绝（`Refusing to delete "…"`）。`unrestrictedFileAccess` 不变 —— 工作区外的普通路径照旧可读写，真要清空请用 `run_command`。
- `move` + `overwrite=true` 时，**文件不能落在已存在的目录上**（那会把整个目录换成一个文件）；写成 `destination: "d/<文件名>"` 即可放进目录里。
- 字符串/数字形式的布尔值（`"false"`、`"0"`、`1`）按声明类型归一：`recursive:"false"` 就是 false，`list:"false"` 就是"开 shell"而不是"列 shell"。

同一份「必须有值」的契约覆盖所有带路径的工具：`write_file` / `edit_block` / `get_file_info` 的 `path`、`read_files` 的 `paths` 每一项，缺失或为空时一律 `Missing "path".` / `paths[0] must be a non-empty string.`。**不会有任何操作去写、改、删一个名叫 `undefined` 或 `null` 的文件**（这正是修之前的实际行为）。

**set_todos** — 存**完整**任务列表（条目需 `id` / `title` / 合法 `status`）。多步工作的正式清单。

**report_progress** — 报**瞬时**进度：写入活动日志并以 MCP `notifications/message` 推给客户端。`phase` 与 `category` 是**封闭词表**，表外取值会被丢掉；自由文本放进 `message`。

### 命令与进程

**run_command** — 前台等待最多 `timeout_ms`（默认 120000）。**超时不会杀掉进程**：它继续在监管下运行，返回 `status: "running"` 与 `command_id`，之后用 `read_process_output` / `wait` 继续读，或用 `process_control{action:"terminate"}` 停掉。`background: true` 立刻返回。退出码非零**不是**调用失败。链式命令（`a; b`）的 `exit_code` 取最后一段，要前一段的退出码就以 `echo EXIT=$?` 结尾。

**start_process** — 面向**长驻**进程（服务器、watcher、守护进程）：`ready_pattern` 等启动输出，返回 `command_id` 交给进程工具组。

**read_process_output** — 分页读受监管命令的输出：`offset` / `max_bytes`，`stream` 只读一路，`wait_ms`（最大 60000）阻塞等待**新**输出。默认 128 KiB/次，大输出传更大的 `max_bytes`，用 `next_offset` 翻页，`truncated` 告诉你还有没有。

**interact_with_process** — 给进程送输入并返回**这次输入之后**产生的输出（不传 `offset` 就不必自己记游标；`wait_ms` 上限 60000，与 `read_process_output` 一致）。面向普通非 PTY 管道；完整终端会话请用 `open_shell`。

**process_control** — `restart`（用原命令与原 cwd 重起，可带 `delay_ms`）· `terminate`（强制结束）。都按 `command_id`。

**wait** — `ms` 睡一会儿；`command_id`（+ 可选 `timeout_ms`）等该进程退出。两者都给时按进程算。

**set_process_policy** — 调整监督策略（超时、输出上限等行为）。

**get_process_snapshot** — 一次列出所有受监管进程（状态、命令、cwd、启动时间）。排查"现在到底有什么在跑"时先用它。

**open_shell** — 开一个**具名持久 shell**（需要 bash/sh，Windows 上是 Git Bash）。同一个 shell 跨调用存活，`cd`、导出变量、激活的 virtualenv **都保留**；`list: true` 则返回当前开着的 shell 列表（`name` / `command_id` / `cwd` / `alive` / `started_at`）。

**send_to_shell** — 在 `open_shell` 开的 shell 里跑命令，经哨兵字符串等它结束（上限 `timeout_ms`），返回输出与退出码；超时则 shell 保持开着。

**close_shell** — 关掉某个持久 shell。

### 连通性与服务

**connectivity** — `{url}` 探 HTTP(S)：状态码与延迟，最多跟 5 次重定向，URL 里的 userinfo 当 Basic 认证，目标地址**先解析再固定**。`{port}` 或 `{host, port}` 探 TCP 是否可连。用它们做就绪判断，别用 `curl`。

**save_service** — 定义/更新一个命名服务（命令、cwd、group、port、健康 URL、日志文件、自动重启策略）。**定义**与**运行**是两回事。

**service** — 控制已保存的服务：`start` / `stop` / `restart` / `delete`（需要 `name`），`start_all` / `stop_all`（可带 `group`；`parallel: false` 逐个启）。`stop` 幂等：本来没跑就返回 `{stopped:false, status:"stopped"}`。

**service_status** — `live`（默认）：保存的服务 + 实时进程状态 + 健康检查，检查受 `timeout_ms` 约束（默认 5000，最大 120000；慢的检查返回 `{ok:false, timed_out:true}` 而不是拖住整个响应）。`definitions`：只列定义，不做探测，适合轮询。

**read_service_log** — 读某个服务的持久日志（默认 service-logs 目录，`save_service` 的 `log_file` 可覆盖）。日志**跨重启追加**。省略 `offset` 读尾部；给 `offset` 往更早翻页。

### 手机通知（notify）

**notify** — 推一条通知到用户手机（Bark）。`event` 四选一：`progress`（常规进展）/ `attention`（需要用户回电脑）/ **`waiting`（你问了问题、不拿到回答就没法继续）** / `finished`（这轮对话结束）。`title`/`message` 可省，缺省有内置话术。

- **提问后必须发 `waiting`**：从服务端看，「AI 答完了」和「AI 在等你选」完全一样——调用都停了。你不说，没人知道对话正卡在一个没人回答的问题上。问完就发，这是硬要求。
- **门是服务端的，不是约定**：两个独立开关 `notify.onTaskDone`（每项任务完成时通知）与 `notify.onFinish`（对话结束时通知），可以都开、都关。被关掉的事件返回 `delivered:false, reason:"switch_off"`——这是结构化的「没送」，不是错误，照常继续干活，别拿 attention 包装常规进展绕门。**`attention` 与 `waiting` 不受开关影响，永远送达**：没人回答的问题会让对话无限期卡住，那不是设置该吞掉的东西。
- **可选的 Bark 参数（每次调用自选）**：`sound`（铃声名，如 `minuet`/`bell`）、`level`（`active` 默认 / `timeSensitive` 穿透专注模式 / `passive` 静默入列表 / **`critical` 无视静音**）、`volume`（0-10，**仅 `critical` 有效**）、`call: 1`（持续响铃直到点开，上限 10）、`badge`（角标 0-9999，0 清除）、`url`（点通知跳转）、`group`（通知分组名，默认 `open-bridge`；多个项目各用各的分组，手机上就不会混成一堆）、`icon`（通知图标，http(s)，iOS15+）、`isArchive`（1 = 存进 Bark 历史，横幅划掉后还能翻出来）、`copy` + `autoCopy`（把一段文本放进「复制」动作，比如一条待执行命令或一个 id）。
  - 非法值一律**点名拒绝**而不是静默丢弃。特别地，`volume` 不配 `critical` 会被拒——设了 volume 的人是**以为它会响**，悄悄忽略等于让一条「紧急」通知变成普通通知。
  - `critical` 能不能真的无视静音，还取决于用户在 iOS 里给 Bark 开了「重要警告」权限。那是手机侧的事，不是桥拒绝这个参数的理由。加密推送（`ciphertext`）仍未开放：它需要预共享密钥，属于操作员配置，不是单次调用的旋钮。
- **清单播报是服务端自动的**：`notify.onTaskDone` 开着时，`set_todos` 每把一条推进 completed 就推一条汇总（一次调用改多条只推一条），关掉则静音。所以开着时**不要**再为清单完成手动 notify。另一面是：**做完一条就勾一条**，别攒到最后一次性提交——批量提交会把一串进展压成一条通知，等于白设这个开关。
- **抑制不消耗预算**：被门挡住的调用不算发送。真实发送有 60 秒 6 条的共享窗口 + 完全相同内容的 60 秒去重；`duplicate`/`rate_limited` 也是 `delivered:false`，改文案或稍后再试。
- **设备密钥只在控制台配置**（设置 → 手机通知，粘贴 `https://api.day.app/<key>` 整条链接会自动摘出密钥）。`get_config` 只回掩码；`notify.serverUrl` 可换自建 Bark（默认官方 `https://api.day.app`，自建 http 仅限本机回环）。
- **无反应监视**：连接静默超过 `notify.idleMinutes`（默认 60，0 = 关），服务端自己推一条 attention——网页 AI 卡死/断线时唯一能叫回人的通道。**不再要求存在未完成清单**：原先那条前提让监视在「AI 压根没写清单」时全程失效，而那恰好是它最该说话的场合（本仓库审计日志实测：某天 1274 次调用里只有 4 次 `set_todos`、0 条通知）。有清单时文案会说「任务还在进行」，没有清单时只说「连接安静了 N 分钟」——两句都只陈述服务端看得见的事实。

### 桥自身状态

**bridge_status** — 一次一个 section：`overview`（健康与计数：`state` / `tool_count` / `build_stale` 等）· `auth`（Bearer 门禁状态、默认有效期、每个令牌的 id/标签/到期/最后使用；**密钥只在创建那一刻显示一次、从不落库**，签发与吊销在控制台「安全」页完成）· `locks`（并发准入表：谁持有什么、等了多久、谁在排队）· `sessions`（当前活着的 MCP 会话）。

**get_config** / **set_config_value** — 读/改运行配置（改完是否需要重启看具体键）。

**activity_log** — `recent`（最近活动，`max_results`）· `search`（按 `tool` / `status` / `query` / `since` 检索 `audit.log` 与轮转文件，`limit` 1–500、`offset` 分页）· `clear`（清空内存缓冲、截断当前审计日志并删掉轮转文件，**不可逆**）。

  - **`at` 是 ISO-8601 UTC，不是操作者的挂钟时间。** 这是刻意的：`since` 过滤要把它反解析成毫秒，机读需要绝对时刻。但 `bridge.log`、控制台日志流和活动视图显示的都是**本机时间**，所以在 UTC+8 的机器上，用户口中的「03:40 那次调用」对应这里的 `19:40Z`。**把时间复述给用户之前先换算**，否则双方会以为在说两件事。`ts`（epoch 毫秒）是同一时刻的另一种表示，做算术时用它更省事。

**get_usage_stats** — 聚合调用统计（总次数、成功/失败、按工具分布）。

### 编排与其他

**batch** — 一次往返跑 1–20 个工具调用：`calls: [{tool, arguments}]`。`mode` `sequential`（默认）/ `parallel`；`fail_fast` 遇到第一个失败就停。每个条目都走**正常分发路径**；失败条目返回 `{tool, ok:false, error}` 不中断其余。嵌套 `batch` 按条目拒绝。

**run_script** — 用一小段 JavaScript 组合本工作区自己的工具：

```js
const hits = await tools.search_files({ query: "TODO", path: "src" });
return { files: [...new Set(hits.items.map(i => i.path))] };
```

- `await tools.<tool_name>(args)` 可调用任何**已公布**工具（旧名同样可用），`run_script` 与 `batch` 不能在脚本里调用。
- 每次运行都是**全新作用域**；`console.log` 收在结果的 `console` 数组里，**不会**代替 `return`。
- 沙箱**没有**文件系统、网络、进程、定时器或模块访问；要访问就通过 `tools.*`。
- 组合调用是**真实的 Bridge 调用**：资源锁、审计日志、脱敏、会话状态与错误语义全部生效。
- 失败时结果带 `phase` / `error_type` / `line` / `code_preview` / `hint`。预算：`timeout_ms` 默认 30000、最大 300000；`max_calls` 默认 60、最大 200。


---

## 旧工具名对照表

旧名仍然可用，互通性由测试保证（每个旧名的参数都被映射到新工具，且新工具一定在对外清单里）。调用旧名时，**对象结果**会多一个 `deprecated` 字段告诉调用方该换成什么；数组/标量结果保持原样，不给解析添麻烦。

| 旧名 | 现在等价于 |
| --- | --- |
| `start_service` / `stop_service` / `restart_service` / `delete_service` | `service{action:"start"/"stop"/"restart"/"delete", name}` |
| `start_all_services` / `stop_all_services` | `service{action:"start_all"/"stop_all", group?, parallel?}` |
| `list_services` | `service_status{detail:"definitions"}` |
| `create_directory` | `file_op{op:"create_directory", path}` |
| `copy_file` / `move_file` | `file_op{op:"copy"/"move", source, destination, overwrite?}` |
| `delete_file` | `file_op{op:"delete", path, recursive?}` |
| `restart_process` | `process_control{action:"restart", command_id, delay_ms?}` |
| `force_terminate` | `process_control{action:"terminate", command_id}` |
| `wait_process` | `wait{command_id, timeout_ms?}` |
| `get_bridge_status` | `bridge_status{section:"overview"}` |
| `get_auth_status` | `bridge_status{section:"auth"}` |
| `get_lock_status` | `bridge_status{section:"locks"}` |
| `list_sessions` | `bridge_status{section:"sessions"}` |
| `get_recent_activity` | `activity_log{action:"recent", max_results?}` |
| `search_activity_log` | `activity_log{action:"search", …}` |
| `clear_activity_log` | `activity_log{action:"clear"}` |
| `check_port` | `connectivity{target:"port", host, port, timeout_ms?, scope?}` |
| `check_http` | `connectivity{target:"http", url, timeout_ms?, max_redirects?, scope?}` |
| `list_shells` | `open_shell{list:true}` |

---

## 描述预算（为什么描述这么短）

- 工具定义**常驻客户端上下文**，会话里每一轮都在付这份开销；因此每条描述压到 **≤200 字符**，只留"做什么 + 现场必须知道的规则"。
- 被移走的解释、边界、路由建议都在**这份文件**里；重复出现在多个工具里的字段约定提到了**服务端 instructions** 的一段（只发一次）。
- 4 个测试钉住这件事：≤200 字符、≥20 字符、本文档必须覆盖全部工具并保留「结果字段约定」「路由表」两节、任何描述都不许重复那句全局规则。
