# 工具详解（每个工具的完整说明）

`tools/list` 里每个工具的描述只留**一句做什么 + 现场必须知道的规则**（≤200 字符）。完整的行为、边界、字段约定，以及在相似工具之间怎么选，都在这里。

阅读方式：客户端把这份文件当普通工作区文件读（`read_files docs/tools.md`），或按标题跳到你关心的那个工具。

**本版对应工具族的合并**（v1.0 起）：服务、文件系统操作、进程控制、桥状态、审计日志、连通性六组近义工具，各自合并成一个带 action 参数的工具。**旧名字一个都没删**，仍然可用，会转发到新工具并在结果里标注 `deprecated`；对照表在文末。

---

## 结果字段约定（所有工具通用）

- `tools/list` 中每个工具的 `inputSchema` 是规范调用的机器可读契约：必填字段、枚举、互斥/替代输入和字段类型都以它为准。旧工具名和旧参数仍会先兼容转换；新调用应按规范工具名与该 schema 组装参数，避免依赖未公布的处理器宽容行为。
- 返回值是 JSON 对象，**每个工具的字段集是固定的**：缺失的事实表现为 `null` 或空字符串，**不会**靠"某个字段不在"来表达。所以永远**按字段名解析，不要按行数/行是否存在来解析**。
- 命令类工具（`run_command`、`start_process`、`send_to_shell`、`interact_with_process`）返回**合并输出 `output`**，同时给出**分离的 `stdout` / `stderr`**；分页读取还带 `offset` / `next_offset` / `truncated`。
- 命令**非零退出码不是调用失败**：调用可以返回 `status: "completed"` 且 `exit_code != 0`，必须自己看 `exit_code`。
- 声明了 `outputSchema` 的工具同时返回 `structuredContent`（类型化数据，**永远是 JSON 对象**），且成功响应必须符合 `tools/list` 中公布的这个 schema。处理器的兼容文本仍可能是裸数组；此时类型化载荷用 `{ items: [...] }` 包装——目前包括 `read_files`、`service_status` 和 `activity_log{action:"recent"}`，解析类型化结果时读 `items`。**被截断过的结果一定明说**：三个列举类工具（`list_directory`、`find_files`、`search_files`）都返回 `{ items: [...], truncated: boolean, next_offset }`，而不是裸数组。`truncated: true` 的意思是"结果不是完整集合，别把这一页当全部"；对可逐页列举的行结果，`next_offset` 非 `null` 时原样回传为下一次的 `offset`，`null` 表示本页已结束。命中上限既不代表"结果为空"，也不代表"就这些"。`list_directory` 另外给 `total`（只在平铺 `depth: 1` 时是真实总数，其余为 `null`）。文本块始终保留。
- **结果里可能多出一个 `Note:` 文本块**，它不改变字段集。目前只用于提示**本进程跑的是比 `dist/` 更旧的构建**（每个进程只说一次；重启实例后再看）。`deprecated`（见文末旧名表）走的是同一条路：只进文本块，不进 `structuredContent`。
- 出错时返回 `isError: true` 与一句话原因；错误信息通常给出下一步（例如"先 `read_files` 再重试"）。成功结果的文本和 `structuredContent` 形状不会因错误契约而改变。
- **机器可读的输入错误详情**：P7 已统一的 `Missing`、`Invalid`、`Conflict` 工具错误，除保留原文本外，还会在 `structuredContent.error` 提供 `{ kind, tool, fields, message }`。`kind` 是稳定枚举：`missing`（漏传）、`invalid`（值不合约）或 `conflict`（互斥输入同时给出）；`tool` 总是规范工具名；`fields` 是相关字段名数组；`message` 与第一个文本块完全相同。其他业务错误仍仅保留原有文本。已声明 `outputSchema` 的工具在这类错误结果也允许此对象——其成功输出 schema 不会拿来校验错误详情。协议层的请求格式错误仍是 JSON-RPC/MCP 协议错误，不伪装成工具错误。
- **常见输入错误的开头有固定含义**：`Missing …` 表示漏传了字段（或一组选项）；`Invalid …` 表示字段已给但值不合约；`Conflict: …` 表示同时给了互斥的输入方式。三类信息都会点名字段和可行的改法；文件版本冲突、路径保护和外部命令失败等业务错误会保留各自更具体的说明。

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
| 手机响一声 | `notify`（仅等待回答或对话结束） | 不要 `report_progress`（那只进客户端日志流，不碰手机） |
| 想批量并行调用 | `batch`（`mode: "parallel"`） | 嵌套 `batch` 会被拒绝 |

---

## 逐个工具

### 工作区读取

**list_directory** — 列目录。`depth` 1–3、`include_hidden`、`max_entries`、`offset`；结果是 `{items: [{name, type}], truncated, total, next_offset}`。平铺 `depth: 1` 时，非空 `next_offset` 可直接续页，末页为 `null`；`total` 是真实总数。`offset` 只对平铺有意义 —— 和 `depth > 1` 一起给会被明确拒绝，而不是悄悄按某一层分页。递归结果的 `total`、`next_offset` 都是 `null`；若因 `max_entries` 被截断，`truncated` 仍会明确说明，但递归树没有可恢复的页游标。

**find_files** — 按 glob 找文件（`*`、`**`、`?`、`{a,b}`、`[abc]`）；纯名字/前缀仍按 basename 匹配，`src/**/*.ts` 这种按完整相对路径匹配。`offset` + `max_results` 翻页，结果固定为 `{items, truncated, next_offset}`；上限只在**已收集到的数量**上生效，所以"正好到达上限"会如实报告 `truncated: true`（内部多探一个，不靠猜）。`max_results: 0` 只用于探测：会返回空 `items` 和 `next_offset: null`，应改用正数才能继续翻页。

**search_files** — 在工作区文件里搜文本：有 ripgrep 就用（快），否则内置扫描；两套引擎**看的文件集合完全相同**：`.git`、`node_modules`、`dist` 之外一律都搜，**`.gitignore` 不会让文件消失**（它管的是提交，不是文件是否存在；同一次搜索的结果不该因为正则语法触发哪套引擎而不同）。`query` 默认按**正则**解析（`regex: false` 才按字面匹配；非法正则直接报错，不会静默给空）；`include` 限定文件（如 `["*.ts"]`）；`context`（0–20）在每处匹配前后带若干行；`offset` + `max_results` 翻页，结果的 `next_offset` 可直接作为下一次 `offset`。`max_results: 0` 返回空页且不给续读游标，避免原地循环；需要翻页时用正数。`path` 可以是目录或单个文件。

- 正则语义是 **JavaScript** 的（内置扫描用的就是 `RegExp`）。ripgrep 的默认引擎不支持先行/后顾（`(?=`、`(?!`、`(?<=`、`(?<!`）与反向引用（`\1`），这类查询会由内置扫描回答 —— 结果一致，只是慢一些，不会因此少给或不报错。看到空结果时先确认不是正则写错或 `include` 太窄。

**read_files** — 读一个或多个文件；大文件用 `start_line` / `end_line`（1 基、含两端）读区间。`sha256` 要么是**整个文件**的摘要（可直接作 `expected_sha256` 做乐观写入），要么是 `null` —— 它**永远是一个存在的字段**，绝不会因为读法不同而消失。只有读到文件末尾时才有值：`max_bytes` 截断、或没读到最后一行的区间读，都拿不到整个文件的摘要，此时为 `null`（不会为了一个哈希去重读整个文件，那会让「2 GB 日志取 5 行」退化成全量扫描）。需要截断读之后的摘要，用 `get_file_info`。`encoding: "base64"` 读二进制。

**get_file_info** — 元数据。≤128 MiB 的文件带 `sha256`；更大的返回 `null`，而不是把整个文件读进内存。

**workspace_brief** — 一次拿到项目全貌：工作区路径、顶层结构、清单文件、`AGENTS.md` / `CLAUDE.md`、git 分支与脏文件数、近期活动。**刚接手不熟悉的项目先调用它一次。**

**list_skills** — 列出工作区可用技能（含 `SKILL.md` 的目录）。服务端 instructions 里是**连接时**的快照；中途新增技能后用这个刷新，再 `read_files` 对应 `SKILL.md` 照做。

**review_changes** — 自上次查看以来全部改动的累积 git diff（含编辑、shell 侧效应和之后的提交）。需要 Git 仓库且至少一次提交；`mark_reviewed`（默认 true）展示后推进基线。一批编辑做完后调用，让用户看完整改动集。结果的 `summary` / `files` / `patch` 是整个审阅窗口，可能含已提交历史；另读 `working_tree: { clean, summary }` 判断当前是否还有未提交工作：`clean: true` 时不要把上面的历史 diff 误读为工作区仍有改动。

**get_todos** — 读任务清单与 `last_progress`。

### 工作区写入

**write_file** — 新建或覆盖。必须提供 `content` 或 `content_base64`（两者同给时按 `content_base64` 写）；`mode: "append"` 追加；`expected_sha256` 防止覆盖已变化的文件。追加**按目标文件现有的换行风格**写入（CRLF 文件里的新行也是 CRLF，LF 文件里就是 LF —— 只有追加的这段被归一，磁盘上原有的字节不动）；`content_base64` 追加**按字节原样**，不做换行归一，因为那条路是给二进制用的。

**edit_block** — 单文件精确替换有两个互斥输入：单次替换必须给 `old_text`（`new_text` 省略即删除），或一次给 1–20 个 hunk（`edits`），**全部命中才写**。`old_text` 必须**恰好匹配一次**（除非用 `expected_replacements` 指定次数）；零匹配时错误里附**最接近的一段文本**与可能的漂移原因。带 `expected_sha256` 防陈旧编辑。

**apply_patch** — 两种语法：经典 unified diff（只能改已存在文件）与 ShunCode 块（`*** Add File:` / `*** Update File:` / `*** Delete File:`，可新建与删除）。`patch` 与 `patch_file` 二选一；`expected_sha256` 按路径映射校验。

**file_op** — 见上文工具族：`create_directory`（`path`）· `copy` / `move`（`source`、`destination`、可选 `overwrite`）· `delete`（`path`、可选 `recursive`）。`structuredContent` 按操作返回 `{path, created}`、`{source, destination, unchanged?}` 或 `{path, deleted}`；copy 与普通 move 共用传输形状。

- `path` / `source` / `destination` 缺失时**直接报错**（`Missing "path".`），不再被 `String(undefined)` 变成名为 `undefined` 的文件。
- **自毁护栏**：`delete` / `move` 的目标若命中**工作区根、Bridge 数据目录（`~/.open-bridge`）、盘根**，或它们的祖先目录，一律拒绝（`Refusing to delete "…"`）。`unrestrictedFileAccess` 不变 —— 工作区外的普通路径照旧可读写，真要清空请用 `run_command`。
- `move` + `overwrite=true` 时，**文件不能落在已存在的目录上**（那会把整个目录换成一个文件）；写成 `destination: "d/<文件名>"` 即可放进目录里。
- 字符串/数字形式的布尔值（`"false"`、`"0"`、`1`）按声明类型归一：`recursive:"false"` 就是 false，`list:"false"` 就是"开 shell"而不是"列 shell"。

同一份「必须有值」的契约覆盖所有带路径的工具：`write_file` / `edit_block` / `get_file_info` 的 `path`、`read_files` 的 `paths` 每一项，缺失或为空时一律 `Missing "path".` / `paths[0] must be a non-empty string.`。**不会有任何操作去写、改、删一个名叫 `undefined` 或 `null` 的文件**（这正是修之前的实际行为）。

**set_todos** — 存**完整**任务列表（条目需 `id` / `title` / 合法 `status`）。多步工作的正式清单。

**report_progress** — 报**瞬时**进度：写入活动日志并以 MCP `notifications/message` 推给客户端。`phase` 与 `category` 是**封闭词表**，表外取值会被丢掉；自由文本放进 `message`。

### 命令与进程

**run_command** — 命令文本由 shell 解释：`shellPath` / `shellArgs` 未配置时自动探测（Windows：Git Bash → PowerShell 7 → Windows PowerShell），连接时下发的 instructions 会点名实际解释器与方言——写错方言不一定报错，`2>nul` 在 bash 下会生成一个名为 `nul` 的文件。前台等待最多 `timeout_ms`（默认 120000）。**超时不会杀掉进程**：它继续在监管下运行，返回 `status: "running"` 与 `command_id`，之后用 `read_process_output` / `wait` 继续读，或用 `process_control{action:"terminate"}` 停掉。退出码非零**不是**调用失败。链式命令（`a; b`）的 `exit_code` 取最后一段，要前一段的退出码就以 `echo EXIT=$?` 结尾。`structuredContent` 区分三种结果：已完成前台命令（含 `exit_code`）、`background:true` 的受监管启动（含 `ready` / `ready_checked`）和超时但仍运行的命令（含 `message` 与继续所需的 `command_id`）。

**长任务不要占住一次前台 MCP 请求。** 构建、验证、迁移或任何耗时不确定的命令应传 `background: true`，立即取得 `command_id`，再用 `read_process_output`、`wait` 或 `process_control` 续读、等待或终止；不要因客户端/传输层等待超时就重发原命令——那会并发执行两次有副作用的工作。例：`run_command{command:"npm run verify", background:true, resource_keys:["build:dist"]}`，随后按返回的 `command_id` 读取输出。无论命令是后台还是 `start_process` 启动，只在传入 `ready_pattern` 时 `ready` 才是实际观察到的就绪信号；没有该模式时保留的 `ready:true` 只表示**没有请求就绪检查**，请看 `ready_checked:false` 与 `status` / `exit_code`。

**start_process** — 面向**长驻**进程（服务器、watcher、守护进程）：`ready_pattern` 等启动输出，返回 `command_id` 交给进程工具组。就绪等待由 **`ready_timeout_ms`**（毫秒，默认 **10000**，上限 2147483647）控制：等不到就让调用返回 `ready: false` + `status: "running"`，**不会杀进程**（慢启动的构建要放宽，就调这个值）。这里**没有 `timeout_ms`** —— 那是 `run_command` 的（前台运行才有"完成"可限时）；传了会**点名拒绝**，而不是像以前那样被静默忽略。其类型化启动结果明确携带 `ready`、`ready_checked`、输出截断计数与 `command_id`；`ready_checked:false` 表示没有请求模式检查，而不是已经观察到就绪。

**read_process_output** — 分页读受监管命令的输出：`offset` / `max_bytes`，`stream` 只读一路，`wait_ms`（最大 60000）阻塞等待**新**输出。默认 128 KiB/次，大输出传更大的 `max_bytes`，用 `next_offset` 翻页，`truncated` 告诉你还有没有。它和 `interact_with_process` 的 `structuredContent` 共用同一份分页契约：`offset` 是本页实际起点（省略入参时从最早仍保留的字节开始；请求已丢弃的早期位置会报错、绝不静默跳过），`next_offset` 是下一页入参，`output_available_bytes` 是当前仍保留的字节，`dropped_bytes` 是已不再可读的早期字节；这四项都按所选 `stream` 计数。`truncated` 的意思是本页未覆盖完整流（可能少了前面、也可能少了后面）；要判断后面是否还有已捕获内容，比较 `next_offset < output_bytes`。

**interact_with_process** — 给进程送输入并返回**这次输入之后**产生的输出（不传 `offset` 就不必自己记游标；`wait_ms` 上限 60000，与 `read_process_output` 一致）。面向普通非 PTY 管道；完整终端会话请用 `open_shell`。

**process_control** — `restart`（用原命令与原 cwd 重起，可带 `delay_ms`）· `terminate`（强制结束）。都按 `command_id`。restart 的 `structuredContent` 为 `{command_id, restarted, restart_count, auto_restart}`；terminate 则提供包含 `terminated`（及必要时 `already_exited`）的最终进程 snapshot。

**wait** — 至少给 `ms`（睡一会儿）或 `command_id`（+ 可选 `timeout_ms`，等该进程退出）之一；两者都给时按进程算。`structuredContent` 随实际模式返回：`ms` 是 `{ waited_ms }`；`command_id` 是最终进程 snapshot，另带合并 `output`、`stdout`、`stderr` 和 `truncated`（以及相应输出字节计数）。

**set_process_policy** — 调整一个受监管进程的自动重启策略；`structuredContent` 固定为 `{ command_id, auto_restart, max_restarts, restart_delay_ms }`，即实际应用后的四个策略值。

**get_process_snapshot** — 一次列出所有受监管进程（状态、命令、cwd、启动时间）。排查"现在到底有什么在跑"时先用它。传 `command_id` 时 `structuredContent` 是该进程对象；省略时兼容文本仍是数组，而类型化结果为 `{items: [...]}`。

**open_shell** — 开一个**具名持久 shell**（需要 bash/sh，Windows 上是 Git Bash）。同一个 shell 跨调用存活，`cd`、导出变量、激活的 virtualenv **都保留**；`list: true` 则返回当前开着的 shell 列表（`name` / `command_id` / `cwd` / `alive` / `started_at`）。打开/复用时 `structuredContent` 是一个 shell 对象；列举时兼容文本是数组、类型化结果为 `{items: [...]}`。

**send_to_shell** — 在 `open_shell` 开的 shell 里跑命令，经哨兵字符串等它结束（上限 `timeout_ms`），返回输出与退出码；超时则 shell 保持开着。`structuredContent` 固定给出 `{ name, command_id, output, stdout, stderr, exit_code, timed_out, status, shell_alive, cwd }`；若本次输出的前段已被保留上限挤掉，另有 `output_dropped: true`，超时时还有继续读取/重试说明 `note`。`status` 是 `completed`、`running` 或 `shell_exited`，而非靠字段缺失判断。

**close_shell** — 关掉某个持久 shell。`structuredContent` 互斥地为成功的 `{ name, closed: true }`，或该名称本来未打开的 `{ name, closed: false, reason: "not_open" }`。

### 结构化返回补充

**文件写入与审阅** — `write_file` 固定返回 `{ path, bytes, mode, sha256 }`（二进制写入额外给 `encoding: "base64"`）；`edit_block` 固定返回 `{ path, replacements, sha256 }`，可附 `applied_edits` / `diff`；`apply_patch` 固定返回 `{ applied: true, files, changes }`，每项 `changes` 明确给路径、动作、增删行数和 diff。`review_changes` 则明确区分不可用的 `{ available: false, reason }` 与可审阅的 diff 结果。`workspace_brief` 固定含工作区、顶层条目、指令文件、Git 摘要和 Bridge 摘要，存在时才附 manifests / skills。

**配置、任务与批量调用** — `get_config` 是完整且字段固定的运行时配置（`notify.barkKey` 始终为脱敏提示）；`set_config_value` 返回 `{ key, value }`；`get_usage_stats` 固定含累计计数和 `by_tool`。`set_todos` 的兼容文本仍是数组，但 `structuredContent` 为 `{ items: [...] }`；`get_todos` 固定含会话任务、持久任务、上次进度和保存时间；`report_progress` 确认 `{ received, message, pushed }`，再按需要返回阶段/类别/百分比/任务编号。`batch` 固定给总数、成功/失败数、是否提前停止及每个子调用的成功结果或错误。

**读取、探测与 Bridge 状态** — `read_process_output` 与 `interact_with_process` 的分页结果固定携带 `command_id`、`stream`、`offset`、`next_offset`、累计字节、丢弃字节和 `truncated`；`read_service_log` 也固定携带同样可续读的 offset / next_offset / truncated 核心字段。它们是**追加字节流**而不是有限行集合：`next_offset` 始终是下一次读取的绝对字节位置（即使已经读到当前末尾，也保持数字，之后新增输出可从那里读）；`truncated` 表示这次读没有覆盖所有可用字节，不能单独理解成“后面必定还有一页”。`connectivity` 用互斥结果区分 TCP（host / port / open）和 HTTP（url / status / redirects）探测。`bridge_status` 按 `overview`、`auth`、`locks`、`sessions` 四种 section 返回对应的精确对象；sessions 的类型化结果为 `{ items: [...] }`。

### 连通性与服务

**connectivity** — 至少给 `url` 或 `port` 之一；`target` 可省略（会据此推断）。`{url}` 探 HTTP(S)：状态码与延迟，最多跟 5 次重定向，URL 里的 userinfo 当 Basic 认证，目标地址**先解析再固定**。`{port}` 或 `{host, port}` 探 TCP 是否可连。用它们做就绪判断，别用 `curl`。

**save_service** — 定义/更新一个命名服务（命令、cwd、group、port、健康 URL、日志文件、自动重启策略）。**定义**与**运行**是两回事。

**service** — 控制已保存的服务：`start` / `stop` / `restart` / `delete`（需要 `name`），`start_all` / `stop_all`（可带 `group`；`parallel: false` 逐个启）。`stop` 幂等：本来没跑就返回 `{stopped:false, status:"stopped"}`。单服务的 `structuredContent` 分别为启动 `{name, command_id, status}`、停止 `{name, command_id, stopped, status, hint?}`、重启 `{name, command_id, restarted}` 或删除 `{name, deleted, stopped, hint?}`；两种 `*_all` 保持兼容文本数组，并以 `{items:[...]}` 提供类型化结果。

**service_status** — `live`（默认）：保存的服务 + 实时进程状态 + 健康检查，检查受 `timeout_ms` 约束（默认 5000，最大 120000；慢的检查返回 `{ok:false, timed_out:true}` 而不是拖住整个响应）。`definitions`：只列定义，不做探测，适合轮询。

**read_service_log** — 读某个服务的持久日志（默认 service-logs 目录，`save_service` 的 `log_file` 可覆盖）。日志**跨重启追加**。省略 `offset` 读当前尾部；给 `offset` 从该绝对字节位置向后读，并把返回的 `next_offset` 原样用于下一次读取。因为日志可以继续增长，读到当前末尾时 `next_offset` 仍是数字；`truncated` 同时覆盖省略 `offset` 时未返回的较早内容和受 `max_bytes` 限制时未返回的较晚内容。

### 手机通知（notify）

**notify** — 只在确实需要人回来处理时推送 Bark。`event` 只能是 **`waiting`**（你问了问题或给出选择，不拿到回答就没法继续）或 **`finished`**（这轮对话结束）。`title` / `message` 可省，缺省有内置话术。

- **提问或选择前（或同一轮）发 `waiting` 一次**：必须在会暂停本轮的提问 UI 出现前发出，这是 AI 明确等人回答的信号。一般进度和任务清单完成绝不通知。
- **结束时发 `finished` 一次**，作为这一轮的最后动作；若遗漏，服务端仅会在**连续十分钟**没有可观察活动后做一次结束兜底。
- **每轮最多一条提醒**：Bark 固定使用 `level=timeSensitive&call=1`，Bridge 不会重复推送；任一普通工具调用表示工作恢复，才开启新的提醒轮次。
- **设备密钥只在控制台配置**（设置 → 手机通知，粘贴 `https://api.day.app/<key>` 整条链接会自动摘出密钥）。`get_config` 只回掩码；`notify.serverUrl` 可换自建 Bark（默认官方 `https://api.day.app`，自建 http 仅限本机回环）。

### 桥自身状态

**bridge_status** — 一次一个 section：`overview`（健康与计数：`state` / `tool_count` / `build_stale` 等）· `auth`（Bearer 门禁状态、默认有效期、每个令牌的 id/标签/到期/最后使用；**密钥只在创建那一刻显示一次、从不落库**，签发与吊销在控制台「安全」页完成）· `locks`（并发准入表：谁持有什么、等了多久、谁在排队）· `sessions`（谁在连：legacy 会话逐条给 `session_id` / `connected_at` / `last_used` / `calls` / `todo_count` / `closable`；无会话的现代协议客户端占一行 `era: "modern"`、`stateless: true`、`closable: false`，带 `connected_at: null` 与 `first_seen`，不谎报挂在会话上的 `calls` / `todo_count`；这一行还带 `in_flight`（此刻正在服务的现代请求数：一次长调用期间它不为 0，而这正是「安静」与「还在干活」的区别）。overview 里的 `active_sessions` **只数 legacy 会话**，旁边的 `modern_last_used`（ISO 时间戳或 `null`）与 `modern_in_flight` 才说明另一端有没有现代客户端在说话、以及它当下忙不忙 —— 「有没有人连着我」要这几个字段一起看。）

**get_config** / **set_config_value** — 读/改运行配置（改完是否需要重启看具体键）。`get_config` 的 `structuredContent` 完整声明当前所有运行时配置字段及其类型；Bark 设备密钥仍仅返回掩码，绝不返回明文。

**activity_log** — `recent`（最近活动，`max_results`）· `search`（按 `tool` / `status` / `query` / `since` 检索 `audit.log` 与轮转文件，`limit` 1–500、`offset` 分页）· `clear`（清空内存缓冲、截断当前审计日志并删掉轮转文件，**不可逆**）。其 `structuredContent` 随 action 明确分支：`recent` 为 `{items}`，`search` 为 `{entries, total_scanned, truncated, next_offset}`（`next_offset` 可直接续页），`clear` 为 `{cleared_memory_entries, live_truncated, rotated_removed}`。

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

**参数没被采纳时会说出来**：`deprecated.ignored` 列出被丢弃的键，以及被本工具固定取值覆盖的键 —— `get_bridge_status{section:"sessions"}` 仍按旧义返回 overview，但结果里写着 `ignored: {section: {sent: "sessions", used: "overview"}}`。旧名不是通往新参数的后门，但调用方有权知道自己传的东西没被采纳。

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

## 两代会话：客户端会遇到的两种「没有会话」

同一个 `/mcp/<token>` 端点吃两种客户端：**2025 世代**（`initialize` 换 `mcp-session-id`，之后每个请求都带它）与 **2026-07-28 世代**（无会话，每个请求自带 `params._meta` 信封与 `mcp-*` 头）。era 由请求自己决定，没有配置开关。

旧世代客户端没带可用会话时，服务端把两种失败**分开回答**（都在 `error.data.reason` 里点名）：

| 情况 | HTTP | `error.code` | `error.data.reason` | 下一步 |
| --- | --- | --- | --- | --- |
| 请求完全没有 `mcp-session-id` 头 | `400` | `-32000` | `initialize-required` | 先 `initialize`，把返回的 `mcp-session-id` 带上 |
| 带了 id，但服务端不认识 | `404` | `-32001` | `session-expired` | 再 `initialize` 一次换个新 id |

会话**只在内存里**：Bridge 重启、空闲回收、或者同一个 URL 后面换了实例，都会让旧 id 消失，而客户端那边还以为连着 —— 上表第二行就是给这种时刻准备的（404 也是规范对未知会话 id 的要求）。

`initialize` 永远不会被这两个错误拦住：带着过期 id 重新握手照样成功，并拿回一个可用的新 id（容忍是刻意的，重连不需要特例）。现代世代的请求不受影响 —— 它们本来就没有会话可丢。

---

## 描述预算（为什么描述这么短）

- 工具定义**常驻客户端上下文**，会话里每一轮都在付这份开销；因此每条描述压到 **≤200 字符**，只留"做什么 + 现场必须知道的规则"。
- 被移走的解释、边界、路由建议都在**这份文件**里；重复出现在多个工具里的字段约定提到了**服务端 instructions** 的一段（只发一次）。
- 4 个测试钉住这件事：≤200 字符、≥20 字符、本文档必须覆盖全部工具并保留「结果字段约定」「路由表」两节、任何描述都不许重复那句全局规则。
