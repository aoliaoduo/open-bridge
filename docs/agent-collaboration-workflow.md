# Agent 协作流程与 MCP 配置（可复制提示词）

> 用途：把本文件交给新的 Agent，或在长会话压缩、换模型、换窗口后恢复同一套协作节奏。它记录的是本项目当前已实际使用的流程和连接配置。
>
> 更新：2026-09-20（Asia/Shanghai）｜项目：Open Bridge
>
> 当前状态：P5“输出/恢复契约整治”已完成并在两次重启后的真实 MCP 中闭环验证：`bridge_status` 为 `running` 且 `build_stale:false`；文本、Base64 续读、`search_files.partial` 和最终工具简介均按契约返回。
>
> 最近真实验证：P8 已在重启后通过。`read_files` 同批请求一个可读文件和一个缺失文件时，返回两个同序结果；Bridge 的 `build_stale` 为 `false`。

## 1. 当前连接与运行配置

### 1.1 Open Bridge MCP

| 项目 | 当前值 |
| --- | --- |
| 传输 | Streamable HTTP MCP（HTTP `POST`；响应可能为 JSON 或 SSE） |
| MCP 地址 | `https://bridge.example.invalid/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |
| Bridge 工作区根目录 | `C:\Users\aolia\Desktop\open-bridge` |
| Shell | `C:\Program Files\Git\bin\bash.exe` |
| 协作语言 | 中文为主；代码、命令、字段名保持原文 |
| 健康标准 | `bridge_status` 返回 `state: "running"` 且 `build_stale: false` |

该 URL 含路由令牌，是当前实例的连接凭据。仅在需要访问该实例的人、私密提示词或受控配置中使用；不要粘贴到公开 issue、截图或公开仓库。

不同 MCP 客户端的字段名会略有不同；最小配置如下：

```json
{
  "mcpServers": {
    "open-bridge": {
      "transport": "streamable-http",
      "url": "https://bridge.example.invalid/mcp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "headers": {
        "ngrok-skip-browser-warning": "1"
      }
    }
  }
}
```

若需要手工调试 HTTP（普通 MCP 客户端不需要手写这些）：

```text
Content-Type: application/json
Accept: application/json, text/event-stream
ngrok-skip-browser-warning: 1
User-Agent: Arena-Agent-MCP-Client/1.0   # 可选
```

MCP 客户端应先调用 `initialize`，读取服务端的 `Mcp-Session-Id`，发送 `notifications/initialized`，再调用 `tools/call`。不要猜测、复用或手工写入旧 session id。当前已验证的兼容初始化版本为 `2025-03-26`；新版客户端优先让 SDK 自行协商。

### 1.2 无 MCP SDK 时的已验证调试调用器

Arena 工作区中的 `/home/user/mcp_rpc.py` 每次调用会新建 MCP session：

```bash
python3 /home/user/mcp_rpc.py bridge_status '{}'
python3 /home/user/mcp_rpc.py read_files \
  '{"paths":["package.json","definitely-missing-open-bridge-file.txt"],"max_bytes":64}'
```

它已配置 URL、必要头部和一次仅针对临时网络错误的重试。它是私有调试工具，不是项目产品代码，也不应替代 MCP 客户端的原生连接。

### 1.3 工具与执行约定

| 目的 | 首选工具/方式 |
| --- | --- |
| 确认重启后的版本 | `bridge_status`，检查 `state` 与 `build_stale` |
| 读/查文件 | `read_files`、`list_directory`、`find_files`、`search_files` |
| 真实仓库审计、编辑、测试、提交 | `run_command` |
| 长时间命令 | `run_command` 使用 `background:true`；取得 `command_id` 后用 `wait` 或 `read_process_output` |
| 构建互斥 | 构建使用 `resource_keys:["build:dist"]` |
| 后台状态 | `get_process_snapshot`、`wait`、`read_process_output` |

本 Arena 环境的本地 `/home/user` 并不等同于 Windows 上的真实仓库。因此真实仓库的审计、改动、测试、Git 状态和提交，都以 MCP `run_command` 所访问的工作区为准。

构建后，正在运行的 Bridge 不会自动加载新 `dist/`。需要操作者重启；`bridge_status.build_stale: true` 表示服务仍是旧构建。

### 1.4 可选：DeepSeek OpenAI 兼容配置

需要通过 DeepSeek 调用模型时，已确认的兼容配置：

```text
环境变量：DEEPSEEK_API_KEY=<仅放在受控环境变量中，不写入提示词或仓库>
Base URL： https://api.deepseek.com
Endpoint： POST /chat/completions
示例模型： deepseek-flash
```

没有记录或需要暴露 API Key；由运行环境提供。MCP URL 和 API Key 都不要写进公开提交。

---

## 2. 可复制的初始提示词

在新 Agent 的第一条任务消息中粘贴下面整段。将尖括号内容改成当次真实状态。

```text
你正在协作维护 Open Bridge。请以中文交流，代码、命令和字段名保持原样。

连接与真实仓库：
- MCP（Streamable HTTP）URL：<填入本文件 1.1 的 URL>
- MCP 调用需要 ngrok-skip-browser-warning: 1；让 MCP SDK 负责 initialize、session 与 SSE。
- 实际仓库在 Bridge 主机的 C:\Users\aolia\Desktop\open-bridge。
- 当前 Arena 本地工作区不一定是该仓库；审计、编辑、测试、git 状态和提交必须以 MCP run_command 访问的真实仓库为准。
- 长命令以 background:true 启动，使用 command_id + wait/read_process_output 续读；构建加 resource_keys:["build:dist"]。绝不因为等待超时重发同一个有副作用命令。

协作原则：
1. 先确认事实，再改代码；改动保持最小、直接。避免过度设计和过度防御性编程，不能为了安全牺牲既有的便利、性能或权限。
2. 每个工作组开始前只问一次选择题，最多 2–4 项。每项必须说明：是否推荐、理由、范围/行为影响、验证与是否需要重启。用户选择后，直接连续完成审计、实现、测试、构建、完整发布验证、审阅和提交；不要再展示第二份实施计划或等待第二次确认。
3. 每个工作组结束前执行与改动相称的定向测试和完整 npm run release:check。若完整检查失败，先找根因；修复本工作组造成的回归后重新运行。
4. 对影响运行中 Bridge 的改动：提交后明确请用户重启。用户回复“已重启”后，先调用 bridge_status 确认 state:"running" 且 build_stale:false，再用真实 MCP 调用验证核心行为。
5. 重启后的真实验证通过后，自动进入下一个工作组的“单次选项”环节；不要只停在完成汇报。
6. 面向非技术用户汇报：先说明行为变化和用户需要做什么，再列出简洁的验证结论、提交号和必要风险。默认不要粘贴 MCP/JSON 序列化后的原始 \n、\r 日志；只有用户明确索要时才提供原始日志。
7. 保持现有工具名称、权限模型、公开契约和测试覆盖，除非本工作组明确要求改变。不要恢复已删除的 tool-run-hints 行为教练层。
8. 不要声称没有实际做过的验证；明确区分“源码/测试通过”和“重启后的真实 Bridge 已验证”。

当前任务/上下文：
- 当前工作组或问题：<填写>
- 验收条件：<填写>
- 当前提交、工作树和已完成验证：<填写>
- 用户明确约束或历史纠正：<填写>

现在先用真实仓库做最小审计；如果这是新工作组，先给出上面第 2 条要求的一次性选项。用户一旦选择，直接执行，不再要求确认。
```

---

## 3. 后续提示词库

初始提示词的规则持续生效；后续不需要重复整份规则。

### 3.1 开始或恢复工作

```text
继续当前协作。先读取并遵守 docs/agent-collaboration-workflow.md；以 MCP 中的真实仓库为准。当前目标是：<目标>。请先给出本工作组的一次性选项。
```

已有明确选择时：

```text
我选择 <A/B/C>。按既定流程直接完成审计、实现、测试、完整发布验证、审阅和提交；不要再给我实施计划或要求第二次确认。
```

### 3.2 用户完成重启后

```text
已重启。请先用 bridge_status 确认新构建已加载，再用真实 MCP 调用验证刚完成的核心场景；验证通过后自动给出下一工作组的一次性选项。
```

### 3.3 指定一个明确问题

```text
下一个工作组处理这个问题：<现象、预期、复现命令或文件路径>。
保持改动最小；先只问一次可选方案。选定后直接做到可提交状态，并按既定重启验证流程完成闭环。
```

### 3.4 缩小范围或纠正方向

```text
停止扩展范围。只保留 <必须保留的行为/文件>，不要做 <不需要的设计>。
从当前工作树重新审计影响，修正实现和测试，然后继续同一工作组的完整验证与提交。
```

### 3.5 要求整理后的证据

```text
请给我整理后的验证结论：改了什么、哪些检查通过、提交号、是否需重启、真实 MCP 验证是否完成。不要贴转义后的原始 MCP/JSON 日志，除非我再要求。
```

### 3.6 交接给新 Agent / 新会话

```text
请生成一份简洁交接摘要，包含：当前工作组与验收条件、用户约束、已改文件、已运行的验证及结果、提交号、工作树状态、是否需要重启、重启后应调用的真实 MCP 验证、以及下一步应提供的工作组选项。不要省略未完成项。
```

### 3.7 仅查看或仅分析

```text
这是只读审计：不要修改文件、不要提交。基于 MCP 中真实仓库检查 <范围>，用结论、风险和可选后续工作组汇报；不要输出大段原始日志。
```

---

## 4. Agent 的标准工作闭环

1. **选择**：只在工作组开始时提出一次带推荐的选项；不要连环确认。
2. **审计**：查看实现、公开 schema/说明、已有测试和真实现象；可以安全复现时先复现。
3. **实现**：做最小改动，保持并发、权限、顺序、错误提示和既有契约。
4. **定向验证**：运行受影响单元、集成或 live MCP 测试；必要时补回归。
5. **完整验证**：运行 `npm run release:check`；长任务后台执行后 `wait`，不要重跑。
6. **审阅**：检查 `git diff --check`、差异范围、正反向路径和 `git status`。
7. **提交**：只提交本工作组文件，使用简短、行为导向的提交信息；确认工作树干净。
8. **重启与真实验证**：涉及 build 的改动必须等待用户重启；之后检查 `bridge_status` 和真实 MCP 行为。
9. **推进**：真实验证成功后自动提出下一工作组选择。

### P5 已提交、等待重启验证示例

问题一：`search_files` 的 ripgrep 路径发生单文件错误时，内部虽已知道结果 `partial`，但公开响应和 schema 只返回了 `truncated`；AI 会把“有真实命中但搜索范围不完整”误判为完整结果。

问题二：`read_files` 虽能标记 `truncated`，但二进制/Base64 内容没有可继续读取的字节游标，文本分页也没有安全的下一行游标；schema 也没有完整描述成功行、错误行和恢复字段。

结果：提交 `8fb1aa8 fix explicit output recovery contracts` 后，`search_files` 始终返回 `partial:boolean`，并与分页 `truncated` 分离。`read_files` 的文本成功行会返回 `encoding:"utf8"`、行元数据及可用时的 `next_start_line`；Base64 成功行返回 `offset`/`next_offset`，可逐页恢复。单路径失败继续作为 `{path,error}` 行保留。重启后的真实 MCP 已验证：二进制页以 0、4、8 三个偏移完整恢复，文本页从 `next_start_line:3` 继续，普通空搜索明确返回 `partial:false`。随后仅修正了“空游标”说明的措辞，完整 `npm run release:check` 已再次通过；第二次重启后的 `tools/list` 已确认最终简介及 Base64 `offset` 输入、两种 `read_files` 行结构均已加载。

### P8 已完成示例

问题：`read_files` 使用 `Promise.all`，一条缺失文件会让同批可读文件丢失并产生工具级 `isError:true`。

结果：提交 `d1753b5 Keep readable files when batch reads fail` 后，每个有效非空路径独立返回成功行或 `{path,error}` 行；输入结构错误仍是工具级错误。重启后的真实调用中，`package.json` 正常返回内容，缺失文件返回包含 “path does not exist” 的错误行，调用整体不是错误。

---

## 5. 日常注意点

- 用 `bridge_status` 做服务事实来源；构建命令结束不代表新代码已在线。
- `read_files` 的批量结果与请求路径同序。成功行包含 `encoding`、`truncated` 和字节计数；文本页在可安全续行时给出 `next_start_line`，Base64 页给出 `offset`/`next_offset`。Base64 或文本被字节上限截断却没有安全游标时，以更大的 `max_bytes` 重试；而有意从后续 `start_line` 读取的文本页可在到达 EOF 时保持 `truncated:true`、游标为 `null`，应结合 `start_line`、`end_line` 与 `lines_total` 判定。单条路径的解析、状态或读取失败落在对应 `{path,error}` 行。缺少 `paths`、非字符串和空字符串仍应是调用参数错误。
- 对文件、进程和网络工具，先读 schema/说明再猜字段。公开 schema、工具说明和 live structured-content 是同一契约的不同层面。
- 不把测试失败简单“重试到绿”。先找根因；若工作组改变了预期契约，同步更新准确反映新契约的测试。
- 构建/测试产生的缓存和构建目录不应误提交；以 `git status --short` 为最终判断。
- 外部 ngrok 连接偶发中断时，可短暂等待并只对传输错误重试一次；不要因此复制启动第二个有副作用的构建。
