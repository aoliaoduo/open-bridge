# 研读的第三方参考项目（仅存链接）

本机曾克隆过约 991MB 的三份第三方项目用于研读（Phase B 设计基线的矿源），
2026-09-16 暂停开发时删除本地副本，仅留链接。需要复看时重新克隆即可。

| 项目 | 仓库 | 我们挖到的（详见 docs/desktop-phase-b-mining.md） |
|---|---|---|
| cindy | https://github.com/makecindy/cindy | 成品 agent 桌面壳参考；`docs/e2e-evidence/` 证据惯例（我们已落地为 docs/evidence/） |
| HippoBuddy | https://github.com/Puteitous/HippoBuddy | Electron 薄壳经验：AppUserModelId 必须与 builder appId 一致（已修）、单实例锁形态 |
| Kun | https://github.com/KunAgent/Kun | B1 审批中心设计基线：HMAC 签名同意令牌（approval-consent.ts）、pendingApprovals 清场状态机（workflow-run-coordinator.ts）、.kunsdd/plan 契约式计划格式 |
