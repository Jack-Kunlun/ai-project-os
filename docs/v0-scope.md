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

Day 1 交付项目容器、数据库 schema、健康检查、项目 CRUD 和基础页面。Day 2 在详情页接入手工 `ProjectSource` 候选资料：保存原始内容、精确 SHA-256、可选无凭据 HTTP(S) 链接和资料时间，并支持项目内列表与未引用来源删除。Day 3 在详情页接入手工 `ProjectItem`：支持四类条目、精确 Source 摘录、候选/确认/驳回/重新打开状态和受保护的编辑流程。Day 4 在同项目 Repeatable Read 读取点内，将全部已确认 Item 确定性组装成一份带 Scan 追溯的不可变 Snapshot，并在详情页展示最新状态与来源。Source 与 Item 都是可追溯的候选输入，只有人工确认的 Item 才能进入 Snapshot。

Day 1 的最终验收记录（包括真实 HTTP smoke、catalog 断言和事务完整性 smoke）见 [docs/acceptance/day-1.md](acceptance/day-1.md)。

## 非目标

V0 不接入 LLM、GitHub 实时连接、文件上传、认证、多用户/RBAC、队列、pgvector、MCP、Action Engine、PR Review、自动改代码、自动修 Bug、创建 PR、复杂 evidence graph、完整 current-state 冲突引擎或正式飞书接入。

## 数据原则

- 原始输入先作为候选资料，不能直接等同于可信记忆。
- `ProjectSource` 保存来源类型、可选外部引用、原始内容和精确 SHA-256；`ProjectItem.sourceId/sourceExcerpt` 保留可追溯入口。V0 Source 与 Item 列表当前均全量返回、不分页；商业化或大规模数据场景必须先为两类列表引入 cursor pagination，不承诺无限规模可扩展。
- Day 2 只接受手工原始资料，服务端固定 `kind=manual`；精确 hash 用于同项目完全重复检测，不做近似或语义去重。
- `ProjectItem.sourceId` 在数据库层为必填，并且 Item→Source、Item→supersedes、Snapshot→Scan 都通过 `[projectId, foreignId] -> [projectId, id]` 复合外键限制为同项目关系。
- `sourceExcerpt` 的精确非空校验，以及 `reviewStatus`/`confirmedAt` 的一致性，是当前受支持 HTTP API 写入路径的不变量；不支持直接 DB/Prisma 写入，schema 尚未完全强制这些语义。未来引入其他 writer 前，需补充数据库约束和迁移。
- Snapshot 的 payload、非空 `scanId`、Snapshot 与 Scan 共用 `generatedAt`、以及 Scan 的终态时间，是当前 Snapshot HTTP writer 的保证，不是数据库已完全约束的语义；不支持直接 DB/Prisma writer。生成过程使用项目范围的事务 advisory lock，但该锁只保护遵循本 API 协议的并发生成。Snapshot 是“截至 `readAt`”的历史状态，不承诺永远代表当前项目。
- 上述三条跨子表关系在 PostgreSQL 中是 `NoAction`、`DEFERRABLE INITIALLY DEFERRED`：默认在事务结束检查，或用 `SET CONSTRAINTS ... IMMEDIATE` 提前检查；项目根关系仍为 Cascade。Prisma 7 PSL 不表达 deferrable，因此该属性由增量迁移中的 PostgreSQL-only SQL 保留。
- Event/history 与 current state 的完整治理不在 Day 1 实现；schema 预留 scan、snapshot 和 supersession 关系。
- 不把当前“不做付费会员”等产品范围限制硬编码进基础模型。

## 5 天计划

| 天数 | 交付 | 验收焦点 |
| --- | --- | --- |
| Day 1 | Next.js 单体骨架、PostgreSQL、Prisma schema、Project CRUD、基础页面 | 真实 DB ready，CRUD 与项目级检查全绿 |
| Day 2 | Source 手动录入、项目内列表与未引用删除 | 候选来源可保存，内容与 hash 可追溯 |
| Day 3 | ProjectItem 候选列表、确认/编辑状态 | decision/progress/issue/risk 可被用户确认 |
| Day 4 | Snapshot 组装与详情视图 | 快照能回答当前状态并展示来源 |
| Day 5 | 真实项目样本、修正体验、演示与回归 | 用户能判断 AI 是否理解项目 |

## Day 1 验收

- 目标目录是独立 Git repo，依赖锁文件存在，`.env` 未被 Git 跟踪。
- PostgreSQL 18.6 容器通过 healthcheck，初始 Prisma migration 已应用。
- `/api/health` 对真实数据库执行查询并在成功时返回 200。
- 项目可创建、列出、读取、更新；首页提供最小创建/列表体验，详情页通过独立 API 展示 Sources、Items 与 Day 4 最新 Snapshot。
- `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm db:validate`、`pnpm db:generate` 均成功。
- 使用启动后的应用完成 health + create/list/get/patch curl smoke，并记录准确命令与结果。

## Day 2 边界

- 已实现 `GET`、`POST`、`DELETE` Source API 与详情页手工录入/列表/删除交互；删除前需要确认，数据库引用中的 Source 会被拒绝删除。Source 不存在或不属于当前项目时统一返回资源级 404 `SOURCE_NOT_FOUND`，不用于泄漏其他项目归属。
- 不包含上传、OCR、网页或 GitHub 抓取、LLM 摘要、Item 自动生成、Source PATCH、版本链、审计日志或认证授权。
- 项目 ID 隔离用于数据边界，不代表用户权限控制。

## Day 3 边界

- 已实现 `GET`、`POST`、`PATCH` Item API 与详情页 Item 列表、手工创建、编辑、确认、驳回和重新打开交互；Item 必须引用同项目 Source，并保存精确非空 `sourceExcerpt`。
- Item 支持 `decision`、`progress`、`issue`、`risk` 四种类型；编辑会回到 `candidate`，且不可更换 `sourceId`。确认、驳回和重新打开均按当前审核状态条件更新，并返回稳定的状态冲突错误。
- Item 列表只展示安全的 Source 元数据（链接、hash、时间），不返回 `contentText`、`storageKey` 或内部 `metadata`；详情页选中的 Source 原文仅用于人工复制精确摘录。
- V0 当前全量返回 Item、不分页；商业化或大规模数据场景必须先引入 cursor pagination。
- `superseded` Item 会继续被 Item 列表读取且在 UI 中只读；Day 3 不提供创建或转换为 `superseded` 的动作。
- 所有 PATCH action 都要求 `expectedUpdatedAt`；版本过期返回 `ITEM_VERSION_CONFLICT`，与非法状态转换的 `ITEM_INVALID_TRANSITION` 区分。
- 不包含 Item 自动生成、LLM、Source 编辑、删除 Item、supersession 操作、审计日志或认证授权。项目 ID 隔离用于数据边界，不代表用户权限控制。

## Day 4 边界

- 已实现 `GET`、`POST` `/api/projects/:projectId/snapshots`。POST 在 Repeatable Read 与项目范围事务 advisory lock 内读取全部同项目 Item，只组装 `confirmed` 条目，并以 `manual` Scan 原子记录 Snapshot；同项目重叠生成返回 `SNAPSHOT_GENERATION_IN_PROGRESS`，数据库事务冲突返回可重试的 `SNAPSHOT_GENERATION_CONFLICT`。
- Snapshot payload 只保留项目字段、读取/生成时间、四类已确认条目及安全 provenance（Source ID、类型、链接、hash、时间、精确摘录）；不复制 Source 原文、内部 metadata、storageKey 或 supersession 字段。条目按发生时间、确认时间、ID 确定性排序，Focus 固定为 Issues 后 Risks，不表示优先级或 AI 判断。
- 详情页读取并展示最新已完成 Snapshot；当前确认集合发生新增、移除或重新确认时仅提示手动重生成，不自动生成。历史 Snapshot 可保留在数据库，但 V0 不提供历史列表、切换、详情、编辑或删除。
- 没有已确认 Item 或确认 Item provenance 无效时，API 分别记录稳定错误的失败 Scan，且不创建 Snapshot。Snapshot payload、`scanId`、Scan 终态时间和共用 `generatedAt` 是受支持 HTTP writer 的保证，数据库尚未完全约束；不支持直接 DB/Prisma writer，advisory lock 也只保护遵循该 API 协议的调用。
- Day 5 继续聚焦真实项目样本、修正体验、演示与回归；历史治理、数据库约束、分页与 current-state 冲突/修正能力属于后续范围。
