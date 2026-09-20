<!--
  Three boxes. If one does not apply, leave it unchecked and say why --
  an honest "N/A because ..." is worth more than a tick.
-->

**Language**: English below · [中文](#pull-request中文) at the bottom of this
template.

## What

<!-- What this changes, in one or two sentences. -->

## Why

<!-- The situation that was wrong or missing, and why this is the fix for
     it. If there was an obvious fix you rejected, say why you rejected it.
     Commit messages in this repo explain why; the PR is the place to say
     the parts that do not fit in a commit. -->

## Checklist

- [ ] `npm run release:check` passed; exact outcomes and any skipped or
      unexecuted checks are listed below.
- [ ] Test evidence follows [AGENTS.md](../AGENTS.md): bug regressions are
      reproduced before the fix; added coverage is not claimed as a reproduced bug.
- [ ] `CHANGELOG.md` `[Unreleased]` has an entry (Chinese, Keep a
      Changelog order) -- or this change is not observable by a user and
      that is stated here.

---

# pull-request（中文）

**语言**：见上方的英文版。

## What

<!-- 这个改动做了什么，一两句话。 -->

## Why

<!-- 原本错在哪、缺了什么，为什么这就是修法。如果有一个显而易见的
     修法而你没采用，说清为什么不用它。这个仓库的提交信息讲 why；
     PR 里放的是塞不进单条提交的那些。 -->

## Checklist

- [ ] `npm run release:check` 通过，列明结果、跳过或未执行项。
- [ ] 测试证据遵循 [AGENTS.md](../AGENTS.md)：缺陷回归先复现；
      新增覆盖不冒充已复现的缺陷。
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 有条目（中文，按 Keep a
      Changelog 分区）—— 或者这个改动用户观察不到，并在此说明。
