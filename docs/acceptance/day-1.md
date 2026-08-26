# Day 1 验收记录

日期：2026-08-26
范围：AI Project OS V0 Day 1 及本次完整性修复
环境：本项目 Compose PostgreSQL 18.6，监听 `127.0.0.1:5433`，数据库名 `ai_project_os`。连接字符串和密码不写入此文档。

## 配置与凭据边界

`.env.example` 仅保留非敏感的用户/数据库名；`POSTGRES_PASSWORD` 与 `DATABASE_URL` 为空，复制后必须由开发者在被 Git 忽略的 `.env` 中自行填写。Compose 使用 `${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}`，缺少或为空时明确失败。

```text
docker compose config --quiet
# exit 0（只记录状态，不输出展开后的配置）

POSTGRES_PASSWORD= docker compose config --quiet
# non-zero（缺少必填密码；错误输出未写入验收记录）

git check-ignore -v .env
# .env 被 .gitignore 忽略

docker compose ps
# postgres: Up 2 hours (healthy), 127.0.0.1:5433->5432/tcp；未执行重启或重建
```

## 迁移

迁移前只读检查：

```text
pnpm exec prisma migrate status --config prisma.config.ts
# 1 migration found; Database schema is up to date!

docker compose exec -T postgres psql -U ai_project_os -d ai_project_os -X -A -t -c 'SELECT (SELECT count(*) FROM "ProjectItem") AS items, (SELECT count(*) FROM "ProjectItem" WHERE "sourceId" IS NULL) AS items_without_source, (SELECT count(*) FROM "ProjectSource") AS sources, (SELECT count(*) FROM "ProjectScan") AS scans;'
# 0|0|0|0
```

生成并审阅了 create-only 迁移 `20260826030732_integrity_boundaries`：

```text
TERM=xterm-256color pnpm exec prisma migrate dev --config prisma.config.ts --name integrity_boundaries --create-only
# confirmed "yes" at the interactive prompt; migration created without applying it

pnpm db:validate
# The schema ... is valid

pnpm exec prisma migrate deploy --config prisma.config.ts
# 20260826030732_integrity_boundaries applied; all migrations successfully applied
```

迁移只增加复合唯一索引、`ProjectItem.sourceId NOT NULL` 和三条同项目复合外键；三条跨子表外键在 SQL 中保留 `ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED`。

## 数据库 catalog 断言

```text
docker compose exec -T postgres psql -U ai_project_os -d ai_project_os -X -f - < test/catalog-assertions.sql
# root Cascade foreign keys: PASS (4)
# deferred NoAction foreign keys: PASS (3)
# ProjectItem.sourceId NOT NULL: PASS
# project/id unique indexes: PASS (3)
# relationship_violation_count: 0, 0, 0
# relationship violation count: PASS (0)
```

## 事务完整性 smoke

```text
docker compose exec -T postgres psql -U ai_project_os -d ai_project_os -X -f - < test/integrity-smoke.sql
# same-project relationships: PASS
# cross-project source/supersession/scan: PASS (23503)
# referenced source/prior item/scan delete: PASS (23503)
# project-root cascade: PASS
# post-ROLLBACK persistent data: PASS (smoke projects absent, child tables=0)
```

变更性 smoke 在一个事务中运行并以 `ROLLBACK` 结束；回滚后的最后一个只读断言另行确认 smoke Project 未残留。复核时 HTTP smoke 留下的 Project 记录未被删除，子表仍为空。

## HTTP smoke

使用 `PORT=3102 pnpm start` 启动本机临时 server，完成真实数据库请求：

| 请求 | 结果 |
| --- | --- |
| `GET /api/health` | 200 |
| `POST /api/projects`（自动 slug） | 201 |
| `GET /api/projects` | 200 |
| `GET /api/projects/:projectId` | 200 |
| `PATCH /api/projects/:projectId` | 200 |
| `POST /api/projects`（空 name） | 400，`VALIDATION_ERROR` |
| 两个并发同名 `POST /api/projects` | 201、201；slug 为 `concurrent-slug-smoke` 与 `concurrent-slug-smoke-201d4c61` |

无效环境 smoke 使用 `DATABASE_URL=invalid PORT=3101 pnpm start`：

| 请求 | 结果 |
| --- | --- |
| `GET /api/health` | 503，稳定 JSON `status=error/database=down` |
| `GET /api/projects` | 500，稳定 JSON `error.code=INTERNAL_ERROR` |

空环境 smoke 使用 `DATABASE_URL= PORT=3103 pnpm start`，结果相同：health 503、Project API 500，且未产生 HTML、stack 或连接字符串泄漏。

上述错误响应不包含 HTML、stack、数据库 URL 或密码。

## 项目级检查

```text
pnpm test       # 7 passed, 0 failed
pnpm lint       # exit 0
pnpm typecheck  # exit 0
pnpm build      # exit 0
pnpm db:validate # exit 0
pnpm db:generate # exit 0
```

非生成文本尾随空白检查：

```text
rg -n --hidden --glob '!.git/**' --glob '!node_modules/**' --glob '!.next/**' --glob '!.env' --glob '!tsconfig.tsbuildinfo' '[[:blank:]]+$' .
# no matches
```
