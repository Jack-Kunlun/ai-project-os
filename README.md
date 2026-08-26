# AI Project OS

AI Project OS 是一个面向单项目的 V0 原型，用最小的 Project Snapshot 验证“AI 是否真的理解一个项目”。Day 1 先建立项目容器、可追溯数据模型和最小 CRUD；后续再接入资料、条目提取与快照生成。

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

## 数据完整性边界

`ProjectItem.sourceId` 在数据库中是必填字段；创建条目必须先创建同项目的 `ProjectSource`。Item→Source、Item→supersedes 和 Snapshot→Scan 使用同项目复合外键，并在 PostgreSQL 中以 `DEFERRABLE INITIALLY DEFERRED` 的 `NoAction` 关系校验，避免跨项目引用，同时允许项目根 Cascade 在事务内清理完整子图。Prisma schema 表达了 `NoAction`，但不会表达 `DEFERRABLE`，对应迁移中的 PostgreSQL-only 扩展需在后续迁移审阅时保留。

## API

- `GET /api/health`：真实执行一次 `SELECT 1`，数据库可用时返回 200。
- `GET /api/projects`：按更新时间列出项目。
- `POST /api/projects`：创建项目，必填 `name`，可选 `slug` 与 `description`。
- `GET /api/projects/:projectId`：读取项目详情与最近条目。
- `PATCH /api/projects/:projectId`：更新 `name`、`slug` 或 `description`。

所有输入使用 Zod 校验；错误响应返回稳定的 `code` 与面向调用方的消息，不回显连接字符串或内部异常。
