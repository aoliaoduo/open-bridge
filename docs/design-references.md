# 控制台界面设计参考（第三方）

控制台的界面语言不是凭空设计的，而是照着四个开源项目的版式与交互做的。这份文件记录「哪一块来自哪里」，以及许可与署名要求。

## 参考项目（许可记录于最初参考时；直接复用代码前重新核对）

| # | 项目 | 许可 | 我们借了什么 |
| --- | --- | --- | --- |
| 1 | [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) | MIT | **左侧固定导航**（分组标题 + 当前项高亮 + 可折叠）· **面包屑页头**（`控制台 / 分组 / 页面`）· 页面标题 + 一行说明 + 右侧页面级操作 · 中性灰配色 + 单一强调色 |
| 2 | [tabler/tabler](https://github.com/tabler/tabler) | MIT | **KPI 大数字卡**（一行四张：会话 / 活动命令 / 对外工具 / 文件锁）· **分区标题下的细横线**（二级下划线标签的同一套语言）· **活动列表**（状态点 + 对象 + 说明 + 右侧时间码）· 服务操作按钮右对齐 |
| 3 | [Kiranism/next-shadcn-dashboard-starter](https://github.com/Kiranism/next-shadcn-dashboard-starter) | MIT | **可折叠侧栏**（折叠后保留可访问名）· **表格工具栏**（就地搜索/筛选 + 结果计数）· **空状态**（一句话说明这个页面会显示什么、怎么让它有内容）· 黑白克制、只留一个强调色 |
| 4 | [tremorlabs/tremor](https://github.com/tremorlabs/tremor) | Apache-2.0 | **状态芯片**（圆点 + 文字 + 底色，统一 `ok / warn / err / idle` 四态）· KPI 卡的主数字 + 副文本结构 |

## 落点对照

| 设计元素 | 代码位置 | 来自 |
| --- | --- | --- |
| 分组侧栏 + 折叠（记忆在 localStorage） | `ui/src/components/Sidebar.tsx`、`ui/src/routes.ts`（`group`） | 1、3 |
| 面包屑 + 运行状态芯片 + 版本 + 主题切换 | `ui/src/components/Topbar.tsx` | 1、2 |
| 页面标题 + 说明 + 页面级操作 | `ui/src/components/PageHeader.tsx` | 1 |
| KPI 大数字卡 | `ui/src/components/Stat.tsx` | 2、4 |
| 状态芯片 | `ui/src/components/Chip.tsx` | 4（也是 1/2/3 的通用做法） |
| 分区标题细横线、卡片、表格、工具栏、活动列表 | `ui/src/console.css` | 2、3 |
| 空状态 | `ui/src/components/EmptyState.tsx` | 3 |
| 设置页分区栏（吸顶二级标签） | `ui/src/components/SectionNav.tsx` | 1（侧栏子导航的思路）、2（下划线标签的形态） |
| 明/暗/跟随系统三态主题 | `ui/src/theme.ts` | 1、2、3 都有切换；差异是我们把「跟随系统」在 JS 里解析成具体主题，样式表只认两套调色板 |

## 许可与署名

- **没有复制任何代码。** 上面借的是版式、层级与交互套路（左侧栏、KPI 卡、下划线分区、状态芯片这类通用做法），CSS 全部为本仓库自己编写，组件也是自己的实现。
- 因此不产生源码级别的署名义务；本文件即为对参考项目的公开致谢。
- 如果将来**直接搬运**其中任一项目的代码片段，必须在该处注明来源与版权，并把对应许可全文加入本仓库的 `THIRD_PARTY_NOTICES`（1/2/3 为 MIT，4 为 Apache-2.0）。本项目自身许可是 MIT（见 `LICENSE`）。
