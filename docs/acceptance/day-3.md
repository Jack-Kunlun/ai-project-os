# Day 3 验收记录

日期：2026-08-26

## 实现范围

Day 3 在详情页接入可追溯的手工 `ProjectItem`：

- `GET /api/projects/:projectId/items` 按 `updatedAt desc` 返回项目内全部条目，并仅返回安全的 Source 元数据；V0 当前全量返回、不分页。
- `POST /api/projects/:projectId/items` 创建 `decision`、`progress`、`issue`、`risk` 候选条目；必须引用同项目 Source，并提供精确非空原文摘录。
- `PATCH /api/projects/:projectId/items/:itemId` 支持严格的 `edit`、`confirm`、`dismiss`、`reopen` 状态操作；所有操作必须携带 `expectedUpdatedAt` 版本令牌，编辑保持 Source 不变并回到候选状态。
- 详情页保留 Source 列表与原文，支持 Item 创建、编辑、确认、驳回、重新打开，并展示状态、摘录、Source 链接/hash、发生时间、确认时间和更新时间。

不包含 Item 自动生成、LLM、删除 Item、Source 编辑、supersession 操作、审计日志或认证授权。商业化或大规模数据场景必须在扩展前为 Source 与 Item 列表引入 cursor pagination。`superseded` Item 仍会被 Item 列表读取且在 UI 中只读；Day 3 不提供创建或转换为 `superseded` 的动作。

## 初轮自动化检查（pre-repair，已被审计取代）

以下结果均来自本次审计修复前；不作为修复后的最终通过证据。

| 命令 | 状态 |
| --- | --- |
| `pnpm test` | PASS，20/20 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS；Next.js 生产构建成功，Items collection/nested route 与项目详情页均被识别 |
| `pnpm db:validate` | PASS |
| `pnpm db:generate` | PASS |
| `pnpm exec prisma migrate status --config prisma.config.ts` | PASS；2 migrations，database schema up to date |
| `docker compose ps` | PASS；PostgreSQL 18.6 healthy，绑定 `127.0.0.1:5433` |
| `git diff --check` | PASS |

`pnpm test`、`pnpm typecheck` 与 `pnpm build` 首次运行受到本地沙箱 IPC/文件写入权限限制；随后使用相同原命令授权重跑通过，未改变验证语义。

## 初轮数据库 catalog 与完整性 smoke（pre-repair，已被审计取代）

- `test/catalog-assertions.sql`：PASS。4 条 Project 根级 Cascade、3 条 deferred NoAction、`ProjectItem.sourceId NOT NULL`、3 个项目复合唯一索引、3 条精确复合 FK 映射及关系违规数 0 均通过。
- `test/integrity-smoke.sql`：PASS。在非空基线 `Project=4 | ProjectSource=1 | ProjectItem=0 | ProjectScan=0 | ProjectSnapshot=0` 上，同项目关系、跨项目关系拒绝、引用删除保护和项目根 Cascade 均通过；事务 `ROLLBACK` 后计数不变。

## 初轮 HTTP smoke（pre-repair，已被审计取代）

使用本机临时生产实例 `3105` 完成真实数据库请求：

| 场景 | 结果 |
| --- | --- |
| `GET /api/health` | 200 |
| 创建候选 Item | 201 |
| 跨项目 Source | 404，`SOURCE_NOT_FOUND` |
| Source excerpt 不匹配 | 422，`SOURCE_EXCERPT_MISMATCH` |
| 受保护字段、`datetime-local` 无时区、非法 UUID | 400，`VALIDATION_ERROR` |
| 缺失 Project / Item | 404 |
| 跨项目 Item | 404，`ITEM_NOT_FOUND` |
| Item 列表项目隔离与安全字段 | PASS；未泄露 `contentText`、`storageKey`、`metadata` |
| confirm、edit 后回 candidate、dismiss、reopen | PASS |
| 并发双 confirm | 一次 200，一次 409，`ITEM_INVALID_TRANSITION` |
| Item `DELETE` | 405 |
| 删除被 Item 引用的 Source | 409，`SOURCE_IN_USE` |

## 初轮浏览器验收（pre-repair，已被审计取代）

- 创建候选、确认、编辑 confirmed Item 后回到 candidate、驳回/重开、编辑时 `sourceId` 锁定均通过。
- Item 卡片展示原文摘录、Source 链接/hash、`confirmedAt`、更新时间和成功提示；选中 Source 原文可用于复制精确摘录。
- 移动端全页布局通过，控制台 warning/error 为 0。
- `datetime-local` 未使用浏览器自动化断言；带显式 offset 的时间已通过 HTTP 验证，因此不将 UI 时间交互标记为已自动化验证。

## 初轮 Cleanup 记录（pre-repair，最终状态待复验）

- 本轮创建的 2 条 Item 与 1 条 Source 已准确删除；跨项目 Source 已通过 API 删除。
- 清理后计数恢复为 `Project=4 | ProjectSource=1 | ProjectItem=0 | ProjectScan=0 | ProjectSnapshot=0`；smoke IDs 均为 0。
- 4 个既有 Project 与既有 Day 2 Source 未修改。
- 临时 production server 已停止。
- Day 3 尚未 commit/push。

## 独立审计与修复

初轮验收后，Terra Max 独立审计判定 `REQUIRES_FIXES`，指出三个 P2：项目详情接口仍返回截断且包含内部字段的 nested Items、候选条目并发编辑会静默覆盖、缺失父资源与删除竞态的错误语义不一致。修复内容如下：

- 项目详情仅返回项目字段与 `_count.items`，完整条目统一由独立 Items API 读取。
- 所有 PATCH action 强制携带 `expectedUpdatedAt`；更新同时按项目、条目、当前状态和版本条件执行，并显式推进单调 `updatedAt`。
- 过期版本稳定返回 409 `ITEM_VERSION_CONFLICT`；当前版本下不允许的动作返回 409 `ITEM_INVALID_TRANSITION`。
- collection GET/POST 和 nested PATCH 在初始检查时发现项目缺失，统一返回 404 `PROJECT_NOT_FOUND`；项目存在但 Source/Item 不存在或跨项目时分别返回 `SOURCE_NOT_FOUND` / `ITEM_NOT_FOUND`。POST/PATCH 在 Source miss、P2003、条件更新零行或最终读取失败时会重查并分类；GET 以列表读取前的父项目检查作为本次读取的线性化点，不承诺在该检查之后发生的并发删除仍返回 404。
- `sourceExcerpt` 精确非空及 `reviewStatus`/`confirmedAt` 一致性明确限定为受支持 HTTP API 写入路径的不变量；当前数据库 schema 尚未完全强制，未来引入其他 writer 前需要数据库约束与迁移。

## 修复后最终自动化检查

以下命令均在审计修复后重新完整执行：

| 命令 | 状态 |
| --- | --- |
| `pnpm test` | PASS，21/21 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS；Next.js 16.3.3 生产构建成功，项目详情、Items collection/nested route 与详情页均被识别 |
| `pnpm db:validate` | PASS |
| `pnpm db:generate` | PASS；Prisma Client 7.10.0 重新生成 |
| `pnpm exec prisma migrate status --config prisma.config.ts` | PASS；2 migrations，database schema up to date |
| `docker compose ps` | PASS；PostgreSQL 18.6 healthy，绑定 `127.0.0.1:5433` |
| `git diff --check` | PASS |

## 修复后数据库验收

- 验收前基线为 `Project=4 | ProjectSource=1 | ProjectItem=0 | ProjectScan=0 | ProjectSnapshot=0`。
- `test/catalog-assertions.sql`：PASS。根级 Cascade、deferred NoAction、`ProjectItem.sourceId NOT NULL`、复合唯一索引、复合 FK 映射及关系违规数均符合断言。
- `test/integrity-smoke.sql`：PASS。同项目关系、三类跨项目关系拒绝、三类引用删除保护与项目根 Cascade 均通过；事务 `ROLLBACK` 后固定 ID 和五表计数不变。

## 修复后 HTTP smoke

使用本机临时生产实例 `127.0.0.1:3106` 和真实 PostgreSQL 完成：

| 场景 | 结果 |
| --- | --- |
| 健康检查 | 200，数据库 `up` |
| 项目详情 Item 旁路 | PASS；只返回 `_count.items`，没有 nested `items` |
| 请求开始时已缺失的父项目 | collection GET/POST 与 nested PATCH 均为 404 `PROJECT_NOT_FOUND`；此项不宣称 GET 会对初始检查后的并发删除做后置重查 |
| 跨项目 Source / Item | 404 `SOURCE_NOT_FOUND` / `ITEM_NOT_FOUND` |
| 严格输入校验 | PASS；受保护字段、无 offset 时间、缺失或无 offset 的版本令牌、非法 UUID 均为 400 `VALIDATION_ERROR` |
| Source 摘录不匹配 | 422 `SOURCE_EXCERPT_MISMATCH` |
| Item 安全投影 | PASS；不返回 Item `metadata`/`supersedesItemId` 或 Source `contentText`/`storageKey`/`metadata` |
| 两次同版本候选编辑 | 一次 200，一次 409 `ITEM_VERSION_CONFLICT`；最终标题等于成功写入者，失败写入未覆盖 |
| 旧版本与非法状态 | 旧版本为 `ITEM_VERSION_CONFLICT`；当前版本下重复 confirm/dismiss 为 `ITEM_INVALID_TRANSITION` |
| confirm、edit、dismiss、reopen | PASS；编辑 confirmed Item 后回 candidate，非 confirmed 状态的 `confirmedAt` 为 null |
| 两次同版本 confirm | 一次 200，一次 409 `ITEM_VERSION_CONFLICT` |
| Item `DELETE` / 删除被引用 Source | 405 / 409 `SOURCE_IN_USE` |

## 修复后浏览器验收

- 真实页面完成 candidate→confirmed、编辑 confirmed Item 后回 candidate、dismiss、reopen；成功提示与状态、确认时间同步更新。
- 编辑表单中的 Source 下拉框保持 disabled，Source 归属不可更换；原文、精确摘录、链接与 SHA-256 均可见。
- 完整桌面页面截图检查无溢出或遮挡，浏览器 console warning/error 为 0。
- `datetime-local` 未使用浏览器自动化断言；带显式 offset 的时间与版本令牌已通过 HTTP 验证。

## 修复后 Cleanup 与最终状态

- HTTP/browser smoke 使用 Project A `12d1fcce-0056-4baa-b620-93ff4beced36` 与 Project B `769766e5-8c64-4e9a-97d7-180ab1be5c89`。
- 精确删除 smoke Item `fb2654cf-6ee9-4885-a23a-47abdb4f8f89` 与 Source `0071fb3b-f136-44cb-9dac-b1707fdb71bc`；跨项目 Source `71d90eb6-eba6-4cc6-99a6-200643997fa6` 已由 API 删除。
- 清理后五表计数恢复为 `4|1|0|0|0`，上述 smoke Item/Source ID 计数均为 0；4 个既有 Project 与既有 Day 2 Source 未修改。
- 临时 production server 与浏览器标签已关闭。Source 引用保护测试在服务端产生一条预期 Prisma FK 日志，客户端仅收到稳定的 409 `SOURCE_IN_USE`。
- Day 3 仍未 commit/push。

## 数据与安全边界

本阶段未改变 schema、migration、依赖、Compose 或环境配置。Item API 对外只返回稳定错误 code/message；页面不使用 `dangerouslySetInnerHTML`，Source 原文通过 React 文本节点渲染。

## 修复后复验状态

- Sol 已完成并记录修复后的自动化检查、真实数据库 catalog/integrity smoke、HTTP smoke、浏览器复验与精确清理。
- Terra Max 已独立执行 `pnpm test`（21/21）、`pnpm typecheck`、`git diff --check`，并确认初轮三个代码 P2 均已修复、没有代码 P1/P2；首次修复后复审指出的两处验收文档表述已更正，窄范围复核结论为 `APPROVED`，P1/P2 均为 0。
