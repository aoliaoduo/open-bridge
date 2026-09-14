# open-bridge-app 对三个参照项目：取了多少、是否更强

判定日期：2026-09-12 ｜ 对象：`DesktopCommanderMCP`、`devspace`、`taskquay`（本地克隆目录）
沿用仓库内既有的对照基线：`open-bridge-app/docs/refactor-comparison.md`（512 行，含 D1–D9 / T1–T7 / M1–M3 清单）

> **这是一份带日期的实测快照。** 里面的版本号、工具数、断言数是判定当时的读数，之后会随提交变化（同一文件里出现的 54 / 55 两种工具计数，就是这种变化的痕迹）。要引用「现在」的数字，请看 `package.json`、`README.md`，或直接问一台运行中的实例：`get_bridge_status`。

---

## 直接回答

**1）“取其精华”做了吗？——基线里判定“值得取”的项，已完成约 3/4，而且主线上全取到了。**
最值钱的三样（OAuth 2.1、双协议 `/mcp`、不剥夺能力的“标注式告知”）**都在代码里、都有测试保护**。
没取的 6 项，全部是当时判定“没有真实消费者证据”的等待项，不是漏掉；另有 1 项（结构化错误）是**主动降级**。

**2）比他们三个优秀吗？——分维度：作为「本机能力的 MCP 桥接 + 运维面」我们明确更强；
作为「AI 编码 Agent 编排平台」他们更强，而我们不做那件事。**
不存在一个全面的“更好”：协议、鉴权、运维面、依赖卫生、测试诚实度是我们赢；
Agent 委派、worktree、artifact、skills、生态分发、文件预览 UI 是他们赢（其中一半是我们的**有意非目标**）。

---

## 一、怎么判定的（可复现）

| 判据 | 方法 |
| --- | --- |
| 基线 | 仓库里已有的 `docs/refactor-comparison.md`（此前对三家做过逐项审计） |
| 落地核验 | 对每一条“精华”在 `src/`、`test/` 里查实现与测试；未取项用 `grep -ril` 确认**零命中**（只在文档里出现） |
| 能力面对比 | 抽取四方的工具清单（我们 56 定义 / 54 对外；DC-MCP 24 个；devspace/taskquay 的 grep 口径含代理类型标记，故只作定性比较） |
| 规模与卫生 | 源码 LOC、运行时依赖数、测试文件数/断言数（实测，见下表） |

---

## 二、度量对比（实测）

| | **open-bridge-app** | DesktopCommanderMCP | devspace | taskquay |
| --- | --- | --- | --- | --- |
| 定位 | 本机能力的 MCP 桥接（CLI + 控制台 + HTTP API） | 终端/文件 编辑类 MCP server + 闭源 App | 把 Codex 式流程带给 ChatGPT 的自托管 MCP | devspace 二开：可委派的执行/项目管理层 |
| 版本/HEAD | `1.0.0-alpha.3` · 本机 | 0.2.48 · 56deabc | 1.0.8 · 33d6d0b | 1.0.8 · 4ba4283 |
| 源码 | `src/` 15,549 行 | 313 文件（115 ts + 92 js） | 126 ts | 202 ts |
| 运行时依赖 | **3 个（全是 MCP 官方包）** | **28 个** | monorepo，较重 | monorepo，较重 |
| 自动化测试 | **438 条断言**（310 单测 / 92 集成 / 36 UI），无 stub，端到端真起进程 | `.test.*` 文件 **1 个** | `.test.*` 53 个 | `.test.*` 88 个 |
| 分发 | 私有仓库；本机 `npm link` | npm 公开 + 目录收录（Smithery/Glama）+ Discord | npm `@waishnav/devspace` | 源码优先（未发 npm） |
| 对外工具 | 55（+2 编辑器专用；`list_skills` 于本日随 D9 落地） | 24（另 2 条为内部别名） | 约 10 个工具 + 代理类型标记（grep 口径） | 约 15 个工具 + 代理类型标记（grep 口径） |

---

## 三、已经“取”到的（逐条有代码与测试证据）

| 来源 | 精华 | 我们的落点 |
| --- | --- | --- |
| devspace D1 | **OAuth 2.1 + DCR + PKCE + `resource` 校验** | `src/bridge/oauth.ts`；`test/oauth-integration.test.mjs`（16 项）+ `test/oauth-protocol.test.ts`；控制台授权页 + README |
| devspace D2 | **双协议 `/mcp`（2026-07-28 与旧版同端点）** | `classifyInboundRequest` 分流；`test/mcp-modern-protocol-integration.test.mjs`（9 项） |
| devspace D3–D5 | 无 cookie 的同意页往返、重定向白名单、`refresh` 一次性轮换 | 同上 OAuth 实现与其测试 |
| devspace D6 | 按请求可观测性（白名单字段 + 哈希身份 + 截断） | `src/bridge/request-trace.ts` + `test/request-trace.test.ts`（工具名不进日志） |
| devspace D7 | 优雅停机的阶段化与排空 | 停机阶段记录 + `src/bridge/shutdown-deadline.ts`（10 s 硬期限，`test/shutdown-deadline.test.ts`） |
| taskquay T2 | **关闭式进度词表**（词表外的值丢弃而非归默认） | `src/bridge/progress-vocabulary.ts` + `test/progress-vocabulary.test.ts` |
| taskquay T5 | **活跃 claim 不被窃取** | `LockRelease.handOff()` + `test/resource-locks.test.ts`（两条回归） |
| taskquay T6 | 能力派生只读，不从 prompt 推断 | 体现在工具标注与策略实现 |
| DC-MCP M1 | 模糊匹配失败给出“最近似区域 + 漂移原因” | `src/bridge/fuzzy-match.ts`（**交叉验证：本来就有**） |
| 三方共性 | **`destructiveHint`/`readOnlyHint` 式告知（不阻断）** | `src/bridge/tool-annotations.ts`，58 个定义齐备；测试断言非只读工具仍可无确认执行 |
| devspace D9（同日补上） | **skills 发现** | `src/bridge/skills.ts` + `list_skills` 工具 + 说明注入；`test/skills.test.ts` 13 条 + `test/skills-integration.test.mjs` 5 条；真机实测：本机 `~/.agents/skills` 的 11 个技能已出现在连接说明里 |

> 另有一处**我们比三家都强的地方**：**鉴权路径 O(1)**（digest 索引 + 解析缓存）与 **锁不被偷**（P0）都是我们发现的缺陷并修掉的，
> 三家对照文档只提供了“这样做是对的”的旁证。

---

## 四、还没“取”的（及原因分类）

| 项 | 来源 | 状态 | 原因 / 我的判断 |
| --- | --- | --- | --- |
| **skills 发现（`AGENTS.md`/`CLAUDE.md` + skills 目录）** | devspace D9 | ✅ **已于本日落地**（见上表末行） | 项目约定注入（两份、各 8000 字符上限）早已在；本轮补齐 skills 索引 + `list_skills` |
| 有界长轮询 + 双重 revision（断线可重取） | taskquay T3 | ❌ 未做 | 值得做：网页 AI 断线最常见，省 token；建议先用一次真实案例量测 |
| 幂等键（`requestKey`/`taskKey`） | taskquay T4 | ❌ 未做 | 中等价值：客户端重试会重复写盘时才必要 |
| 用量四态 + “缺失边界不记为 0” | taskquay T7 | ❌ 未做 | 低-中：诚实性设计，我们的 `get_usage_stats` 仍是两态计数 |
| `canonicalExecutionRoot` 式路径归一 | devspace D8 | ❌ 未做 | 低：现有 `workspace-path.ts` 已防逃逸，归一只是让锁/幂等键更准 |
| 结构化错误 `{code, blocking, nextAction}` | taskquay T1 | ⏸ **主动降级** | 维持：我们的错误句已含“下一步做什么”，在出现真实误重试前不加 |
| 二进制/图片类型嗅探 | DC-MCP M3 | ❌ 未做 | 按需：不在确有需求前拖依赖 |
| 后台搜索会话（`start_search`/`stop_search`/`list_searches`/`get_more_search_results`） | DC-MCP | ❌ 未取 | 我们有 `search_files`（ripgrep）同步完成；他们需要 4 个工具是因为要支持超长搜索 |
| `write_pdf` | DC-MCP | ❌ 未取 | 有意：正是“堆依赖把桥接器拖成文档平台”的典型 |
| 远程设备（`src/remote-device`） | DC-MCP | ❌ 未取 | 换赛道：那是另一个产品形态 |
| Agent 委派 / 子代理 / 资源声明 / 并发档位 | devspace + taskquay | ❌ 非目标 | 他们需要沙箱，正因为把不信任的下属 Agent 当子进程跑；我们不委派 |

---

## 五、谁更强（诚实分维度）

| 维度 | 我们 | 他们 | 判定 |
| --- | --- | --- | --- |
| MCP 协议覆盖（2026-07-28 + 旧协议同端点） | ✅ | devspace/taskquay ✅；**DC-MCP ❌** | 平（对 DC-MCP 领先） |
| 公网接入凭据（OAuth 2.1 全链路 + 令牌/轮换） | ✅ | devspace/taskquay ✅；**DC-MCP 无鉴权层** | 平（对 DC-MCP 领先） |
| 独立运维面（11 条 CLI 命令、9 条控制台真实路径、HTTP API、doctor/health） | ✅ 独有 | 三家都没有独立控制台 | **我们领先** |
| 多实例 + 共享隧道（一目录一实例、借用/接管/自愈） | ✅ 独有 | 无对应 | **我们领先** |
| 能力保留（不沙箱、不白名单、全工具） | ✅ 有意为强 | 三家都以 `allowedRoots`/sandbox 换安全 | **我们领先（按你的红线）** |
| 依赖卫生 | 3 个运行时依赖 | 28 / monorepo / monorepo | **我们领先** |
| 测试诚实度（相对功能面） | 438 条，真进程/真 HTTP/真 MCP/真 OAuth | DC-MCP 1 个测试文件；devspace 53、taskquay 88 | **我们领先（尤其对 DC-MCP）** |
| Agent 委派与编排（Codex/ACP/子代理/任务收据/并发档位） | ❌ 非目标 | ✅✅ | **他们领先（我们不做）** |
| git worktree / artifact / skills | ❌（skills 真缺） | ✅ | **他们领先（可补其一）** |
| 生态与分发（npm、目录收录、社区） | ❌ 私有、未发布 | DC-MCP 生态最大；devspace 有 npm；taskquay 源码优先 | **他们领先（你要求私有，则此条放弃）** |
| 前端细节（文件预览、Markdown 编辑器、实时 diff） | 控制台 9 页签可运维，但不做编辑体验 | DC-MCP 的闭源 App ✅ | 他们领先（非目标） |

---

## 六、结论与建议

1. **“取其精华”的判据应当只看两样：协议/鉴权主线 + 不削能力的做法。这两样已完成并有测试保护。**
   剩下未取的项，全是“等真实需求”的，而不是遗漏。
2. **“去其糟粕”同样做到了**：28 依赖的文档平台化、沙箱式能力削减、无鉴权的裸奔、以及“宣传与实证的落差”，我们一条没抄。
3. **是否“更优秀”**：在同类角色（把本机能力安全地交给外部 AI，并让人能运维）上，我们在协议、鉴权、运维面、
   依赖与测试上领先；在「Agent 编排平台」这个不同赛道上，他们更强而我们无意竞争。
4. **唯一被点名的“真缺”已补上**：**skills 发现（D9）**于本日落地（`src/bridge/skills.ts` + `list_skills`，零依赖、只读、索引优先），
   实测本机 `~/.agents/skills` 的 11 个技能已进入连接说明。剩下的次选是把 taskquay 的**有界长轮询/断线重取（T3）**
   做成一次性实验，用真实断线案例决定是否值得。
