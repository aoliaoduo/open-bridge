# 工具详解（每个工具的完整说明）

`tools/list` 里每个工具的描述只保留**一句做什么 + 现场必须知道的规则**（≤200 字符，见「描述瘦身」一节）。完整的行为、边界、字段约定、以及在几个相似工具之间怎么选，都在这里。

阅读方式：客户端把这份文件当普通工作区文件读（`read_files docs/tools.md`），或按标题跳到你关心的那个工具。

---

## 结果字段约定（所有工具通用）

- 返回值是 JSON 对象，**每个工具的字段集是固定的**：缺失的事实表现为 `null` 或空字符串，**不会**靠"某个字段不在"来表达。所以永远**按字段名解析，不要按行数/行是否存在来解析**。
- 命令类工具（`run_command`、`start_process`、`send_to_shell`、`interact_with_process`）返回**合并输出 `output`**，同时给出**分离的 `stdout` / `stderr`**；分页读取还带 `offset` / `next_offset` / `truncated`。
- 命令**非零退出码不是调用失败**：调用可以返回 `status: "completed"` 且 `exit_code != 0`，必须自己看 `exit_code`。
- 声明了 `outputSchema` 的工具同时返回 `structuredContent`（类型化数据），文本块仍然保留以便兼容。
- 出错时返回 `isError: true` 与一句话原因；同名工具的错误信息里通常会给出下一步（例如"先 `read_files` 再重试"）。

---

## 在相似工具之间怎么选（路由表）

| 场景 | 用哪个 | 不用哪个 |
| --- | --- | --- |
| 一次性命令、看完就结束 | `run_command` | 不要用 `start_process`（它面向长驻进程） |
| 服务器 / 守护进程 / watcher | `start_process`（可 `ready_pattern` 等启动完成） | 不要用 `run_command`（会一直等） |
| 需要保持 cwd / venv / 导出变量的连续交互 | `open_shell` + `send_to_shell` | 不要用 `run_command` 反复 `cd` |
| 想反复重启的命名守护进程 | `save_service` 定义，然后 `start_service` / `stop_service` / `restart_service` | — |
| 单文件精确替换 | `edit_block` | 不要用 `apply_patch`（多文件才划算） |
| 多文件改动、新建/删除文件 | `apply_patch` | — |
| 就绪探测（端口 / HTTP） | `check_port` / `check_http` | 不要用 `run_command curl`（慢且要自己解析） |
| 连续多次相关调用、或结果很大 | `run_script`（在脚本里循环、过滤、聚合，只把需要的返回） | 逐个调用会浪费往返与上下文 |
| 想批量并行调用 | `batch`（`mode: "parallel"`） | 嵌套 `batch` 会被拒绝 |

---

## 逐个工具

### run_command

`run_command` 前台等待最多 `timeout_ms`（默认 120000，可为 0 表示不等待）。**超时不会杀掉进程**：它继续在监管下运行，调用返回 `status: "running"` 和一个 `command_id`，之后用 `read_process_output` / `wait_process` 继续读，或用 `force_terminate` 停掉。

`background: true` 立刻返回一个 `command_id`，不等待任何输出（长驻服务用 `start_process` 更合适，因为它多了 `ready_pattern`）。`visible: true` 会在用户可见的终端窗口里跑，便于当事人盯着看。

退出码非零**不是**调用失败，见上文「结果字段约定」。

### edit_block

单文件精确替换：`old_text` / `new_text`。`old_text` 必须**恰好匹配一次**，除非用 `expected_replacements` 明确指定次数；`replace_all: true` 时全部替换。

也可以一次给 1–20 个 hunk（`edits: [{old_text, new_text}, …]`）：**全部命中才写**，任何一个 hunk 匹配不到就整体不落盘（因此不用担心"改了一半"）；`edits` 模式下 `expected_replacements` / `replace_all` 被忽略。

零匹配时错误里会附带**最接近的一段文本**和可能的漂移原因，照着重读文件、原样复制 `old_text` 即可。带 `expected_sha256`（来自 `read_files`）可以防止基于旧内容的编辑。

### apply_patch

两种语法：

1. **经典 unified diff**（`--- a/dir/file`、`+++ b/dir/file`、`@@` hunk）——只能**修改已存在**的文件；
2. **ShunCode 块**（`*** Begin Patch` / `*** Add File: dir/file` / `*** Update File: dir/file` / `*** Delete File: dir/file` / `*** End Patch`）——可以**新建与删除**文件。

`patch`（内联）与 `patch_file`（工作区里的补丁文件）二选一。`expected_sha256` 是把"工作区路径 → 哈希"映射起来防陈旧。多文件改动或需要新建/删除文件时用它；单文件字符串替换用 `edit_block` 更省事。

### run_script

用一小段 JavaScript 组合本工作区自己的工具，而不是逐个调用：

```js
const hits = await tools.search_files({ query: "TODO", path: "src" });
const files = [...new Set(hits.items.map(i => i.path))];
return { files, count: files.length };
```

- `await tools.<tool_name>(args)` 可以调用任何已公布工具；`run_script` 与 `batch` **不能**在脚本里调用（避免递归）。
- 每次运行都是**全新作用域**，什么都不跨运行保留；`console.log` 的输出会收在结果的 `console` 数组里，但**不会**代替 `return`。
- 沙箱**没有**自己的文件系统、网络、进程、定时器或模块访问；要访问它们就通过 `tools.*`。
- 组成脚本的每次调用都是**真实的 Bridge 调用**：资源锁、审计日志、脱敏、会话状态与错误语义全部生效（也就是说它省的是往返和上下文，不是审计）。
- 失败时结果里有 `phase` / `error_type` / `line` / `code_preview` / `hint`，照提示改脚本再跑。
- 预算：`timeout_ms` 默认 30000、最大 300000；`max_calls` 默认 60、最大 200。

### batch

一次往返里跑 1–20 个工具调用：`calls: [{tool, arguments}, …]`（`args` 是 `arguments` 的可接受别名）。`mode: "sequential"`（默认）或 `"parallel"`；`fail_fast` 只在 sequential 下有效，遇到第一个失败就停。

每个条目都走**正常分发路径**（计数、审计、脱敏、错误语义）。失败的条目返回 `{tool, ok:false, error}`，**不会**中断其余条目。嵌套 `batch` 按条目拒绝。

### review_changes

把**自上次查看以来**你改过的一切合成一份 git diff：`edit_block` / `write_file` / `apply_patch` 的改动，以及**shell 命令造成的副作用**。需要工作区是 Git 仓库且至少有一次提交；否则返回 `available: false`。

`mark_reviewed` 默认 `true`：展示之后基线推进到当前状态。`since: "workspace_open"` 改成对照工作区第一次检查点。`max_patch_bytes`（默认 65536）用"头+尾"截断超大补丁。一批相关编辑做完后调用它，让用户看完整改动集。

### read_files

读一个或多个工作区文件。大文件用 `start_line` / `end_line`（1 基、含两端）读区间；**返回的 `sha256` 始终覆盖整个文件**，所以拿它当 `expected_sha256` 做乐观写入是安全的。`encoding: "base64"` 读二进制。

### start_process

面向**长驻**进程（服务器、watcher、守护进程）：`ready_pattern` 可以等启动输出出现再返回，`visible: true` 在用户可见终端里跑。返回 `command_id`，之后交给 `read_process_output` / `wait_process` / `interact_with_process` / `restart_process` / `force_terminate` / `set_process_policy` 这一组进程工具。一次性命令用 `run_command`。

### open_shell / send_to_shell

`open_shell` 开一个**具名持久 shell**（需要 bash/sh，Windows 上是 Git Bash）。同一个 shell 跨调用存活，所以 `cd`、导出变量、激活的 virtualenv **都保留**；`send_to_shell` 通过哨兵字符串等命令结束（上限 `timeout_ms`），返回输出与退出码，超时则 shell 保持开着。

`list_shells` 列出当前开着的持久 shell；`close_shell` 关掉其中一个（`name`）。适合 REPL/交互流程；守护进程用 `start_process`，一次性命令用 `run_command`。

### search_files

在工作区文件里搜文本：有 ripgrep 就用（快、尊重 `.gitignore`），否则用内置扫描。`regex: true` 把 `query` 当正则；`include` 是文件 glob（如 `["*.ts"]`）；`context`（0–20）在每处匹配前后各带若干行；`offset` + `max_results` 用来翻页。

注意：`path` 必须是**目录**；只搜一个文件时直接传那个文件路径（它会只扫这个文件），或用 `include` 限定。

### check_http / check_port

`check_http` 探测 HTTP(S) 状态码与延迟：最多跟 5 次重定向，URL 里的 userinfo 会当 HTTP Basic 认证，目标地址**先解析再固定**（防止重定向途中换到别的机器）。`check_port` 查 TCP 端口是否可连（`scope` 默认 `"any"`）。做就绪判断时优先用它们，而不是 `run_command curl`。

### service_status / 服务工具组

`service_status` 读保存过的服务定义**加**实时进程状态，健康检查受 `timeout_ms` 约束（默认 5000，最大 120000）：某一项超时会返回 `{ok:false, timed_out:true}` 而不是把整个响应拖住。`list_services` 只列定义。

`save_service` 定义（可带 `log_file` 覆盖默认日志路径），`start_service` / `stop_service`（幂等，未运行时返回 `{stopped:false, status:"stopped"}`）/ `restart_service` / `delete_service` 控制单个；`start_all_services` / `stop_all_services` 支持按 `group` 与 `parallel` 批量。`read_service_log` 读持久日志（**重启不会截断**，日志跨重启追加）。

### 进程工具箱：read_process_output / interact_with_process / wait_process / wait 等

`get_process_snapshot` 一次列出所有受监管进程（状态、命令、cwd、启动时间）——排查「现在到底有什么在跑」时先用它；`restart_process` 用原命令与原 cwd 重起（可带 `delay_ms`）；`set_process_policy` 调整监督策略（超时、输出上限等行为）。

`read_process_output` 分页读受监管命令的输出：`offset` / `max_bytes`，`stream: "stdout" | "stderr"` 只读一路，`wait_ms`（最大 60000）阻塞等待**新**输出而不是立刻返回空。`interact_with_process` 给进程送输入并返回**这次输入之后**产生的输出（不传 `offset` 就不需要自己记游标）；它面向普通非 PTY 管道，完整终端会话请用 `open_shell`。`wait_process` 等退出或超时；`wait` 只按毫秒数等待（`wait: {ms}`），也可以带上 `command_id` 等这个进程。

### 桥自身状态一组

- `get_bridge_status`：本机 Bridge 健康与计数。
- `get_auth_status`：Bearer 门禁状态、默认有效期、每个令牌的 id/标签/到期/最后使用。**密钥只在创建那一刻显示一次、从不落库**，所以这里读不回来；签发与吊销在控制台「令牌」页完成——MCP 客户端**不能**给自己发凭据。
- `get_lock_status`：并发准入表——当前被谁持有（key、读写模式、调用名、已持续多久）以及哪些调用在排队。某次调用像是被卡住时看它。
- `list_sessions`：当前活着的 MCP 会话。
- `get_config` / `set_config_value`：读/改运行配置（改完是否需要重启看具体键）。
- `workspace_brief`：一次调用拿到项目全貌——工作区路径、顶层结构、清单文件（`package.json` 脚本等）、`AGENTS.md` / `CLAUDE.md` 是否存在、git 分支与脏文件数、近期活动。**刚接手不熟悉的项目时先调用它一次**，别盲目探索。

### 活动与统计

`get_recent_activity` 读最近活动；`search_activity_log` 按工具 / 状态 / 文本 / 时间检索 `audit.log` 与 `audit.log.1`，带分页（`limit` 1–500，默认 50）；`clear_activity_log` 清空内存缓冲、截断当前审计日志并删掉轮转文件——**不可逆**。`get_usage_stats` 读聚合调用统计。

### 待办与进度

`set_todos` 存**完整**任务列表（条目要有 `id` / `title` / 合法 `status`），多步工作的正式清单；`get_todos` 读它（含 `last_progress`）；`report_progress` 报**瞬时**进度——写入活动日志，并以 MCP `notifications/message` 推给客户端。`phase` 与 `category` 是**封闭词表**，取值不在表里会被丢掉落、结果里直接不出现；自由文本放进 `message`。

### 技能与元工具

`list_skills` 列出工作区可用的技能（含 `SKILL.md` 的目录）；服务端 instructions 里带的是**连接时**的快照，中途新增技能后用这个工具刷新，再 `read_files` 对应 `SKILL.md` 并照做。`workspace_brief` 见上。

### 文件系统基础操作

`list_directory`（`depth` 1–3、`include_hidden`、`max_entries`）、`find_files`（glob，`*` / `**` / `?` / `{a,b}` / `[abc]`，纯名字/前缀按 basename 匹配）、`create_directory`、`move_file`、`copy_file`（后两者 `source` / `destination` / `overwrite`）、`delete_file`（`recursive`）、`get_file_info`（元数据；≤128 MiB 的文件带 `sha256`，更大的返回 `null` 而不是把整个文件读进内存）。

### 编辑器工具（仅当宿主带语言服务器）

`get_diagnostics` 与 `lsp` 只在宿主能力里**有语言服务器**时才公布。独立版没有编辑器，所以 `tools/list` 里看不到这两个（源码里仍定义着，共 58 个 vs 本机公布 56 个）。

`lsp` 的 `operation`：`workspace_symbols`（需要 `query`）· `document_symbols` · `definition` · `references` · `implementation` · `hover`；后五个需要 `path` 加 **1 基**的 `line` / `column`，并与真实文档校验。返回文本信封加 `provider_state` 元数据：空的 `workspace_symbols` 会在**预热语言服务器之后重试**；`provider_state` 为 `"unknown"` 说明"没有"这件事**没有被证明**，此时要退回 `search_files`。`references` 可用 `include_declaration=false`（默认 `true`）去掉声明本身；`max_results` 限制块数（各操作有默认值，硬上限 500）。

`get_diagnostics` 按严重度、再按位置排序；`severity`（`error|warning|information|hint`）过滤；`total_matching` 给出截断前的总数。

---

## 描述瘦身（本轮改动）

- 描述是**每轮对话都常驻上下文**的：工具定义的 token 开销在整段会话里反复支付，而里面有一半是"为什么这样做"的解释、以及被写了两三遍的字段约定。
- 因此：每条描述压到 **≤200 字符**，只留"做什么 + 现场必须知道的规则"；被移走的解释、边界、路由建议全部进这份文件；重复的字段约定提到**服务端 instructions** 里的同一段（只发一次，而不是每个工具各说一遍）。
- 这一轮 21 条被改写，工具**名称、参数、行为与数量一个都没动**（`tools/list` 仍是 56 个）。测得的开销变化见仓库提交信息与 `docs/comparison-status-*.md`。
