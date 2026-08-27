# AI Project OS

AI Project OS V1 是一个可本地部署、单用户使用的受治理项目记忆工作台：把人工资料和多个 GitHub 仓库整理成可追溯的证据快照，支持人工事实确认、向量索引和跨仓库混合检索。

网页提供确定性的人工工作流和 AI 候选审阅工作台，但不会自动向外发送项目内容。GitHub 同步、模型授权、Embedding 索引、快照发布和检索都通过本机 CLI 执行；调用 OpenAI 的命令还要求运行时开关、固定 provider、有效凭据和每次命令中的精确授权文本。每条进入人工 Project Snapshot 的内容都必须由用户确认，并保留对应 Source 和精确摘录。

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
| GitHub 多仓库 | 本机只读连接多个明确授权的仓库；冻结 commit 后扫描代码，并同步 metadata、README、Markdown、Issue、PR 和 Release 中明确启用的资料 |
| 向量记忆 | 对人工资料、仓库代码和仓库资料进行确定性分块；经逐次授权后调用固定 OpenAI Embedding profile，并把单位化向量原子发布到 pgvector 索引 |
| 混合检索 | 在当前合格 RAG Snapshot 内融合 CJK、标识符、路径、精确子串和 pgvector 结果；支持人工资料或多个必需仓库，返回不可变来源引用 |
| RAG、摘要与分析边界 | 已实现固定模型请求计划、响应验证、引用、冲突、拒答规则和可失效持久化合同；V1 不开放这些生成操作的真实网络执行入口 |
| 只读记忆智能体 | 已实现只允许项目读取、记忆搜索、Source 与 Snapshot 读取的规划和校验边界；V1 不开放生产模型 planner/executor |
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

- 自动抽取、生成式摘要、项目分析、RAG 回答和智能体 planner 只有经过验证的合同与持久化边界，V1 不开放真实网络执行入口；模型候选不会自动成为项目事实。
- Embedding 索引和查询向量生成仅由本机 CLI 在逐次显式授权后执行。验收不会代替用户发送真实私有资料，也不会自动产生 provider 费用。
- 搜索只提供本机 CLI；网页和未认证 HTTP API 不返回仓库身份、检索正文或精确引用。没有合格 Snapshot 时会明确拒绝查询。
- GitHub 是按命令触发的只读快照同步，不是实时连接；不支持 GitHub 写操作、飞书、文件上传、OCR、队列、MCP 或 Action Engine。
- 暂无登录认证、访问授权、多用户和 RBAC；项目 ID 隔离是数据边界，不是访问控制。
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

`AI_ENABLED` 和 `GITHUB_ENABLED` 默认都是 `false`，示例凭据为空。网页在任何情况下都不会据此自动外发；只有受控 CLI 在所有授权门同时满足时才会读取凭据。`GITHUB_TOKEN_FILE` 必须指向宿主机上的 token 文件，不能把 token 写入 `.env`、配置 JSON、命令行或仓库。

受控 AI 策略和模型处理授权只能通过本机 CLI 写入；应用没有身份认证，因此不提供对应的 HTTP 写接口。配置前先从项目 Source 列表取得明确的 `projectId` 和 `sourceId`，然后显式确认所选内容未来可能发送给 OpenAI：

```bash
pnpm project-ai:config -- status --project-id <projectId>
pnpm project-ai:config -- configure \
  --project-id <projectId> \
  --source-id <sourceId> \
  --acknowledge-external-model-transfer selected-project-sources-to-openai:v1
pnpm project-ai:config -- revoke --project-id <projectId>
```

`configure` 会重新计算并核对 Source 指纹、执行本地敏感信息扫描，并为固定的自动抽取、Embedding、来源摘要、项目分析与带上下文生成五类操作分别生成 30 天授权；重复执行相同命令是幂等的，改变 Source 集合会撤销旧授权。CLI 只输出安全状态，不输出 Source 内容或凭据。网页状态中的 `EXTERNAL_TRANSFER_NOT_ENABLED` 表示自动模型写入路径保持关闭；它不授权任何 CLI 外发。Embedding CLI 会再次检查对应 grant、策略、扫描器、凭据和本次命令的精确确认文本。

已经存在合格且未撤权的 Project RAG Snapshot 时，可以在本机执行关键词检索：

```bash
pnpm project-memory:search -- --project-id <projectId> --query "当前风险" --take 5 --scope auto
```

默认执行 CJK 二元词、标识符/路径、精确子串和通用词项融合。加入 `--acknowledge-external-query-transfer project-query-to-openai:v1` 会只把本次查询发送给固定 OpenAI Embedding endpoint，再执行 pgvector + 关键词 RRF；也可以用 `--query-vector-file /absolute/path/query-vector.json` 提供同 profile 的本地单位化向量。撤权、策略变化、快照不完整或跨项目引用都会在读取时失败关闭。

完整的多仓库连接、授权、索引、发布、检索和撤权命令见 [V1 本机运行手册](docs/v1-operations.md)。

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

- `GET /api/health`：真实执行一次 `SELECT 1`，数据库可用时返回 200 和应用版本。
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
- [V0 历史范围](docs/v0-scope.md)
