# AI Project OS

AI Project OS 是一个可本地部署的项目记忆工作台：把项目资料整理成可追溯的 Project Snapshot，帮助用户回看项目当前状态、最近进展、问题、风险和关键决策。

当前网页同时提供确定性的人工工作流和受治理的 AI 候选审阅工作台。仓库已经具备固定模型策略、显式 Source 授权、模型传输适配器、确定性分块、pgvector 索引和候选原子发布能力；真实外部传输执行入口仍保持关闭，因此当前部署不会自动调用 LLM 或发送项目内容。每条进入 Snapshot 的内容都必须由用户确认，并保留对应的 Source 和精确摘录。

项目记忆持久化在 PostgreSQL 中：原始 Source、人工确认和纠错后的 Item，以及不可变的 Snapshot 共同组成可追溯的项目状态记录。

## 产品定位

Project 是资料、事实条目和状态快照的容器。Source 保存原始候选资料，Item 把用户从资料中整理出的事实分为 decision、progress、issue、risk 四类，Snapshot 则固定保存某个读取点的已确认状态。

## 当前能力

| 能力 | 当前行为 |
| --- | --- |
| 项目容器 | 创建、列表、读取、更新项目及统计信息 |
| Source | 手工保存原始内容、来源链接、资料时间和 SHA-256；同项目重复内容会被拒绝 |
| Item | 手工创建四类候选条目，要求同项目 Source 与精确非空摘录 |
| 审核 | 人工编辑、确认、驳回、重新打开；编辑已确认条目会回到候选状态 |
| AI 候选 | 模型候选以可见 Item 进入人工队列；可在接受前修订字段，不能更换来源与精确摘录 |
| AI 治理 | 本机 CLI 配置固定模型、显式 Source 范围和到期授权；网页只读展示安全状态 |
| 语义索引基础 | 确定性分块、pgvector 存储、可恢复构建和项目级原子发布；尚未开放产品检索入口 |
| Snapshot | 只组装已确认 Item，按确定性顺序保存不可变读取点和 provenance |
| 修正 | 修改内容后提示旧 Snapshot 已过期，人工复核、重新确认并手动生成新 Snapshot |

## 人工工作流

1. 手工录入一条 Source，保留原始内容和来源信息。
2. 从 Source 中人工创建候选 Item，选择类型并粘贴精确原文摘录。
3. 对标题、内容、发生时间和摘录进行核对，确认或驳回候选。
4. 需要修正时编辑 Item；它会回到候选状态，必须重新确认。
5. 手动生成 Project Snapshot；Snapshot 只包含当时已确认且 provenance 有效的 Item。
6. 资料或确认集合变化后，查看 stale 提示并按需重新生成最新读取点。

## 当前限制与非目标

- 外部模型传输执行入口尚未开放，因此不提供真实自动抽取、自动摘要、语义搜索或 RAG 查询。
- 暂不接入 GitHub 或飞书实时连接、文件上传、OCR、队列、MCP 或 Action Engine。
- 暂无认证、授权、多用户和 RBAC；项目 ID 隔离是数据边界，不是访问控制。
- Source 与 Item 列表当前全量返回、不分页，不承诺无限规模扩展。
- 页面和 API 只提供最新 Snapshot 的读取；历史 Snapshot 可保留在数据库，但暂无历史列表、切换、编辑或删除界面。
- 关键语义约束由当前受支持的 HTTP writer 保证，数据库尚未完全表达所有状态一致性；不支持直接 DB/Prisma writer。

## 本地开发

要求：Node.js 24+、pnpm 10+、Docker Desktop。

```bash
pnpm install
cp .env.example .env
# 编辑 .env：设置 POSTGRES_PASSWORD 和宿主机使用的 DATABASE_URL（不要提交 .env）
docker compose config --quiet
docker compose up -d
pnpm db:migrate --name init
pnpm dev
```

`.env.example` 只提供变量名和非敏感的本地默认用户/数据库名，不包含可用密码或完整连接串。宿主机上的 `DATABASE_URL` 应指向 `127.0.0.1:5433`；未设置 `POSTGRES_PASSWORD` 时，Compose 会明确失败。`.env` 已被 Git 忽略。

`AI_ENABLED` 默认且当前应保持为 `false`，`OPENAI_API_KEY` 示例值为空。仓库已具备受控 provider transport、运行时审计和候选原子发布能力，但没有开放真实外部传输的执行入口；仅配置 key 不代表自动抽取、Embedding 或 V1 已经可用。

受控 AI 策略和模型处理授权只能通过本机 CLI 写入；应用没有身份认证，因此不提供对应的 HTTP 写接口。配置前先从项目 Source 列表取得明确的 `projectId` 和 `sourceId`，然后显式确认所选内容未来可能发送给 OpenAI：

```bash
pnpm project-ai:config -- status --project-id <projectId>
pnpm project-ai:config -- configure \
  --project-id <projectId> \
  --source-id <sourceId> \
  --acknowledge-external-model-transfer selected-project-sources-to-openai:v1
pnpm project-ai:config -- revoke --project-id <projectId>
```

`configure` 会重新计算并核对 Source 指纹、执行本地敏感信息扫描，并为固定的自动抽取与 Embedding 操作生成 30 天授权；重复执行相同命令是幂等的，改变 Source 集合会撤销旧授权。CLI 只输出安全状态，不输出 Source 内容或凭据。当前执行状态仍固定返回 `EXTERNAL_TRANSFER_NOT_ENABLED`，所以这些命令不会调用 OpenAI，也不会发送任何项目内容。

应用默认运行在 <http://localhost:3000>。

## 本地 Docker 部署

如果要在本机以生产构建运行当前应用（PostgreSQL、一次性 Prisma 迁移和 Next.js 应用），确认 `.env` 已设置 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB` 和宿主机使用的 `DATABASE_URL`，然后执行：

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

Compose 会先等待 `postgres` 健康，再运行一次 `prisma migrate deploy`；迁移成功后启动 `app`。应用通过 <http://127.0.0.1:3000> 提供服务，`APP_PORT` 可在 `.env` 中改为其他本机端口。PostgreSQL 仍只绑定到 `127.0.0.1:5433`，数据保存在名为 `ai-project-os-pgdata` 的本地卷中。

Compose 内的应用和迁移服务使用 `postgres:5432` 作为数据库主机，并从 `POSTGRES_*` 变量构造连接串；宿主机上的 `DATABASE_URL` 仍应使用 `127.0.0.1:5433`。当前写法要求 `POSTGRES_PASSWORD` 为 URL-safe 字符。如果密码包含 `@`、`:`、`/`、`?`、`#`、`%` 等 URL 保留字符，请在连接串中进行 URL 编码，或改为在 Compose 两个服务中提供显式的容器内 `DATABASE_URL`，不要把未编码的密码直接拼进 URL。

更新镜像或代码后再次执行 `docker compose up -d --build`；只重启应用可执行 `docker compose restart app`。不要使用 `docker compose down -v`，因为它会删除本地数据库卷和数据。

## 验证

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm db:validate
pnpm db:generate
git diff --check
```

## API

- `GET /api/health`：真实执行一次 `SELECT 1`，数据库可用时返回 200。
- `GET /api/projects`：按更新时间列出项目。
- `POST /api/projects`：创建项目，必填 `name`，可选 `slug` 与 `description`。
- `GET /api/projects/:projectId`：读取项目详情与统计。
- `PATCH /api/projects/:projectId`：更新 `name`、`slug` 或 `description`。
- `GET /api/projects/:projectId/sources`：按接入时间倒序列出候选资料，不返回 `storageKey`。
- `POST /api/projects/:projectId/sources`：手工保存原始候选资料，服务端计算 SHA-256；同项目重复内容返回 409。
- `DELETE /api/projects/:projectId/sources/:sourceId`：仅删除未被 Item 引用的候选资料。
- `GET /api/projects/:projectId/items`：按 `updatedAt desc` 列出 Item，返回安全的 Source 元数据。
- `POST /api/projects/:projectId/items`：手工创建四类候选 Item，必须提供同项目 Source 和精确摘录。
- `PATCH /api/projects/:projectId/items/:itemId`：携带 `expectedUpdatedAt` 执行编辑、确认、驳回或重新打开。
- `GET /api/projects/:projectId/snapshots`：读取最新一份已完成 Snapshot；没有 Snapshot 时返回 `null`。
- `POST /api/projects/:projectId/snapshots`：在一致读取点内，将已确认 Item 组装成手工 Snapshot 并记录 Scan。
- `GET /api/projects/:projectId/ai-memory`：只读返回受控 AI 策略、授权范围、候选数和运行时配置状态；不返回 Source 内容或凭据。
- `GET /api/projects/:projectId/ai-memory/candidates`：按审阅状态读取模型候选及其可见 Item；支持严格的 `reviewStatus` 与 `take` 查询参数。
- `PATCH /api/projects/:projectId/ai-memory/candidates/:candidateId`：携带 Item 的 `expectedItemUpdatedAt` 接受或驳回候选；接受时允许人工修订类型、标题、内容和发生时间。

所有输入使用 Zod 校验；错误响应返回稳定的 `code` 与面向调用方的消息，不回显连接字符串或内部异常。

## 数据边界

`ProjectItem.sourceId` 在数据库中是必填字段；Item→Source、Item→supersedes 和 Snapshot→Scan 使用同项目复合外键，避免跨项目引用。项目根关系仍可级联清理子记录。PostgreSQL 迁移保留 `DEFERRABLE INITIALLY DEFERRED` 约束，而 Prisma schema 本身不表达该扩展。

`sourceExcerpt` 的精确非空校验，以及 `reviewStatus`/`confirmedAt` 的一致性，是当前 HTTP 写入路径的不变量；AI 候选只能通过专用审阅接口推进，通用 Item 编辑或状态接口会拒绝关联候选，避免绕过候选状态机。Snapshot payload、`scanId`、Scan 终态时间和共用 `generatedAt` 也由当前 Snapshot writer 保证。生成过程使用项目范围的事务 advisory lock，但只保护遵循本 API 协议的调用。

数据库迁移文件在 `prisma/migrations`。如需重建本地数据库，`docker compose down -v` 会删除本地开发数据，必须明确确认后再执行。

## Project Snapshot 演示工具

长期演示使用 AI Project OS 自身的公开原型内容，不包含私密信息、真实凭据或带凭据 URL。脚本只允许访问 loopback 根地址，并通过现有 HTTP API 创建一个临时 Project、两条 manual Source、四条 candidate Item，逐条确认后生成 Snapshot：

```bash
pnpm project-snapshot:demo -- seed --base-url http://localhost:3000
```

命令会输出 `projectId`、`slug`、`browserUrl` 和精确 cleanup 命令。打开地址后核对四类条目、Focus（Issues 后 Risks）和每条 provenance；编辑 progress 条目的标题、内容和精确摘录后重新确认并生成最新 Snapshot。

演示结束后，只使用 seed 输出的精确参数清理临时 Project：

```bash
pnpm project-snapshot:demo -- cleanup --project-id <seed 输出的 projectId> --slug <seed 输出的完整 slug>
```

cleanup 会核验精确 projectId、完整 slug、稳定 demo name/marker，并且只删除该 Project 根；不要使用名称前缀、模糊匹配或批量删除。完整历史流程和真实验收结果见 [Project Snapshot 演示验收记录](docs/acceptance/correction-demo.md)。

## 历史验收材料

历史记录保留当时的日期、命令和验收事实，不代表当前产品范围；文件按已验收能力命名：

- [项目基础验收记录](docs/acceptance/project-foundation.md)
- [Source 能力验收记录](docs/acceptance/source-provenance.md)
- [Item 能力验收记录](docs/acceptance/item-review.md)
- [Snapshot 能力验收记录](docs/acceptance/snapshot-consistency.md)
- [Project Snapshot 演示验收记录](docs/acceptance/correction-demo.md)
