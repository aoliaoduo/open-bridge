# Contributing

English · [中文](#贡献指南)

## Prepare and verify

Use a Node version supported by [package.json](package.json), then:

```bash
npm ci
npm run release:check
```

The release check runs typechecking, lint, build, all test layers and the npm
package preflight. Include the exact checks and outcomes in your PR; explain
failures, skips or checks you could not run instead of implying they passed.

[AGENTS.md](AGENTS.md) is the canonical source for implementation boundaries,
test locations and regression evidence. Do not copy those rules here.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) owns the module map; the optional
[Agent workflow](docs/agent-collaboration-workflow.md) owns task selection,
commit authorization and restart verification.

## Keep the change focused

- Explain the problem, behavior change and verification in the PR. Preserve
  unrelated work and do not include generated output or credentials.
- Commit messages are English and explain why. User-visible changes belong
  in the Chinese `[Unreleased]` section of `CHANGELOG.md`.
- Keep the two READMEs in their existing languages. Other reference documents
  keep one canonical version per topic; update links and implementation
  pointers rather than creating parallel copies of the rules.
- Use the PR template as a report of evidence, not an extra implementation
  policy. A new coverage test is not automatically a reproduced bug.

## Security and conduct

Report vulnerabilities through a
[private security advisory](https://github.com/aoliaoduo/open-bridge/security/advisories/new),
not a public issue. Read [SECURITY.md](SECURITY.md) for the threat model and
intentional product boundaries. Redact credentials and private paths from
ordinary bug reports and transcripts.

Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Contributions are under
[MIT](LICENSE).

---

# 贡献指南

[English](#contributing) · 中文

使用 [package.json](package.json) 声明支持的 Node 版本，执行 `npm ci` 和
`npm run release:check`。在 PR 中列出实际检查和结果；失败、跳过或未执行项都要说明。

实现边界、测试位置与回归证据只维护在 [AGENTS.md](AGENTS.md)，不要在这里复制。
模块地图见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；采用 Agent 协作时，选择、提交授权和
重启验证见 [协作流程](docs/agent-collaboration-workflow.md)。

- 改动围绕当前问题，保留无关工作；不提交产物、缓存、连接凭据或密钥。
- 提交信息用英文说明原因；用户可观察变化写入中文 `CHANGELOG.md` 的 `[Unreleased]`。
- 两份 README 沿用各自语言，其他参考文档每个主题保留一个正本，并及时更新链接。
- PR 模板用于汇报证据，不另立一套规则；新增覆盖不应被冒充为已复现的缺陷。
- 漏洞走[私密安全通告](https://github.com/aoliaoduo/open-bridge/security/advisories/new)；
  普通问题报告和对话片段先脱敏。边界见 [SECURITY.md](SECURITY.md)。

遵守 [行为准则](CODE_OF_CONDUCT.md)。贡献采用 [MIT 许可](LICENSE)。
