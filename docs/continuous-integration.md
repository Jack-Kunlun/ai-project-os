# 持续集成与浏览器门禁

仓库的 GitHub Actions 工作流在每次 push 和 pull request 上运行当前候选的可自动化发布门禁。它是 GitHub 适配器，不改变产品对 Gitee、GitLab、自建 GitLab、Gitea、Forgejo 或通用 Git 的支持边界；使用其他 CI 平台时应按同样顺序移植仓库命令。

## 自动门禁

工作流使用 Node.js 24、pnpm 10 和带 pgvector 的 PostgreSQL 18，依次执行：

1. 冻结锁文件安装依赖，生成并校验 Prisma Client 和完整迁移目录。
2. 运行 Lint、TypeScript 类型检查和完整默认测试集。
3. 对一次性、名称受限的测试数据库实际运行 `pnpm test:postgres-gates` 中登记的全部 PostgreSQL 门禁。
4. 安装 Chromium，并通过 `pnpm test:browser-e2e` 构建和启动生产模式应用与 Worker。
5. 在全新数据库中初始化管理员，检查安全响应头、Dashboard、健康接口、使用指南和 MCP 连接页；同时拒绝浏览器控制台错误。

浏览器门禁固定为单 Worker，失败时保留截图、trace、视频和 HTML 报告。数据库和临时主密钥在门禁结束时精确清理；运行器只接受 `127.0.0.1:56432/postgres` 或等价 loopback 管理地址，并且只操作固定的 `ai_project_os_browser_e2e_test` 数据库。应用端口默认从 loopback 动态分配；如显式设置 `BROWSER_E2E_PORT`，运行器会先拒绝已被占用的端口。Playwright 只接受运行器注入的 `http://127.0.0.1:<port>`，避免误测其他本地服务。

## 安全边界

- 工作流权限只有 `contents: read`，第三方 Action 固定到完整提交 SHA，checkout 不保留 Git 写凭据。
- CI 中的 PostgreSQL 密码仅属于当次隔离服务，不是部署凭据。
- 工作流不接收模型 API Key、Git Token/SSH Key、OIDC Client Secret 或 MCP Bearer Token，也不会调用真实外部服务。
- `pnpm test:browser-e2e` 会执行生产构建，但不能替代正式部署的备份恢复、Compose 状态或入口代理验收。

## 本地复现

先准备绑定 `127.0.0.1:56432` 的一次性 PostgreSQL 18 + pgvector 管理库，在未提交的 shell 环境中设置 `POSTGRES_GATE_ADMIN_URL` 和不少于 16 位的 `POSTGRES_GATE_TEST_PASSWORD`，再执行：

```bash
pnpm test:postgres-gates
pnpm exec playwright install chromium
pnpm test:browser-e2e
```

不要把管理 URL 或密码写入仓库，也不要把 `POSTGRES_GATE_ADMIN_URL` 指向正式数据库。运行器会重建固定测试数据库；它不适用于保留数据的环境。

## 仍需现场完成的门禁

CI 通过只证明仓库内的确定性行为、迁移、隔离 PostgreSQL 闭环和最小浏览器路径可重复。真实模型调用、多 Git 服务同步、OIDC 身份登录和第三方 MCP 审批调用仍必须按[外部服务现场验收](external-service-acceptance.md)在目标部署上完成，不能由本地替代服务或绿色 CI 冒充。
