# Contributing

English · [中文](#贡献指南)

## Read AGENTS.md first

[AGENTS.md](AGENTS.md) is the single source of truth for conventions inside
this repository: parameter-guard rules, `noUncheckedIndexedAccess`
discipline, Windows teardown traps, the `Host` interface boundary, how to
audit dependencies on this machine. This file covers how to get a change in
and deliberately does **not** repeat any of that — two copies of a rule are
two copies that drift apart. When this file and AGENTS.md disagree, AGENTS.md
wins and this file gets fixed.

## Ground rules

- Node `>= 22`. `npm ci`, then `npm run verify` (typecheck + lint + build +
  all tests). **A change is not ready until that is green.**
- Commit messages are in English and explain **why** — the situation, what
  was wrong with it, why the obvious fix was not taken. The history of this
  repo is written that way; `git log` is the style guide.
- `CHANGELOG.md` `[Unreleased]` entries are in Chinese, in Keep a Changelog
  order (Added → Changed → Fixed). Notable changes get an entry; "notable"
  includes behaviour changes and fixes a user could observe.
- Documentation language: `README.md` is English, `README.zh-CN.md` is
  Chinese, `docs/` is English only. Do not start a translated `docs/` tree —
  two reference documents drift apart faster than one stays correct.

## Two traps that eat contributions

**1. Integration tests run `dist/`, not `src/`.** `test/*.test.mjs` boots
`bin/open-bridge.js`, which loads the compiled output. Change source, run
the integration suite without `npm run build` first, and you will see the
*old* behaviour — it looks exactly like "my fix didn't work". `npm run
verify` builds before testing; if you run test layers individually, build
first.

**2. A new test must be shown to fail before it is kept.** Run it against
the unfixed code and watch it go red. This repo has shipped tests that
passed against the very bug they were named after; one pinned a bug as the
expected behaviour (`idleMinutes 0 switches off both watchdogs, not just
one`), so every later correct fix was marked broken by it. A test that
cannot fail is worse than no test — it tells the next person that someone
is guarding this. If a bug genuinely cannot be reproduced, say so in a
comment (reasoned, not reproduced) instead of dressing inference up as
regression coverage.

## Where tests go

| Layer | Location | Runner |
| --- | --- | --- |
| Unit | `test/*.test.ts` | tsx |
| Integration | `test/*.test.mjs` (glob-discovered, files run in parallel) | `node --test` |
| UI | `ui/src/**` — **not** `test/`: `vitest.config.ts` only includes that location, and a UI test placed in `test/` silently never runs | vitest |

How to write each kind — readiness signals instead of fixed `delay()`,
`removeTempDir()` for teardown, validator-test exemplars — is in
[AGENTS.md](AGENTS.md).

## Security

Something that lets a party other than the operator reach the workspace, or
exposes a secret the masking is supposed to cover, goes to a
[GitHub security advisory](https://github.com/aoliaoduo/open-bridge-app/security/advisories/new) —
not an issue. See [SECURITY.md](SECURITY.md). Read its "What is deliberately
not locked down" section before filing: `unrestrictedFileAccess` defaulting
on, non-zero exit codes not being failures, and the like are documented
choices. The place to challenge a choice is an issue that argues the case.

## License

MIT. Submitting a contribution means it is under the same license.

---

# 贡献指南

[English](#contributing) · 中文

## 先读 AGENTS.md

[AGENTS.md](AGENTS.md) 是这个仓库内部约定的**唯一正本**：参数守卫的规矩、`noUncheckedIndexedAccess` 的处理方式、Windows 上清理句柄的坑、`Host` 接口的边界、本机怎么跑依赖审计。本文件只讲「怎么把一个改动送进来」，**刻意不重复那些内容** —— 一条规矩写两份，就是两份各自漂移的开始。本文件和 AGENTS.md 冲突时，以 AGENTS.md 为准，然后来修本文件。

## 基本要求

- Node `>= 22`。`npm ci`，然后 `npm run verify`（typecheck + lint + build +
  全部测试）。**不全绿就不算做完。**
- 提交信息用英文，重点写**为什么** —— 现场是什么、错在哪、为什么不用那个显而易见的修法。这个仓库的历史就是这么写的，`git log` 就是风格样板。
- `CHANGELOG.md` 的 `[Unreleased]` 用中文，按 Keep a Changelog 的分区（Added → Changed → Fixed）。用户能观察到的行为变化和修复都该有条目。
- 文档语言：`README.md` 英文、`README.zh-CN.md` 中文、`docs/` 只有英文。**不要**另起一套翻译的 `docs/` —— 两份参考文档各自漂移的速度，比一份保持正确要快。

## 两个最容易吃掉外来贡献的坑

**1. 集成测试跑的是 `dist/`，不是 `src/`。** `test/*.test.mjs` 启动 `bin/open-bridge.js`，加载的是编译产物。改完源码、不先 `npm run build` 就跑集成测试，看到的是**旧行为** —— 症状和「我的修复没生效」一模一样。`npm run verify` 会先 build 再测；单独跑某一层测试时，先 build。

**2. 新测试在保留之前，必须先证明它会失败。** 把它跑给未修复的代码看一次，确认它红。这个仓库出过「测试对着它名字里那个 bug 照样通过」的事；还有一条把 bug 当成规格钉住（名字叫 `idleMinutes 0 switches off both watchdogs, not just one`），后来任何修对了行为的人都会被它判定为改坏。不会失败的测试比没有测试更糟 —— 它让下一个人以为这里有人守着。实在复现不了的，就在注释里写明这是推理而非复现，不要把推断包装成回归覆盖。

## 测试放哪一层

| 层 | 位置 | 运行器 |
| --- | --- | --- |
| 单元 | `test/*.test.ts` | tsx |
| 集成（glob 自动收录，文件间并行） | `test/*.test.mjs` | `node --test` |
| UI | `ui/src/**` —— **不是** `test/`：`vitest.config.ts` 的 include 只认那个位置，放进 `test/` 的 UI 测试会静默地不跑 | vitest |

各层怎么写 —— 用就绪信号而不是固定 `delay()`、清理走 `removeTempDir()`、校验器测试的样板 —— 见 [AGENTS.md](AGENTS.md)。

## 安全

任何让操作者之外的人够到工作区、或让本该被掩码的密钥暴露出来的问题，走 [GitHub 安全通告](https://github.com/aoliaoduo/open-bridge-app/security/advisories/new)，**不要开 issue**。见 [SECURITY.md](SECURITY.md)。开 issue 前先读它的「What is deliberately not locked down」一节：`unrestrictedFileAccess` 默认开、非零退出码不算失败，这些是写明了理由的取舍。想挑战一个取舍，开一个把论据摆出来的 issue。

## 许可证

MIT。提交贡献即表示接受同一许可。
