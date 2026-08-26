# Day 2 验收记录

日期：2026-08-26

## 实现范围

Day 2 只接入手工 `ProjectSource` 候选资料：

- `GET /api/projects/:projectId/sources`：项目内按 `ingestedAt desc` 列出全部 Source，不返回 `storageKey`；V0 暂不分页。
- `POST /api/projects/:projectId/sources`：只接受原始内容、可选无凭据 HTTP(S) 链接和资料时间；服务端固定 `kind=manual`，按实际 UTF-8 原文计算 SHA-256。
- `DELETE /api/projects/:projectId/sources/:sourceId`：只允许删除未被 Item 引用的候选资料；不存在或不属于该项目时统一返回资源级 404 `SOURCE_NOT_FOUND`。
- 详情页提供手工录入、hash/原文追溯和删除确认；预览是确定性截取，不是 AI 摘要。

不包含上传、OCR、网页/GitHub 抓取、LLM、Item 自动生成、Source PATCH、版本链、审计日志或认证授权。

## P2 修复记录

- P2-1 已修复：`capturedAt` 现在只接受带 `Z` 或显式 UTC offset 的 ISO datetime；无时区输入已加入单测，真实 HTTP 返回 400 且未写入。
- P2-2 已修复：GET Source 已移除静默 100 条上限，确保 V0 项目内全部 Source 可见；当前不分页，商业化/大规模场景必须先引入 cursor pagination。
- P2-2 使用真实 HTTP 创建 101 条唯一 Source 复验：101 条均为 201，GET 返回 101 条、项目 `_count.sources` 为 101，且未暴露 `storageKey`；随后按本批返回 ID 精确删除 101 条，全部为 204，项目恢复到执行前 0 条基线。

## Batch A：后端、校验与 SQL

以下命令已实际执行：

| 命令 | 状态 |
| --- | --- |
| `pnpm test` | PASS，13/13 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |

单测与类型检查首次运行分别受到沙箱 IPC 管道和 `tsconfig.tsbuildinfo` 写入限制；授权重跑后通过。未在 Batch A 执行数据库写入 smoke、build 或迁移命令。

## Batch B：详情页与文档

| 命令 | 状态 |
| --- | --- |
| `pnpm test` | PASS，13/13 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS；Next.js 生产构建成功，Source collection/nested route 均被识别为动态路由 |

## Sol 最终验收

### 项目级与数据库检查

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | PASS，13/13 |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS，Source collection 与 nested DELETE route 均为动态路由 |
| `pnpm db:validate` | PASS |
| `pnpm db:generate` | PASS |
| `pnpm prisma migrate status --config prisma.config.ts` | PASS，2 migrations，database schema up to date |
| `docker compose ps` | PostgreSQL healthy，仍绑定 `127.0.0.1:5433` |

`test/catalog-assertions.sql` 在真实数据库通过：4 条 Project 根级 Cascade、3 条 deferred NoAction、`ProjectItem.sourceId NOT NULL`、3 个项目复合唯一索引、3 条复合 FK 的源列/目标列顺序以及关系违规数 0 均符合预期。

`test/integrity-smoke.sql` 在非空基线上通过。执行前后计数均为：

```text
Project=4
ProjectSource=1
ProjectItem=0
ProjectScan=0
ProjectSnapshot=0
```

固定 smoke ID 在写入前不存在；事务内同项目关系、三类跨项目 23503、三类引用删除保护和项目根 Cascade 均通过；`ROLLBACK` 后五表计数不变且固定 ID 无残留。

### HTTP smoke

使用本机临时生产构建完成真实数据库请求：

| 场景 | 结果 |
| --- | --- |
| Project A 创建手工 Source | 201 |
| Project A 重复提交完全相同原文 | 409，`SOURCE_CONTENT_DUPLICATE` |
| Project B 保存与 A 相同原文 | 201；两个 Source hash 相同，证明去重范围限定在项目内 |
| A/B 分别列出 Source | 200；只包含各自 Source，且未返回 `storageKey` |
| 用 Project B 路径删除 A 的 Source | 404，`SOURCE_NOT_FOUND` |
| 空白内容、带凭据 URL、未知字段、非法 UUID | 400，`VALIDATION_ERROR` |
| 不存在的 Project / Source | 404 |
| 删除被临时测试 Item 引用的 Source | 409，`SOURCE_IN_USE`；Source 未删除 |
| 删除未引用 Source | 204；随后列表为空 |
| 无时区 `capturedAt` | 400，`VALIDATION_ERROR`；未写入 |
| 101 条批量列表复验 | 创建 101/101、GET 101、项目计数 101、`storageKey` 未暴露；删除 101/101 后回到原基线 |

用于 `SOURCE_IN_USE` 的固定测试 Item 在验收后被精确删除；未删除或修改既有 Project。

### 浏览器验收

在本机开发页面完成：

- 已有 Source 的 manual 标签、资料/接入时间、安全外链、完整 SHA-256、确定性预览和原文展开均可见。
- 表单保存新 Source 后，指标卡和列表计数同步刷新；完成态提示为“候选资料已保存。”。
- 重复原文显示后端稳定冲突消息，列表不增加重复项。
- 删除按钮触发永久删除确认；删除后计数恢复，完成态提示为“候选资料已删除。”。
- 页面控制台 warning/error 为 0；桌面完整页面布局检查通过。

最终数据库保留 1 条明确标识的 Day 2 HTTP smoke Source，其他子表为 0；它用于证明后续 integrity smoke 可在非空 Source 基线上运行。

## 数据与安全边界

测试和验收只使用明确创建的 Source；没有删除既有 Project 或其他既有数据。文档不记录数据库连接串、密码、Token 或真实敏感原文。项目 ID 隔离是数据边界，不代表认证授权。
