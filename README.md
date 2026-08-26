# AI Project OS

AI Project OS 是一个面向单项目的 V0 原型，用最小的 Project Snapshot 验证“AI 是否真的理解一个项目”。Day 1 建立项目容器、可追溯数据模型和最小 CRUD；Day 2 接入手工候选资料，并保留原文与精确 hash 供后续追溯。

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

## 数据完整性边界

`ProjectItem.sourceId` 在数据库中是必填字段；创建条目必须先创建同项目的 `ProjectSource`。Item→Source、Item→supersedes 和 Snapshot→Scan 使用同项目复合外键，并在 PostgreSQL 中以 `DEFERRABLE INITIALLY DEFERRED` 的 `NoAction` 关系校验，避免跨项目引用，同时允许项目根 Cascade 在事务内清理完整子图。Prisma schema 表达了 `NoAction`，但不会表达 `DEFERRABLE`，对应迁移中的 PostgreSQL-only 扩展需在后续迁移审阅时保留。Day 2 的 Source 只接受手工原始内容，服务端固定 `kind=manual`，保存 SHA-256 和可选无凭据 HTTP(S) 链接；内容仍是候选输入，不代表可信事实。

## API

- `GET /api/health`：真实执行一次 `SELECT 1`，数据库可用时返回 200。
- `GET /api/projects`：按更新时间列出项目。
- `POST /api/projects`：创建项目，必填 `name`，可选 `slug` 与 `description`。
- `GET /api/projects/:projectId`：读取项目详情与最近条目。
- `PATCH /api/projects/:projectId`：更新 `name`、`slug` 或 `description`。
- `GET /api/projects/:projectId/sources`：按接入时间倒序列出项目内全部候选资料，不返回 `storageKey`；V0 暂不分页。
- `POST /api/projects/:projectId/sources`：手工保存原始候选资料，服务端计算精确 SHA-256；同项目重复内容返回 409。
- `DELETE /api/projects/:projectId/sources/:sourceId`：仅删除未被 Item 引用的候选资料；Source 不存在或不属于该项目时统一返回资源级 404 `SOURCE_NOT_FOUND`，不用于泄漏其他项目归属。

所有输入使用 Zod 校验；错误响应返回稳定的 `code` 与面向调用方的消息，不回显连接字符串或内部异常。

Day 2 不包含上传、OCR、网页/GitHub 抓取、LLM 摘要、Item 自动生成、Source 编辑或版本链，也不提供认证授权；项目级隔离不是权限控制。
V0 Source 列表暂不分页；商业化或大规模数据场景必须在扩展前引入 cursor pagination，当前实现不承诺无限规模可扩展。
