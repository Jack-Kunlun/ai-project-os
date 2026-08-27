# Snapshot 能力验收记录

日期：2026-08-26

## 实现范围

本次将同项目已确认 Item 组装为可追溯的 Project Snapshot：

- 新增 `GET /api/projects/:projectId/snapshots`，只读取 `generatedAt desc, id desc` 的最新已完成 Snapshot；没有快照时返回 `snapshot: null`，不提供历史列表或详情 API。
- 新增 `POST /api/projects/:projectId/snapshots`，严格接受 `{}`。事务第一条语句读取项目、`statement_timestamp()` 和项目 advisory lock，并使用 `RepeatableRead` 固定本次读取点；随后读取全部项目 Item，成功时原子创建 `manual/running` Scan、Snapshot 并完成 Scan。
- 只允许 `confirmed` Item 进入 payload；candidate、dismissed、superseded 会被排除。确认条目必须具有有效 `confirmedAt`、非空且精确匹配 Source 原文的 `sourceExcerpt`，否则写入失败 Scan，不创建 Snapshot。
- payload 版本为 `1`，只保留四类已确认条目和安全 provenance，不复制 Source 原文、`storageKey`、metadata 或 `supersedesItemId`。条目按 `occurredAt desc (null last)`、`confirmedAt desc`、`id asc` 排序，Focus 固定为 Issues 后 Risks，不表示优先级或 AI 判断。
- 详情页读取最新快照，展示读取点、生成时间、历史快照数量、四个 section、Focus、精确摘录、来源链接/hash 和 stale 提示。当前确认集合变化时只提示手动重新生成，不自动生成。

## 数据与并发边界

- Snapshot payload、非空 `scanId`、Snapshot 与 Scan 共用 `generatedAt`、Scan 终态时间是受支持 HTTP writer 的保证，不是数据库已完全约束的不变量；不支持直接 DB/Prisma writer。
- advisory lock 只保护遵循本 API 协议的同项目生成请求；Snapshot 是“截至 `readAt`”的历史状态，不承诺永远代表当前项目。
- 没有已确认 Item 时返回 422 `SNAPSHOT_NO_CONFIRMED_ITEMS`；确认条目 provenance 无效时返回 409 `SNAPSHOT_INVALID_CONFIRMED_ITEMS`；重叠生成返回 409 `SNAPSHOT_GENERATION_IN_PROGRESS`；事务冲突返回 409 `SNAPSHOT_GENERATION_CONFLICT`，不自动重试。
- 本阶段不包含 Snapshot 编辑、删除、历史分页/切换/详情、自动生成、幂等键、LLM、认证或 schema/migration/依赖变更。

## 初轮自动化检查（冲突修复前）

初轮 Snapshot 能力实现完成后，先执行本地自动化与数据库基础检查；当时 PostgreSQL 18.6 容器健康。

| 命令/检查 | 状态 |
| --- | --- |
| `pnpm test` | PASS，29/29 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS；Next.js 16.3.3 生产构建成功，并识别 Snapshot route |
| `pnpm db:validate` | PASS；未修改 schema |
| `pnpm db:generate` | PASS；Prisma Client 7.10.0 生成成功 |
| Prisma migrate status | PASS；2 migrations up to date |
| `git diff --check` | PASS |

## 真实冲突缺陷与修复

真实 PostgreSQL Repeatable Read 删除冲突返回 SQLSTATE `40001`。Prisma 7 的 `$queryRaw` 将该错误包装为 `P2010`，而旧 route 只识别 `P2034`，因此第一次 production HTTP 实际返回了 500 `INTERNAL_ERROR`。

修复新增精确 conflict classifier：

- `P2034` 映射为 Snapshot generation conflict；
- `P2010` 仅当 `meta.driverAdapterError.cause.originalCode === "40001"` 时映射为同一冲突；
- 其他 `P2010`、其他错误不误判。

P2034 分类由单元测试覆盖；真实生产重跑覆盖了 P2010/SQLSTATE `40001` 链路，二者证据分开记录。

## 修复后自动化复验

| 命令/检查 | 状态 |
| --- | --- |
| `pnpm test` | PASS，32/32 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS；构建识别 Snapshot route |
| `git diff --check` | PASS |

由于 schema、migration、依赖和 lockfile 未变，Prisma schema/migration checks 使用初轮已通过证据。

## 真实 PostgreSQL、HTTP 与数据验收

- health 返回 200；首次 GET 返回 `snapshot: null`。
- POST 严格接受 `{}`；extra body 返回 400 `VALIDATION_ERROR`，无 body 返回 400 `INVALID_JSON`；missing project 返回 404，invalid UUID 返回 400，DELETE 返回 405。
- confirmed 的四类 Item 均进入 Snapshot；candidate、dismissed 排除。Focus 顺序为 Issues → Risks。payload 不含 `contentText`、`storageKey`、`metadata`、`supersedesItemId`。
- 两份历史 Snapshot 均保留，GET latest 选择最新记录；其他项目数据隔离。
- 无 confirmed Item 返回 422 `SNAPSHOT_NO_CONFIRMED_ITEMS`，结果为 1 个 failed Scan、0 个 Snapshot。
- 直接破坏临时 confirmed Item 的 provenance 返回 409 `SNAPSHOT_INVALID_CONFIRMED_ITEMS`，结果为 1 个 failed Scan、0 个 Snapshot。
- 直接插入坏 payload 的 completed Snapshot 后，GET 返回 500 `SNAPSHOT_DATA_INVALID`，错误体保持安全。
- advisory lock 重叠生成返回 409 `SNAPSHOT_GENERATION_IN_PROGRESS`；已有 Snapshot 保留，未写入 running Scan 或半成品。
- 真正 SQLSTATE `40001` 链路在修复前返回 500；修复后的 production 重跑返回 409 `SNAPSHOT_GENERATION_CONFLICT`。

临时 Project A 的最终 DB 断言：current confirmed=6，latest payload=6，focus=3；5 Snapshots，null scan=0，unsafe payload=0；5 completed Scan、1 failed、0 running；Snapshot/Scan `completedAt` 时间 mismatch=0，payload `generatedAt` mismatch=0，non-completed snapshot=0。

## 浏览器验收

- desktop full-page 无溢出/遮挡。
- 390px viewport 下 `innerWidth=390`、`document/body scrollWidth=375`，无横向溢出。
- 初始 stale 提示可见；点击生成后从 4 snapshots/5 confirmed 更新为 5/6、focus=3，并清除 stale。
- 锁冲突页面显示可恢复的英文错误，且仍显示 5/6。
- Project B 生成按钮 disabled，空态与指引可见。
- console warning/error=0；验收结束后已 reset viewport 并关闭 tab。

## 初轮 Terra Max 审计

初轮 Terra Max 审计结论为 `REQUIRES_FIXES`，P1=0、P2=1。唯一 P2 是 Snapshot stored provenance 的 `externalRef` 只校验 string/null，结构合法的 `javascript:` 或带 credentials URL 可以通过严格 parser 并进入 UI 链接。

## P2 修复与最终自动化复验

修复复用 `projectSnapshotPayloadSchema` 的 `isSafeExternalRef`：非 null `externalRef` 与 Source writer 一致，限制为最长 2048 字符、无 credentials 的 `http`/`https` URL。unsafe confirmed source 使 assembly 整体失败为 `SNAPSHOT_INVALID_CONFIRMED_ITEMS`；unsafe stored payload 由 GET 稳定返回 `SNAPSHOT_DATA_INVALID`。

P2 修复后由 Sol 新鲜执行的最终自动化检查：

| 命令/检查 | 状态 |
| --- | --- |
| `pnpm test` | PASS，33/33 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| client-bundle marker `rg` | PASS；client chunks 无 Snapshot server schema/assembly/node crypto marker |
| `git diff --check` | PASS |

## P2 修复后的真实 production 复验

- 创建额外临时安全 Source 与 confirmed Item 后，直接将 Source `externalRef` 改为 `javascript:alert(1)`；POST 返回 409 `SNAPSHOT_INVALID_CONFIRMED_ITEMS`，数据库为 1 个 failed Scan、0 个 Snapshot。
- 恢复安全 URL 后 POST 返回 201；再直接将 stored Snapshot payload 的 `externalRef` 改为 `javascript:alert(1)`；GET 返回 500 `SNAPSHOT_DATA_INVALID`，错误体保持安全。
- 上述额外临时 Project/Source/Item/Snapshot 已精确删除；Project/Snapshot ID 查询结果为 0；五表再次恢复 `4|1|0|0|0`；最终 production server 与临时脚本已关闭。

## Cleanup 与交付状态

- 验收前 baseline：`4|1|0|0|0`。
- 清理前：`6|2|7|7|5`。
- Project A/B 已精确删除；Project C/D 已在删除冲突测试中删除。
- 所有临时 Project/Item/Snapshot IDs 查询结果为 0；最终恢复 baseline：`4|1|0|0|0`。
- P2 修复复验使用的额外临时 Project/Source/Item/Snapshot 也已精确删除，ID 查询结果为 0，五表再次恢复 `4|1|0|0|0`。
- server 已停止，临时脚本已删除。
- 未修改 schema、migration、依赖、lockfile、Compose 或 env；本次能力尚未 commit/push。

## 独立审计状态

初轮 Terra Max 审计已完成，结论为 `REQUIRES_FIXES`（P1=0、P2=1），上述 P2 已修复。修复后的 fresh Terra Max 独立复审结论为 `APPROVED`，P1=0、P2=0。

Fresh Terra Max 独立新鲜执行并通过：`pnpm test` 33/33、lint、typecheck、production build、`git diff --check`；client chunks 无 Zod、Snapshot assembly 或 `node:crypto` markers；只读 PostgreSQL 五表基线为 `4|1|0|0|0`。

复审未重复执行会写入临时数据的 HTTP 攻击流程，而是核对最终代码、测试、构建与文档；HTTP 攻击流程及其 cleanup 结果由 Sol 的真实复验证据提供。Snapshot 能力独立审计现已收口为 approved。
