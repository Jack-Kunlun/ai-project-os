# 本地持续交付候选门禁

`pnpm release:local` 用于在当前机器上构建并验收一个可整体丢弃的 Compose 候选。它是 CI 之后的容器交付门禁，不会更新正式实例，不会创建 Git tag、push 分支或镜像，也不会执行托管部署。

## 前置条件

- Docker Engine 与 Docker Compose v2 可用。
- Git 工作树干净；默认只接受能够对应到精确 `HEAD` 的源码。
- `package.json`、`src/lib/version.ts` 和 Dockerfile 的 OCI 版本标签完全一致。

开发过程中可以使用 `pnpm release:local -- --allow-dirty` 验证尚未提交的候选，但输出会明确标记 `releaseEligible: false`，不能作为正式发布依据。

## 自动执行的检查

运行器会为每次执行生成唯一、受限的 Compose project，并使用两个临时 loopback 端口、三个候选专用卷、三张候选专用镜像和随机数据库密码。随后按顺序：

1. 执行 `docker compose config --quiet`。
2. 构建 migrate、app 和 worker 镜像。
3. 启动隔离的 PostgreSQL、迁移任务、应用和 Worker。
4. 要求 PostgreSQL、app、worker 为 `healthy`，migrate 以 0 退出。
5. 比对 Prisma 迁移目录与数据库已完成迁移数，检查三张镜像的 OCI 版本标签。
6. 检查 `/api/health` 的版本、数据库、Worker 状态和连续失败数。
7. 重启 PostgreSQL、app 和 worker，再次核对容器、迁移账本和健康接口。
8. 只删除本次候选的容器、网络、卷和镜像，并验证这些精确资源均已消失。

正常完成或捕获到命令失败时，运行器都会尝试精确清理；失败时会先输出最多 200 行候选日志。它不会读取 `.env`，不会复用 `ai-project-os-pgdata`、`ai-project-os-secrets` 或 `ai-project-os-uploads`，也不会执行正式部署明确禁止的宽泛卷删除。如果进程被操作系统强制终止，应使用日志中的唯一候选 project 名核对并清理残留，而不能对默认 Compose 项目执行宽泛删除。

成功结束时会输出 `LOCAL_RELEASE_CANDIDATE_OK`，其中包含版本、Git revision、迁移数量、重启持久性和清理状态。这个结果证明本地容器候选可构建、可迁移、可健康启动并可重启，但不证明备份可恢复、正式实例已升级，或真实模型、Git、OIDC、MCP 已完成现场验收。
