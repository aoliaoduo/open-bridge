# Phase B 矿业报告 → 窗格设计映射（恢复 B1 时先读本文）

日期：2026-09-16 · 状态：阶段 B 设计基线（勘探完成，未动工）

## 一、三家各挖到了什么（file:line 锚点）

### Kun（KunAgent）—— 审批状态机 + 签名同意令牌 + 契约式计划文档

1. **签名同意令牌** `src/main/approval-consent.ts`（全文仅 28 行）：
   审批决定不是"前端 POST 一个 allow"，而是生成 `x-kun-approval-consent` 头：
   `v1.expiresAt.nonce.HMAC(runtimeToken; v1\napprovalId\ndecision\nexpiresAt\nnonce)`。
   关键性质：**LLM/中继无法伪造"用户已批准"**。我们手里现成的 runtimeToken 等价物 = **routeToken**。
2. **挂起清单 + 强制清场** `src/main/workflow-run-coordinator.ts:18`：
   `pendingApprovals: Map<token, PendingApproval>`，run 取消/进程退出时 `:89` 统一 `resolve('rejected')`。
3. **渲染层只做展示** `src/main/ipc/register-app-runtime-ipc-handlers.ts:248`：列表挂 IPC 面。
4. **计划即契约** `.kunsdd/plan/sdd-*.md`：概要/影响范围表/带 diff 的步骤/验收勾选/风险表/「不做」。

### cindy —— 证据是交付物的一部分

- `docs/e2e-evidence/{YYYY-MM-DD|pr-XXXX}/step-name.png`：行为变更附按流程步骤命名的截图。
- 我们已落地：`docs/evidence/desktop/2026-09-16/`。

### HippoBuddy —— 薄壳教训

- **AppUserModelId 必须 == electron-builder `appId`**，否则打包版通知无图标（main.js:26-31）→ 已修。
- 单实例锁 + second-instance 聚焦已有同款（main.mjs:540 ✓）。

## 二、Phase B 实施提案（Kun 计划格式）

### 概要

三块 pane：**审批中心 > diff 流 > 终端卡**，按桥侧依赖排序。

### 影响范围

| 变更 | 仓库侧 | 桥侧依赖 |
|---|---|---|
| B1 审批中心窗格（活动实况里漂起 pending，签名决策头下发） | workbench 新视图 + IPC | **有**：桥需 pending-approval 队列 + `POST /api/approvals/:id/decision`（收 `x-ob-approval` 签名头，HMAC 密钥=routeToken；伪造决策红测先行） |
| B2 diff 流窗格 | workbench + mcp.call 插座 | 弱：复用 activity 里 changes 摘要即可出 v0 |
| B3 终端卡（壳内伪终端视窗） | workbench + IPC × `run_command` | 无（经 MCP 插座；v0 只读） |

### 验收标准

- [ ] 伪造 approval decision（无/错误签名头）被桥拒绝（红测）
- [ ] 桥重启/工作区切换时所有 pending 自动 rejected
- [ ] 活动实况 → diff 窗格可见文件级 +N/-M
- [ ] 每个 B 阶段落地有 docs/evidence/desktop/ 截图
- [ ] `npm run verify` 全绿

### 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 桥加审批面牵动 MCP 工具阻塞语义 | 中 | 审批仅作用于标注危险的工具子集；默认行为不变 |
| routeToken 用作 HMAC 密钥，泄露即等同伪造许可 | 中 | token 不出主进程；日志禁打；落地时跑 `npm run audit` |

### 不做

- 不做配对引导/连接器教学（用户已关闭议题）
- 不做 LLM API-key 循环回归
- 不动 `参考/`（只读样本库）
- B1 之前不做审批 UI
