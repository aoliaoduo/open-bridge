# Open Bridge Desktop（桌面壳 · 第一阶段：薄壳）

把 `open-bridge serve` 托管进原生窗口与系统托盘：壳负责启动、健康等待、
崩溃重启、托盘常驻与退出清理；窗口本体仍是 `dist/ui` 的 Web 控制台，桥与
配置与 CLI 完全同源（同一数据 home、同一 runtime 记录体系）。

界面参考 Codex / Claude Desktop / Trae / Qoder 的桌面形态；这些产品的桌面端
全部是 Electron 栈（OpenAI 公开说明为与 VS Code 扩展共享代码并快上 Windows），
本壳同样选择 Electron：桥的服务可以直接以 `ELECTRON_RUN_AS_NODE` 子进程开出，
零新增语言栈。

## 开发

```bash
# 先在仓库根目录构建桥（壳起的是 dist/，不是 src/）
npm run build
cd desktop
npm install        # 首次：拉 electron（.npmrc 已指 npmmirror 镜像）
npm start          # 启动壳
npm run smoke      # 冒烟：开窗 20 秒后自退，供首验
```

首发平台 Windows；macOS/Linus 的 builder target 在后续迭代开启。

## 行为约定

- **一目录一实例**：若该工作区已有实例在跑（runtime 记录命中且健康），壳
  不抢、直接附着到它的端口。
- **崩溃自愈**：子进程非预期退出按 1s/2s/5s/15s 退避重启，四轮未果停手，
  托盘菜单留「重启服务」。
- **关窗不退**：窗口关闭只是收起界面，服务与托盘常驻；托盘「退出」才会
  优雅停止桥子进程。
- **日志**：壳位于 `<userData>/logs/bridge.log`（轮转一代，1MB 上限）。

## 路线图

第二阶段在 preload 暴露的 `obDesktop` 表面上长出 agent 工作台界面
（对话流 / diff 视图 / 文件树 / 终端），复用壳的窗口与生命周期，壳不再变。

## 打包

```bash
cd desktop
npm run dist       # electron-builder → desktop/dist/ 下出 NSIS 安装包
```
