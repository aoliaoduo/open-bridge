# 仓库修改约定

适用于修改本仓库，不扩大当前用户的任务或授权。只读任务不编辑、构建或提交；保留用户已有改动。`CLAUDE.md` 只链接到本文，不另写一套规则。

- 工具行为与参数：[docs/tools.md](docs/tools.md)。
- 模块职责与依赖边界：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
- 贡献与发布检查：[CONTRIBUTING.md](CONTRIBUTING.md)。
- 用户采用的 Agent 协作节奏：[docs/agent-collaboration-workflow.md](docs/agent-collaboration-workflow.md)。

## 验证

- 完整修改工作组使用 `npm run release:check`（类型检查、lint、构建、全部测试与打包检查）。如有失败或跳过，如实说明，不反复重跑来掩盖原因。
- 集成测试启动 `bin/open-bridge.js`、读取 `dist/`：源码改后先构建。单元测试在 `test/*.test.ts`，集成在 `test/*.test.mjs`，UI 测试在 `ui/src/**`，由各自配置自动收录。
- **缺陷回归**先在未修复代码上确认失败，再修复。重构或新增覆盖应检查真实入口、边界及错误路径，不必为让测试变红而把正确旧行为说成缺陷；必要时用受控变异证明断言有效，并明确证据性质。
- 进程测试用输出/就绪信号，不以固定睡眠代替就绪。Windows 子进程清理使用 `test/tmpdir.mjs` 的 `removeTempDir()`，避免句柄尚未释放时偶发失败。

## 实现边界

- 保持工具名称、权限模型、兼容输入与公开契约，除非任务明确要求改变。删除前查真实调用与替代实现；仅供测试使用不等于没有用途。
- 核心依赖 `src/host/host.ts` 的 `Host` 接口，不依赖具体宿主实现；具体实现留在 CLI 安装和本机 API 边界。Node 内置模块可以直接使用，不为假想需求增加只有一份实现的间接层。
- 必填参数缺失时点名字段；非法值交给对应校验器。保留有意义的空值、默认值和既有合法范围，共享入口复用同一校验逻辑。
- 数值先确认有限性；`Math.max(0, Number(x))` 不能修复 `NaN`。安全边界无法判断时拒绝，不能回落成“允许”。
- 核心和 UI 已启用 `noUncheckedIndexedAccess`。优先消除不必要的索引；兜底必须语义正确，非空断言要有依据。外部输入仍需运行时检查，不因静态类型或 lint 判断删除真守卫。
- 自检本进程 HTTP 使用 `src/bridge/self-probe.ts` 的 `selfProbe()`，不要用 keep-alive `fetch` 打自己的监听器；后者曾导致 Windows 停机句柄崩溃。

## 编辑与交付

- 仓库换行以 `.gitattributes` 为准；编辑前读实际文件，不假设工作区一定是 LF 或 CRLF。用版本摘要避免覆盖并发改动，改完审阅完整 diff。
- 英文提交信息解释行为与原因；用户可观察变化记入中文 `CHANGELOG.md` 的 `[Unreleased]`。不提交构建产物、缓存、真实连接 URL 或密钥，也不擅自推送或改写历史。
- 依赖审计用 `npm run audit`，仅审计命令走官方源；镜像安全端点的 404 / `NOT_IMPLEMENTED` 不等于依赖漏洞。
