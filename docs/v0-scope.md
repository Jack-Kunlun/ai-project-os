# AI Project OS V0 历史范围

> 本文保留 V0 发布时的范围与验收事实，不代表当前产品能力。当前版本与运行方式见 [README](../README.md) 和 [V1 本机运行手册](v1-operations.md)。

## 定位

AI Project OS V0 是面向单项目的人工、可追溯 Project Snapshot 工作台。它把用户提供的原始资料整理成可回看的项目状态读取点，用于核对项目最近进展、问题、风险和关键决策。

V0 是确定性的项目状态记录工具，不调用 LLM，也不自动抽取、总结、纠错或判断优先级。项目记忆持久化在 PostgreSQL 中，由原始 Source、人工确认和纠错后的 Item，以及不可变 Snapshot 组成；只有人工核对并确认的 Item 才能进入 Snapshot。

## 当前能力

- Project：创建、列表、读取、更新项目，并显示 Source、Item、Scan、Snapshot 统计。
- ProjectSource：手工保存原始候选资料、来源类型、可选无凭据 HTTP(S) 链接、资料时间和精确 SHA-256；同项目完全重复内容会被拒绝。
- ProjectItem：手工创建 decision、progress、issue、risk 四类候选条目，保存同项目 `sourceId` 和精确 `sourceExcerpt`。
- 审核流转：人工编辑、确认、驳回、重新打开；编辑已确认 Item 后会回到 candidate，并要求重新确认。
- ProjectSnapshot：在一致读取点内只组装已确认 Item，按确定性顺序保存不可变 payload、Scan 和 provenance。
- 修正体验：确认集合变化后标记 stale；用户核对 Source 原文、重新确认并手动生成新的 Snapshot。

## 人工工作流

```text
手工录入 Source
      ↓
人工创建候选 Item
      ↓
核对原文摘录并人工确认
      ↓
手动生成 Project Snapshot
      ↓
资料或条目变化后复核 stale，并按需重新生成
```

Source 是候选输入，不直接等同于可信事实。用户需要在 Item 中选择同项目 Source，粘贴精确的连续原文摘录，再决定是否确认。Snapshot 只表示生成时已确认的集合，不会自动覆盖历史读取点。

## 数据原则

- 原始输入先作为候选资料保存，任何状态判断都必须能回溯到 `ProjectSource`。
- `ProjectSource` 保存原始内容和 SHA-256；Item 的 `sourceId` 与 `sourceExcerpt` 保留来源入口和可核对文本。
- Source 与 Item 列表当前全量返回、不分页；商业化或大规模场景必须先引入 cursor pagination。
- Source 当前只接受手工原始资料，服务端固定 `kind=manual`；精确 hash 只用于同项目重复检测，不做近似或语义去重。
- `ProjectItem.sourceId` 在数据库层为必填；Item→Source、Item→supersedes、Snapshot→Scan 使用 `[projectId, foreignId] -> [projectId, id]` 复合外键限制为同项目关系。
- PostgreSQL 迁移保留 `NoAction`、`DEFERRABLE INITIALLY DEFERRED` 约束；Prisma 7 schema 不表达 deferrable，因此该属性由迁移 SQL 保留。
- `sourceExcerpt` 的精确非空校验、`reviewStatus`/`confirmedAt` 一致性，以及 Snapshot payload、`scanId`、Scan 终态时间和共用 `generatedAt`，由当前受支持的 HTTP writer 保证，数据库尚未完全表达所有语义。
- Snapshot 生成使用项目范围的事务 advisory lock，但只保护遵循本 API 协议的并发调用；Snapshot 是截至 `readAt` 的历史状态，不承诺永远代表当前项目。

## 已知限制与非目标

- 不调用 LLM，不提供自动抽取、自动摘要、自动纠错、语义检索或优先级判断。
- 不接入 GitHub 或飞书实时连接、文件上传、OCR、队列、pgvector、MCP、Action Engine、PR Review 或自动修改代码。
- 不提供认证、授权、多用户或 RBAC；项目级隔离只用于数据边界，不是权限控制。
- 不提供 Snapshot 历史列表、切换、详情、编辑或删除界面；历史行可以保留在数据库。
- 不提供 Item 删除、supersession 操作、Source 编辑、完整 current-state 冲突引擎或完整 correction engine。
- 关键状态不变量依赖当前 HTTP writer，不支持直接 DB/Prisma writer；引入其他 writer 前需补充数据库约束和迁移。
- 长期演示脚本只用于本机 loopback 的开发验收，不是面向用户的“加载演示数据”产品功能。

## 历史验收材料

以下文件记录能力建设过程中的历史日期、命令和验收事实；它们不改变当时的 V0 范围，文件按已验收能力命名：

- [项目基础验收记录](acceptance/project-foundation.md)
- [Source 能力验收记录](acceptance/source-provenance.md)
- [Item 能力验收记录](acceptance/item-review.md)
- [Snapshot 能力验收记录](acceptance/snapshot-consistency.md)
- [Project Snapshot 演示验收记录](acceptance/correction-demo.md)
