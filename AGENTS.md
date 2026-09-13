# AGENTS.md — 在这个仓库里干活的约定

面向**改这个仓库的人和 agent**。用户视角的说明在 `README.md`，每个工具的完整行为在 `docs/tools.md`，架构、分层与依赖在 README 的「开发」一节 —— 那些这里不重复。这里只记**踩过才知道**的部分。

## 改完源码之后

- `npm run verify` = typecheck + lint + build + 全部测试。**提交前必须全绿。**
- **集成测试跑的是 `bin/open-bridge.js` → `dist/`，不是 `src/`。** 改完源码不先 `npm run build`，端到端测试会继续报旧行为，看起来就像「守卫没生效」。这个坑已经踩过两次。
- 三层测试：单元 `test/*.test.ts`（tsx）、集成 `test/*.test.mjs`（`node --test`）、UI（vitest）。集成那份是 **glob 自动收录**的，新增文件不需要在任何地方登记。
- **`noUncheckedIndexedAccess` 已开启**（core 与 ui 两份 tsconfig 都开）。所以 `arr[i]`、`match[1]`、`map.get` 之外的索引访问一律是 `T | undefined`，必须显式处理。三种处理方式，按场景选：
  - 能把索引访问**消掉**就消掉（把 push 的值存成局部变量、`for (const x of …)`、`arr[0]?.field ?? fallback`）。
  - **兜底值语义无害**时用 `?? 兜底`（字符串取 `?? ""`、`split()[0] ?? ""`）。
  - **兜底会把错误悄悄算错**时用 `!`，并在旁边注明它凭什么成立（数值 DP 表、补丁偏移量、SSRF 分类器里的字节）。判据：如果这个值真的 undefined，你希望**炸掉**还是希望**得到一个看起来合理的错答案**？后者就绝不能用 `??`。
  - 安全边界上一律**失败即拒绝**：`classifyIpv4` 读不出八位组时返回 `"reserved"` 而不是往下走到 `"public"`。
- 集成文件之间是**并行**跑的，每个文件各启一个实例。因此：**不要用固定 `delay()` 当作「子进程已就绪」的代理**，用 `start_process` 的 `ready_pattern`，并让就绪信号由被测进程自己发出（先挂监听器、再打印标记）。固定睡眠在并行负载下会偶发失败，而且单独跑那个文件时永远复现不出来 —— 最难查的一类 flake。

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

`src/host/host.ts` 的 `Host` 是唯一的宿主抽象，`src/host/node-host.ts` 是文件版实现。核心（`src/bridge|http|mcp|network|process|shell|workspace`）零宿主依赖，任何宿主只需实现一次 `Host`。

**保留它，但不要再新增 host 形状的间接层。** 不要为「将来可能的宿主」加第二个抽象接口，不要给已有的单一实现套 provider / factory / registry / adapter。判断标准很简单：**一层间接如果只有一个实现、且没有第二个实现的现实计划，它就不是抽象，是绕路。** 同理适用于别处 —— 已经删过一轮死导出与重复 helper，新增前先搜一遍有没有现成的。

## 杂项

- `core.autocrlf=true`：源码 `.ts` 在库里是 CRLF，测试 `.mjs` 是 LF。`git add` 时的 “LF will be replaced by CRLF” 警告是正常的，不用管。
- 提交信息用英文，重点写**为什么**（这个仓库的历史提交都是这个风格：现场是什么、为什么错、为什么不那样修）；`CHANGELOG.md` 的 `[Unreleased]` 用中文，按 Keep a Changelog 的 Added → Changed → Fixed 分区。
- **`npm audit` 要用 `npm run audit`。** 本机 registry 指向 `registry.npmmirror.com`（国内镜像），而它没实现 npm 的安全通告端点：`npm audit` 会 POST `/-/npm/v1/security/advisories/bulk`，镜像回 **404 `[NOT_IMPLEMENTED] /-/npm/v1/security/* not implemented yet`**。这既不是依赖有问题、也不是 npm 坏了。`npm run audit` 只给这一条命令换回官方源（`--registry=https://registry.npmjs.org`，走已配置的代理可达），装包仍然走镜像。
- 开发过程本身通常就跑在这个 bridge 上（`run_script` / `edit_block` / `read_files`）。注意 `run_script` 沙箱里没有 fs 与网络，要用 `await tools.*`；`console.log` 不等于 `return`；`edit_block` 的 `old_text` 必须在文件里**恰好命中一次**。
