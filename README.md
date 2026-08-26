# AI Project OS

AI Project OS 是一个面向单项目的 V0 原型，用最小的 Project Snapshot 验证“AI 是否真的理解一个项目”。Day 1 建立项目容器、可追溯数据模型和最小 CRUD；Day 2 接入手工候选资料；Day 3 支持手工 ProjectItem 的创建、编辑和审核状态流转；Day 4 将同项目已确认 Item 在一致读取点组装成可追溯、不可变的最新 Snapshot；Day 5 提供无敏感信息的真实项目样本、修正演示和回归清单。

## 本地启动

要求：Node.js 24+、pnpm 10+、Docker Desktop。

```bash
pnpm install
cp .env.example .env
# 编辑 .env：自行设置 POSTGRES_PASSWORD 和 DATABASE_URL（不要提交 .env）
docker compose config --quiet
docker compose up -d
pnpm db:migrate --name init
pnpm dev
```

`.env.example` 只提供变量名和非敏感的本地默认用户/数据库名，不包含可用密码或完整连接串。复制后必须自行设置本地密码，并设置与 Compose 用户、密码、数据库和 `127.0.0.1:5433` 端口匹配的 `DATABASE_URL`；未设置 `POSTGRES_PASSWORD` 时，Compose 会明确失败。`.env` 已被 Git 忽略。

应用默认运行在 <http://localhost:3000>。

## 验证命令

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm db:validate
pnpm db:generate
```

数据库迁移文件在 `prisma/migrations`。重建本地数据库时可执行 `docker compose down -v` 后重新启动并运行迁移；该命令会删除本地开发数据，请确认后再执行。

Day 1 的最终验收命令、HTTP 状态、数据库 catalog 与事务 smoke 结果见 [docs/acceptance/day-1.md](docs/acceptance/day-1.md)。
Day 2 的实现边界与验收状态见 [docs/acceptance/day-2.md](docs/acceptance/day-2.md)。
Day 3 的 Item 实现边界与验收状态见 [docs/acceptance/day-3.md](docs/acceptance/day-3.md)。
Day 4 的 Snapshot 实现边界与验收状态见 [docs/acceptance/day-4.md](docs/acceptance/day-4.md)。
Day 5 的样本、修正流程、可观察问题和真实验收记录位置见 [docs/acceptance/day-5.md](docs/acceptance/day-5.md)。

## Day 5 演示

Day 5 样本使用 AI Project OS 自身的公开原型内容，不包含用户私密信息、真实凭据或带凭据 URL。脚本只允许访问 loopback 根地址（`localhost`、`127.0.0.1` 或 `[::1]`），默认是 `http://localhost:3000`；它只通过现有 HTTP API 创建 Project、两条 manual Source、四条 candidate Item，逐条确认后生成第一份 Snapshot：

```bash
pnpm day5:demo -- seed --base-url http://localhost:3000
```

命令会输出 `projectId`、`slug`、`browserUrl` 和精确的 cleanup 命令。打开 `browserUrl` 后，先核对 Snapshot 的四类条目、Focus（Issues 后 Risks）和每条 provenance。然后同时编辑 progress 条目的标题、content 和精确 excerpt：将“修正前”标题/文本改为 fixture 原文中的“修正后”标题/文本，保存使其回到 candidate；核对 Source 原文中的连续摘录，重新确认，再生成最新 Snapshot。旧 Snapshot 只表示过去的读取点，不能替代当前状态。

演示结束后，必须只使用 seed 输出的精确参数清理该临时 Project（脚本会校验 projectId、完整 slug、Day 5 专属 name/marker，并只删除项目根）：

```bash
pnpm day5:demo -- cleanup --project-id <seed 输出的 projectId> --slug <seed 输出的完整 slug>
```

cleanup 参数错误、slug 不匹配或目标不是 Day 5 样本都会安全失败并返回非零状态；目标 Project 根的身份字段发生变化也会拒绝。不要使用名称前缀、模糊匹配或批量删除。完整流程、六个可观察问题和真实数据库/API/browser 验收记录位置见 [docs/acceptance/day-5.md](docs/acceptance/day-5.md)。

V0 没有调用 LLM。“理解”验收的是用户能否根据 Source 原文、精确摘录、人工确认的 Item、Focus 和 Snapshot 读取点判断项目状态；这不是自动 AI 判断，也不是自动摘要或自动纠错。

## 数据完整性边界

`ProjectItem.sourceId` 在数据库中是必填字段；创建条目必须先创建同项目的 `ProjectSource`。Item→Source、Item→supersedes 和 Snapshot→Scan 使用同项目复合外键，并在 PostgreSQL 中以 `DEFERRABLE INITIALLY DEFERRED` 的 `NoAction` 关系校验，避免跨项目引用，同时允许项目根 Cascade 在事务内清理完整子图。Prisma schema 表达了 `NoAction`，但不会表达 `DEFERRABLE`，对应迁移中的 PostgreSQL-only 扩展需在后续迁移审阅时保留。Day 2 的 Source 只接受手工原始内容，服务端固定 `kind=manual`，保存 SHA-256 和可选无凭据 HTTP(S) 链接；内容仍是候选输入，不代表可信事实。

`sourceExcerpt` 的精确非空校验，以及 `reviewStatus`/`confirmedAt` 的一致性，是当前受支持 HTTP API 写入路径的不变量；不支持直接 DB/Prisma 写入，schema 尚未完全强制这些语义。未来引入其他 writer 前，需补充数据库约束和迁移。

Snapshot 的 payload、非空 `scanId`、Snapshot 与 Scan 共用 `generatedAt`、以及 Scan 的终态时间，均是当前 Snapshot HTTP writer 的保证，不是数据库已完全约束的语义；不支持直接 DB/Prisma writer。生成过程使用项目范围的事务 advisory lock，但该锁只保护遵循本 API 协议的并发生成。Snapshot 是“截至 `readAt`”的历史状态，不承诺永远代表当前项目。

## API

- `GET /api/health`：真实执行一次 `SELECT 1`，数据库可用时返回 200。
- `GET /api/projects`：按更新时间列出项目。
- `POST /api/projects`：创建项目，必填 `name`，可选 `slug` 与 `description`。
- `GET /api/projects/:projectId`：读取项目详情与统计；条目通过独立的 Items API 读取。
- `PATCH /api/projects/:projectId`：更新 `name`、`slug` 或 `description`。
- `GET /api/projects/:projectId/sources`：按接入时间倒序列出项目内全部候选资料，不返回 `storageKey`；V0 暂不分页。
- `POST /api/projects/:projectId/sources`：手工保存原始候选资料，服务端计算精确 SHA-256；同项目重复内容返回 409。
- `DELETE /api/projects/:projectId/sources/:sourceId`：仅删除未被 Item 引用的候选资料；Source 不存在或不属于该项目时统一返回资源级 404 `SOURCE_NOT_FOUND`，不用于泄漏其他项目归属。
- `GET /api/projects/:projectId/items`：按 `updatedAt desc` 列出项目内全部 Item，返回安全的 Source 元数据，不返回原始 Source 内容或内部字段；V0 当前全量返回、不分页，商业化或大规模数据场景必须先引入 cursor pagination。
- `POST /api/projects/:projectId/items`：手工创建 `decision`、`progress`、`issue` 或 `risk` 候选条目；必须提供同项目 Source 和精确非空原文摘录。
- `PATCH /api/projects/:projectId/items/:itemId`：严格支持携带 `expectedUpdatedAt` 版本令牌的 `edit`、`confirm`、`dismiss`、`reopen` 状态操作；编辑不允许更换 Source，状态转移按当前状态和版本条件更新。
- `GET /api/projects/:projectId/snapshots`：读取项目最新一份已完成 Snapshot，按 `generatedAt desc, id desc` 确定性选择；没有 Snapshot 时返回 `null`，不提供历史列表或详情 API。
- `POST /api/projects/:projectId/snapshots`：在 Repeatable Read 读取点内，将全部已确认 Item 确定性分组为一份手工 Snapshot，并原子记录一个已完成 Scan；没有已确认或确认条目 provenance 无效时记录失败 Scan 并返回稳定错误。重复生成会保留新的历史行，不承诺幂等键。

所有输入使用 Zod 校验；错误响应返回稳定的 `code` 与面向调用方的消息，不回显连接字符串或内部异常。

Day 3 仍不包含上传、OCR、网页/GitHub 抓取、LLM 摘要、Item 自动生成、Source 编辑或版本链，也不提供认证授权；项目级隔离不是权限控制。
V0 Source 与 Item 列表当前均全量返回、不分页；商业化或大规模数据场景必须在扩展前为两类列表引入 cursor pagination，当前实现不承诺无限规模可扩展。
`superseded` Item 仍会出现在项目 Item 列表中并保持只读；Day 3 不提供创建或转换为 `superseded` 的动作。
Day 4 Snapshot 只包含 `confirmed` Item，按发生时间、确认时间和 ID 确定性排序到 decision/progress/issue/risk 四个区块；Focus 严格是 Issues 后 Risks，不表示优先级或 AI 判断。页面只展示最新 Snapshot，并提示当前确认集合变化后的手动重生成；历史分页、详情切换、删除/编辑 Snapshot 和自动生成属于后续范围。
