# AGENTS.md — 在这个仓库里干活的约定

面向**改这个仓库的人和 agent**。用户视角的说明在 `README.md`，每个工具的完整行为在 `docs/tools.md`，架构、分层与依赖在 README 的「开发」一节 —— 那些这里不重复。这里只记**踩过才知道**的部分。

**这份文件有两个读者**：改仓库的人，以及每一个连上这个实例的模型 —— `src/bridge/mcp-endpoint.ts` 在建立会话时读工作区根目录的 `AGENTS.md` 与 `CLAUDE.md`，各切 8000 字符（超出会留 `…[truncated]`）注入 server instructions。所以**写错这里的代价是被反复消费**：宁可少写一条，也不要把 README 的内容抄一份进来。`CLAUDE.md` 在本仓库只是一行指针，正文永远只在这里改。

## 改完源码之后

- `npm run verify` = typecheck + lint + build + 全部测试。**提交前必须全绿。**
- **集成测试跑的是 `bin/open-bridge.js` → `dist/`，不是 `src/`。** 改完源码不先 `npm run build`，端到端测试会继续报旧行为，看起来就像「守卫没生效」。这个坑已经踩过两次。
- 三层测试：单元 `test/*.test.ts`（tsx）、集成 `test/*.test.mjs`（`node --test`）、UI（vitest，**测试文件跟组件一起放在 `ui/src/**` 里**，不在 `test/` —— `vitest.config.ts` 的 include 只认那个位置，放进 `test/` 就是静默不跑）。集成那份是 **glob 自动收录**的，新增文件不需要在任何地方登记。
- **`noUncheckedIndexedAccess` 已开启**（core 与 ui 两份 tsconfig 都开）。所以 `arr[i]`、`match[1]`、`map.get` 之外的索引访问一律是 `T | undefined`，必须显式处理。三种处理方式，按场景选：
  - 能把索引访问**消掉**就消掉（把 push 的值存成局部变量、`for (const x of …)`、`arr[0]?.field ?? fallback`）。
  - **兜底值语义无害**时用 `?? 兜底`（字符串取 `?? ""`、`split()[0] ?? ""`）。
  - **兜底会把错误悄悄算错**时用 `!`，并在旁边注明它凭什么成立（数值 DP 表、补丁偏移量、SSRF 分类器里的字节）。判据：如果这个值真的 undefined，你希望**炸掉**还是希望**得到一个看起来合理的错答案**？后者就绝不能用 `??`。
  - 安全边界上一律**失败即拒绝**：`classifyIpv4` 读不出八位组时返回 `"reserved"` 而不是往下走到 `"public"`。
- 集成文件之间是**并行**跑的，每个文件各启一个实例。因此：**不要用固定 `delay()` 当作「子进程已就绪」的代理**，用 `start_process` 的 `ready_pattern`，并让就绪信号由被测进程自己发出（先挂监听器、再打印标记）。固定睡眠在并行负载下会偶发失败，而且单独跑那个文件时永远复现不出来 —— 最难查的一类 flake。
- **清理失败不是测试结果。** teardown 里删临时目录要走 `test/tmpdir.mjs` 的 `removeTempDir()`，不要裸调 `rmSync`。Windows 上 SIGTERM 返回不等于子进程放开了句柄，`rmSync` 会抛 EPERM，而它发生在 `after` 钩子里 —— 一个全部通过的套件被报成失败。CI 上真的这样红过一次（纯文档提交，前后两个提交都是绿的）。**随机变红的 CI 会毁掉 CI 唯一的用处**：看惯了无缘无故的失败，真正的失败就没人看了。

## 写测试时，先证明它会失败

`npm run verify` 全绿**不等于**改对了。这条是这个项目连着栽了三次才写下来的：

- **挪动状态页的卡片**：`tsc` 通过、15 个测试全绿，但页面渲染成了更糟的样子 —— 那 15 条全是行为断言（表格在吗、名字对吗、按钮跳转吗），**没有一条看结构**，所以布局怎么坏都不会红。
- **`logs --follow` 的孤儿进程**：测试写了两版，**两版都对着没修的代码通过**。第一版用 `child.stdout.destroy()` 模拟管道关闭 —— 那关的是测试进程里的读端，被测进程根本不知情；第二版改用真实 `| head`，但临时 home 里没有日志文件，被测命令打印「还没有日志」就返回了，**从没进过出问题的那段代码**。

所以：**新测试在保留之前，先把它跑给「未修复的代码」看一次，确认它红。** 红不了的测试不是测试，是一句自我安慰 —— 而且它比没有测试更坏，因为它让下一个人以为这里有人守着。改 bug 时顺序是「先写出能复现的测试（红）→ 再修 → 看它转绿」；实在难复现的，就在注释里**写明这是推理而非复现**（`inspect-commands.ts` 里那个 stream error 守卫就是这么标的），不要让读者误以为背后有案可查。

## 参数守卫的约定

MCP 参数是模型生成的：字段可能整个缺失，也可能是 `"abc"`、`null`、`{}`、`-1`。规则是**只拒绝「没有」和「无法兑现」，绝不收紧原本能用的东西**：

- 缺失 → 报错并**点名参数**：`Missing "path"`、`Missing "command_id": pass the id returned by run_command or start_process.`（后者还要带上可用 id 的 hint —— 那条 hint 正是客户端找回 id 的手段）。
- 存在但非法 → 交给该参数自己的校验函数出文案（`normalizePort`、`parseHttpProbeUrl`、`clampMs`…），不要在入口处把它的诊断吃掉。
- 文案带上期望类型：`depth must be a number: 1, 2 or 3. (expected 'depth': number)`。
- **显式空值通常仍然合法**：`input: ""` 就是一个裸换行，`message: ""` 仍能承载 phase/category，`get_process_snapshot` 省略 `command_id` 等于「全部」，`depth: 0` 钳到 1。拒绝这些是拿一个真实 bug 换掉一项能力。
- **不要用 `Math.max(0, Number(x))` 给数字参数兜底**：`Math.max(0, NaN)` 是 NaN，它并不钳位。NaN 落到 `setTimeout` 上约 0 ms 触发（一次崩溃变成崩溃循环），落到 `<` 比较上恒为 false（功能静默失效）。要么 `Number.isFinite` 检查后回落默认值，要么直接拒绝。同一条规则如果有两个入口，**共用一个校验函数**，否则它们一定会漂移。
- 新守卫要有测试。纯函数校验器放 `test/*.test.ts`（`clamp-ms.test.ts`、`restart-knobs.test.ts` 是样板），端到端行为放集成测试。

## 不要删掉「类型说它不可能」的守卫

`tsc` 在下面几处对运行时撒谎，`@typescript-eslint/no-unnecessary-condition` 会把真守卫报成死代码。**删掉它们会真的引入 bug**：

- `JSON.stringify(undefined)` 返回 `undefined`，不是 `string`（replacer 对函数返回 `undefined` 时同理）。
- 正则的可选捕获组没参与匹配时 `match[1]` 是 `undefined`，而 `RegExpMatchArray` 的索引签名说是 `string`。
- `arr.sort(...)[0]` 在过滤结果为空时是 `undefined`，`arr[i + 1]` 越界同理。**`noUncheckedIndexedAccess` 现已开启**，这类访问会被编译器拦下来；上面这几处守卫是开启之前就写对的，别当死代码删掉。
- 从磁盘 / 网络 / 模型参数读来的值，即使类型写得很好，也仍然要按不可信数据处理。
- **只在闭包里被赋值的 `let` 标志**：TS 的控制流分析不追踪嵌套函数中的赋值，会把它收窄成初始化时的字面量。如果这个标志决定了一条真实分支，就让结果**从 promise 里返回**，而不是被闭包捕获（见 `process-tools.ts` 的 `timedOut`）。否则那条分支会被类型系统判成死代码，早晚被人「顺手清理」掉。

## Host 接口

`src/host/host.ts` 的 `Host` 是唯一的宿主抽象，`src/host/node-host.ts` 是文件版实现。任何宿主只需实现一次 `Host`。

**约束的准确内容是「核心只依赖 `Host` 这个接口，不引用任何具体宿主实现」** —— 即 `node-host.ts` 只允许被 `src/cli.ts`（安装宿主）和 `src/server/api-router.ts` import 到。复核命令要用 import 形态的正则：`grep -rnE 'from "[^"]*node-host\.js"' src/` **恰好 2 条命中**即为干净。别图省事写成搜 `node-host` 或 `"node-host` —— 前者会被 `node-host.ts` 自己注释里的 `dist/host/node-host.js` 多算一条，后者一条都不命中（真实 import 是 `from "./host/node-host.js"`，紧邻引号的是个点）。**一条报不出确切命中数的检查命令，等于没有检查。** 它**不是**「核心不许碰 Node 内置模块」：`src/bridge|http|mcp|network|process|shell|workspace` 里本来就有一批直接用 `node:fs`、`node:child_process`、`node:http` 的代码（`file-tools.ts` 是个文件工具，它当然要用 fs），那是正常实现，不是待修的架构违规。别照着「零宿主依赖」这种省字说法去"清理"它们。

**保留它，但不要再新增 host 形状的间接层。** 不要为「将来可能的宿主」加第二个抽象接口，不要给已有的单一实现套 provider / factory / registry / adapter。判断标准很简单：**一层间接如果只有一个实现、且没有第二个实现的现实计划，它就不是抽象，是绕路。** 同理适用于别处 —— 已经删过一轮死导出与重复 helper，新增前先搜一遍有没有现成的。

## 杂项

- `core.autocrlf=true` + `.gitattributes`：库里统一 LF，Windows 工作区检出为 CRLF。`git add` 时的 “LF will be replaced by CRLF” 警告是正常的，不用管。按字节锚定的编辑前先确认工作区实际换行（`read_files` 返回的就是工作区字节），不要假设。
- 提交信息用英文，重点写**为什么**（这个仓库的历史提交都是这个风格：现场是什么、为什么错、为什么不那样修）；`CHANGELOG.md` 的 `[Unreleased]` 用中文，按 Keep a Changelog 的 Added → Changed → Fixed 分区。
- **`npm audit` 要用 `npm run audit`。** 本机 registry 指向 `registry.npmmirror.com`（国内镜像），而它没实现 npm 的安全通告端点：`npm audit` 会 POST `/-/npm/v1/security/advisories/bulk`，镜像回 **404 `[NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet`**。这既不是依赖有问题、也不是 npm 坏了。`npm run audit` 只给这一条命令换回官方源（`--registry=https://registry.npmjs.org`，走已配置的代理可达），装包仍然走镜像。
- **不要从进程里用 `fetch` 打自己**（`127.0.0.1:<自己的端口>`）。undici 会把这条回环连接留在**同一个进程**的 keep-alive 池里；停机时 `closeIdleConnections()` / `closeAllConnections()` 摧毁服务端那一侧，客户端句柄还活着，Node 24 在 Windows 上直接撞 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 把干净停机变成 fastfail 退出码（`3221226505`）。本地自检一律走 `src/bridge/self-probe.ts` 的 `selfProbe()`（`node:http` + `agent: false`，读完即关）；打公网隧道的探测不算，它本来就是另一台主机。
- 开发过程本身通常就跑在这个 bridge 上（`run_script` / `edit_block` / `read_files`）。注意 `run_script` 沙箱里没有 fs 与网络，要用 `await tools.*`；`console.log` 不等于 `return`；`edit_block` 的 `old_text` 必须在文件里**恰好命中一次**。
