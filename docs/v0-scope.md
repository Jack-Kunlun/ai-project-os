# AI Project OS V0 范围

## 目标

用 5 天完成一个可运行的 Project Snapshot 原型，验证用户是否能通过项目资料快速回答：项目现在怎么样、最近发生了什么、有哪些问题或风险、做出了哪些关键决策、现在最值得关注什么。

## 当前范围

```text
项目资料 / 日报 / 截图 / GitHub 只读信息
                    ↓
                AI Extract
                    ↓
     Decision / Progress / Issue / Risk
                    ↓
             用户确认或编辑
                    ↓
             Project Snapshot
```

Day 1 只交付项目容器、数据库 schema、健康检查、项目 CRUD 和基础页面。Sources、Items、Snapshot 在项目详情页保留占位区域，后续按 5 天计划接入。

Day 1 的最终验收记录（包括真实 HTTP smoke、catalog 断言和事务完整性 smoke）见 [docs/acceptance/day-1.md](acceptance/day-1.md)。

## 非目标

V0 不接入 LLM、GitHub 实时连接、文件上传、认证、多用户/RBAC、队列、pgvector、MCP、Action Engine、PR Review、自动改代码、自动修 Bug、创建 PR、复杂 evidence graph、完整 current-state 冲突引擎或正式飞书接入。

## 数据原则

- 原始输入先作为候选资料，不能直接等同于可信记忆。
- `ProjectSource` 保存来源类型、引用和内容摘要；`ProjectItem.sourceId/sourceExcerpt` 保留可追溯入口。
- `ProjectItem.sourceId` 在数据库层为必填，并且 Item→Source、Item→supersedes、Snapshot→Scan 都通过 `[projectId, foreignId] -> [projectId, id]` 复合外键限制为同项目关系。
- 上述三条跨子表关系在 PostgreSQL 中是 `NoAction`、`DEFERRABLE INITIALLY DEFERRED`：默认在事务结束检查，或用 `SET CONSTRAINTS ... IMMEDIATE` 提前检查；项目根关系仍为 Cascade。Prisma 7 PSL 不表达 deferrable，因此该属性由增量迁移中的 PostgreSQL-only SQL 保留。
- Event/history 与 current state 的完整治理不在 Day 1 实现；schema 预留 scan、snapshot 和 supersession 关系。
- 不把当前“不做付费会员”等产品范围限制硬编码进基础模型。

## 5 天计划

| 天数 | 交付 | 验收焦点 |
| --- | --- | --- |
| Day 1 | Next.js 单体骨架、PostgreSQL、Prisma schema、Project CRUD、基础页面 | 真实 DB ready，CRUD 与项目级检查全绿 |
| Day 2 | Source 手动录入与基础资料展示 | 来源可保存，内容与 hash 可追溯 |
| Day 3 | ProjectItem 候选列表、确认/编辑状态 | decision/progress/issue/risk 可被用户确认 |
| Day 4 | Snapshot 组装与详情视图 | 快照能回答当前状态并展示来源 |
| Day 5 | 真实项目样本、修正体验、演示与回归 | 用户能判断 AI 是否理解项目 |

## Day 1 验收

- 目标目录是独立 Git repo，依赖锁文件存在，`.env` 未被 Git 跟踪。
- PostgreSQL 18.6 容器通过 healthcheck，初始 Prisma migration 已应用。
- `/api/health` 对真实数据库执行查询并在成功时返回 200。
- 项目可创建、列出、读取、更新；首页提供最小创建/列表体验，详情页展示 Sources、Items、Snapshot 占位区域。
- `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm db:validate`、`pnpm db:generate` 均成功。
- 使用启动后的应用完成 health + create/list/get/patch curl smoke，并记录准确命令与结果。
