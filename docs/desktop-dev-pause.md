# 桌面端开发暂停交接（2026-09-16）

状态：**暂停开发**。桥本体与桌面客户端 v2 处于"可日常用"的稳定点；本文档是恢复开发时的交接。

## 现在已经有什么

- **open-bridge 本体**：单进程 MCP 桥，40 个工具，`npm run verify` 全绿（665/666 + 176/176）。
- **桌面客户端 v2**（Electron, `desktop/`）：托盘常驻 + 三视图（总览 / 活动实况 / 工具目录），
  明暗双主题，键盘导航（1/2/3、`/`、Esc、Ctrl+D），公网/回环连接器 URL 一键复制，
  活动实况走 `/api/activity` 轮询（不需要 MCP 会话）。
- 关键提交：`bce9319`（v2 三视图+证据回路）、`85f3721`（MCP 优先收敛）、`2876486`（桌面壳早期形态）。

## 架构速记

- `desktop/main.mjs`：壳主进程。桥子进程孵化/附着、routeToken 与公网 MCP URL 从桥 stdout 横幅正则捕获、
  托盘菜单、IPC（`ob:status` / `ob:activity` / `ob:copy-text` / `ob:reveal-path` / `mcp:*` 预留插座）。
- `desktop/preload.cjs`：渲染层唯一受控桥面 `obDesktop`。
- `desktop/workbench/{index.html,styles.css,app.js}`：原生 JS 渲染层（无构建链）。
  视图用 hash 路由（`#home/#feed/#tools`），`[hidden]{display:none!important}` 保视图互斥。
- 活动实况数据源：主进程 `fetchActivity()` → `GET http://127.0.0.1:<port>/api/activity`（loopback 门）。

## 日常怎么跑

```bash
cd desktop
npm start                 # dev 模式
npm run smoke             # 起壳→20s 自退，是"起得来"的最小证明
./node_modules/.bin/electron . --smoke --smoke-view=feed   # 直开某视图并截图（证据回路）
npm run pack              # electron-builder --dir（可跑，产物大）
npm run dist              # NSIS 安装包（从未跑过，恢复开发第一件事）
# 仓库根：
npm run verify            # 提交前硬门槛，必须全绿
```

视觉证据惯例（来源 cindy）：行为/界面变更要留截图到 `docs/evidence/<面>/<日期>/步骤名.png`。

## 恢复开发时的优先级

1. **NSIS 打包 `npm run dist`**：还没跑过一次；跑完把安装包烟测（双击安装→托盘→三视图）。
2. **B1 审批中心**（设计已备好，见 `docs/desktop-phase-b-mining.md`）：
   桥侧先长最小审批 API（签名决策头，密钥 = routeToken；伪造决策红测先行），壳再做窗格。
3. **`desktop/dist` 瘦身**：524MB 里混进了 vite/esbuild 等 devDeps（electron-builder 把
   devDependencies 也打进 resources/bridge）；恢复后用生产裁剪重做 pack。
4. 安全/行为审计续摊：`src/mcp/batch.ts`、`src/process-tools.ts`（19/110 的摊子），
   以及 run_command 长命令串台的一次确定性复测。

## 注意

- 桌面 dev 与打包产物**共用** `%APPDATA%/open-bridge-desktop` userData（含同一套配置/日志）；
  烟图写在其下 `smoke-shot.png`。
- `参考/` 三个第三方项目只在本机研读用（991MB），已被 .gitignore 永久挡在仓库外。
- 单实例锁已存在；`setAppUserModelId` 已对齐 electron-builder 的 `appId`（通知图标教训，HippoBuddy 记载）。
