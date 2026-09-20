<!--
  Report observed behavior with the smallest relevant command/output excerpt.
  Redact MCP URLs, tokens, credentials and private paths before posting.
  Do not upload a whole unreviewed log or conversation.
-->

**Language**: English below · [中文](#bug-report中文) at the bottom of this
template.

### What happened

<!-- Observed behavior and a relevant command/output excerpt, with credentials and private paths redacted. -->

### What you expected

<!-- What you thought would happen instead, and why. -->

### Environment

- OS:
- Node version (`node -v`):
- open-bridge version (`node bin/open-bridge.js version` or the npm version):
- Exposure level at the time (local / public-open / public-authed, see `status`):

### Is it a deliberate choice?

Before filing, check [SECURITY.md](../../SECURITY.md) — "What is deliberately
not locked down" lists behaviours that look like bugs but are documented
choices (`unrestrictedFileAccess` defaulting on, non-zero exit codes not
counting as failures, ...). If your report is about one of those, close this
and open a discussion or a feature request arguing the case instead.

If this lets a party other than the operator reach the workspace, or exposes
a secret that should have been masked: **do not use an issue** — open a
[security advisory](https://github.com/aoliaoduo/open-bridge/security/advisories/new).

---

# bug-report（中文）

**语言**：见上方的英文版。

### 实际发生了什么

<!-- 实际现象和相关命令/输出片段。先移除 MCP URL、令牌、密钥及私人路径，不要直接上传整份日志或对话。 -->

### 你期望的是什么

<!-- 你认为应该发生什么，以及为什么。 -->

### 环境

- 操作系统：
- Node 版本（`node -v`）：
- open-bridge 版本（`node bin/open-bridge.js version` 或 npm 版本号）：
- 当时的暴露级别（local / public-open / public-authed，见 `status`）：

### 这是不是一个写明的取舍？

提交前先看 [SECURITY.md](../../SECURITY.md) 的「What is deliberately not
locked down」—— 那里列着看起来像 bug、但其实是写明理由的取舍的行为
（`unrestrictedFileAccess` 默认开、非零退出码不算失败……）。如果你的报告
针对的是其中之一，请关掉这个模板，改开一个把论据摆出来的讨论或功能建议。

如果它让操作者之外的人够到了工作区、或暴露了本该被掩码的密钥：
**不要用 issue** —— 开一个
[安全通告](https://github.com/aoliaoduo/open-bridge/security/advisories/new)。
