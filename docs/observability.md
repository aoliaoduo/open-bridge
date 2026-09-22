# 观测与诊断手册

排查从哪个表面开始，取决于问题在哪一层。这四个表面各管一层，互不重复：

| 表面 | 管什么 | 需要实例在跑 | 能否公开 |
| --- | --- | --- | --- |
| `open-bridge doctor` | 环境：node 版本、数据目录可写性、ripgrep、时区、隧道配置 | 否 | 含本机路径，不建议直接贴 |
| `open-bridge health` | 一个活实例：监听、隧道、公网可达性、暴露级别、构建是否过期 | 是 | 含 URL，不建议直接贴 |
| `bridge_status{section}` | MCP 客户端能问到的实时视图：`overview` / `auth` / `locks` / `sessions` | 是 | `auth` 只给元数据，可贴 |
| `open-bridge diagnostics` | 数据目录工件的**白名单投影**：清单 + 行为骨架 + 阈值发现 | 否 | **就是为贴进 issue 而做的** |

## 1. 报 issue：生成脱敏诊断

```bash
open-bridge diagnostics              # 覆盖式写入 ~/.open-bridge/diagnostics.md
open-bridge diagnostics --out D:\ob.md
```

它**读数据目录，不问活实例**，所以实例卡死或起不来的时候照样能生成——而那正是最需要它的时候。输出是覆盖式的：诊断要的是最新一份，不是一个会越长越大的目录。

报表能公开，靠的是**构造**而不是擦洗：它只输出自己点名的字段，从不转贴 `audit.log` 或 `bridge.log` 的任何一行。这不是洁癖——`state.redactSensitiveText` 是黑名单式的（隧道 URL、路由令牌、`Authorization` 头、`?token=`、`*TOKEN=`），它对**工作区路径和命令文本无话可说**，而 `args_summary` 里恰好就是这些。

报表自己在结尾列出"不含什么"，这样读者能分清一条边界是刻意的还是漏掉的。

## 2. 读报表

- **Findings** 按严重度排序。`critical` 只有一种：`secrets.json` 存在却没有路由令牌。`investigate` 是需要人看一眼的证据。`info` 是口径说明，不是缺陷——例如"bearer 门禁关闭"是出厂默认，它**不构成暴露判断**，那要问 `bridge_status.exposure`。
- **Artifacts** 每行都带一句"它回答什么问题"，以及健康/不健康分别长什么样。**缺失的工件也是一行**（`present: no`），因为"这个文件不存在"本身就是诊断事实。
- **Behaviour skeleton** 是计数与分类：按工具、按状态、错误类、连续重复调用。**没有任何一条原文。**
- **错误类**先把易变部分归一化：引号内的内容 → `<q>`、长十六进制 → `<id>`、数字 → `N`。所以 `Failed in 1 ms` 与 `Failed in 1568 ms` 会归到同一类，而原因保留下来。
- **Transport** 从 `tool: "mcp"` 那些行投影出世代（legacy/modern）与 HTTP 状态分布。这些行是传输叙事，不计入工具调用数。

## 3. 数据目录工件速查表

按"出问题时最常见的排查路径"排序。数据目录默认 `~/.open-bridge`，由 `OPEN_BRIDGE_HOME` 或 `--home` 改变。

| 工件 | 看什么 | 健康 | 不健康 |
| --- | --- | --- | --- |
| `secrets.json` | 有几个 `openBridge.routeToken.*` 键 | ≥1，每个工作区一个 | **文件在但没有令牌键**：所有 MCP URL 已失效，且界面上看不出原因。文件压根不存在则是"这个数据目录还没跑过实例"，不是故障 |
| `runtime-<24hex>.json` | `pid` 是否活着 | pid 活着；`instances` 会列出它 | pid 已消失而记录还在：实例崩溃或被硬杀。注意 `instances` **只报活实例**，死记录只有本报表会说 |
| `serve-<suffix>.lock` | 有没有活实例与之配对 | 活实例持有，且**整个生命周期都持有** | 无活实例且超过 5 秒：一次启动卡死或崩溃，`serve` 会拒绝启动直到锁消失 |
| `audit.log` | 大小相对 `logMaxBytes`（默认 10 MB） | 未接近上限 | 接近即轮转；报表只读最新 8 MB，更早的按字节数报为 skipped |
| `audit.log.1` | 存在即正常轮转 | 一份 | 无（尚未轮转过） |
| `state.json` | 服务定义、todos、用量计数 | 可解析 | 内容为空或不可解析。它是可重建状态，不是身份 |
| 未识别的文件 | 名字、有无 | 没有 | 报表以 `(unrecognised: …)` 单独列一行。注意仓内**没有任何代码会产生 `.bak`**：两个写入器都走 `.<pid>.tmp` 再 rename，所以 `state.json.bak` 一旦出现就是外来物，报表不为它编成因 |
| `config.json` | 行为开关与超时 | 可解析 | 报表只带白名单子集；`notify.barkKey` 只报 `<set>`/`<unset>` |
| `bridge-peers.json` | 同机哪个实例持有共享隧道 | 多实例共用隧道时存在 | 单实例或无隧道时不存在属正常 |
| `logs/bridge.log` | 叙事日志，**含命令文本与路径** | 大小正常轮转 | 本报表不读它。要看用 `open-bridge logs`，但别直接贴进 issue |
| `service-logs/` | 受监管服务的持久日志，跨重启追加 | 与已保存的服务数量相称 | 本报表只数文件个数 |
| `diagnostics.md` | 本命令的默认输出位置 | 每次覆盖 | 会随 `--out` 落到别处 |

## 4. 发现项对照

| 发现 | 级别 | 何时触发 | 下一步 |
| --- | --- | --- | --- |
| `secrets.json holds no route token` | critical | 文件存在但没有令牌键 | 在受影响的工作区启动一次实例会铸新令牌，**URL 随之改变**，所有客户端要换 |
| `no secrets.json in this data dir` | info | 文件不存在 | 正常。若确实跑过实例，说明 `--home`/`OPEN_BRIDGE_HOME` 指错了地方 |
| `N stale instance record(s)` | investigate | 记录里的 pid 已消失且记录超过 5 秒 | 删掉该 `runtime-*.json` |
| `stale serve lock` | investigate | 锁无活实例持有且超过 5 秒 | 删掉该 `serve-*.lock` 后才能再 `serve` |
| `数据目录里有本报表不认识的文件` | info | 有未识别文件即列名 | 报表只报名字不读内容。先确认是不是 `--home`/`OPEN_BRIDGE_HOME` 指错了目录 |
| `N unparsable audit line(s)` | investigate | JSONL 行解析失败 | 写入撕裂或并发追加交错。**只计数，不引用原文** |
| `N of M tool calls errored` | investigate | 样本 ≥20 次调用且错误率 ≥10% | 看错误类分布。小分母不报，避免噪声 |
| `<tool> called N times in a row` | investigate | 同一工具连续 ≥5 次**调用** | 这是 agent 空转的形状。按调用计而非按审计行计，每工具只报最长的一段 |
| `the timezone is a derived fixed offset` | info | 解析出的时区形如 `Etc/*` | 报表与日志的时间戳是 UTC 的固定偏移、不含夏令时。根因看 `open-bridge doctor` |
| `the bearer gate is off` | info | `auth.enabled` 为 false | 出厂默认。真实暴露级别问 `bridge_status.exposure` |

## 5. 维护规范

新增一个数据目录工件时，同步三处：

1. 本文 §3 加一行（看什么 · 健康 · 不健康）
2. `src/cli/diagnostics.ts` 的 `buildArtifacts` 加一行清单，并写清它回答什么问题
3. 只有阈值真的说明问题时才在 `buildFindings` 加规则——**阈值靠拍脑袋会错，先观察再补**

改这个模块时不要松动的几条，每条都对应一个真实发生过的缺陷：

- **不做黑名单擦洗**。报表只输出自己点名的字段；转贴原文再加一层"擦一遍"不算安全。
- **缺失必须是 `present: false` 的一行**，不是消失的一行。
- **"缺失"与"空"是两件事**。`secrets.json` 不存在是没用过，存在而无令牌才是紧急；把前者报成后者会在每台新机器上喊狼来了。
- **先归一化易变部分，再分类**。按第一个冒号切会被桥自己的 `Failed in <N> ms:` 信封骗过去，把同一个原因按耗时碎成十几个类。
- **计数单位是调用，不是审计行**。一次调用写 `running` 与终态两行，按行计会翻倍。
- **只报不修**。本模块不删锁、不轮转日志、不重启任何东西。
- **不要从已过滤的来源推导字段**。`readAllRuntimes()` 只返回活实例，用它算 `stale` 恒等于 0——那会变成一个永远不说话的字段。

## 6. 明确不做

- 不自动修复、不续跑、不改配置。观察者只观察。
- 不做实时流式诊断。要实时视图用 `bridge_status` 与控制台。
- 不在报表里放正文、命令、路径或任何凭据，**即使已脱敏**——脱敏规则会变，投影的字段清单不会。
- 不引入数据库或在线上报。这份文件的全部价值在于它能被复制粘贴。
