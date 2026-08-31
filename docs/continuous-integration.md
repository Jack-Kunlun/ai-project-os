# 持续集成与浏览器门禁

仓库的 GitHub Actions 工作流在每次 push 和 pull request 上运行当前候选的可自动化发布门禁。它是 GitHub 适配器，不改变产品对 Gitee、GitLab、自建 GitLab、Gitea、Forgejo 或通用 Git 的支持边界；使用其他 CI 平台时应按同样顺序移植仓库命令。

## 自动门禁

工作流使用 Node.js 24、pnpm 10 和带 pgvector 的 PostgreSQL 18，依次执行：

1. 冻结锁文件安装依赖，生成并校验 Prisma Client 和完整迁移目录。
2. 运行 Lint、TypeScript 类型检查和完整默认测试集；覆盖率门禁要求源代码行覆盖率不少于 60%、分支覆盖率不少于 78%、函数覆盖率不少于 67%。
3. 对一次性、名称受限的测试数据库实际运行 `pnpm test:postgres-gates` 中登记的全部 PostgreSQL 门禁。
4. 安装 Chromium，并通过 `pnpm test:browser-e2e` 构建和启动生产模式应用与 Worker。
5. 在全新数据库中初始化管理员，检查安全响应头、Dashboard、健康接口、项目列表、使用指南和 MCP 连接页；同时拒绝浏览器控制台错误，并对关键页面执行 WCAG 2.2 A/AA 自动扫描。
6. 对同一次生产构建执行 `pnpm performance:check`，校验共享 JavaScript、单文件 JavaScript、全局 CSS、全部静态客户端资源，以及五个关键路由的 gzip 体积预算。
7. 运行 `pnpm release:local`，构建唯一隔离的 Compose 候选，核对迁移、镜像版本、容器与 API 健康，重启后复验并精确清理候选资源。

浏览器门禁固定为单 Worker，失败时保留截图、trace、视频和 HTML 报告。数据库和临时主密钥在门禁结束时精确清理；运行器只接受 `127.0.0.1:56432/postgres` 或等价 loopback 管理地址，并且只操作固定的 `ai_project_os_browser_e2e_test` 数据库。应用端口默认从 loopback 动态分配；如显式设置 `BROWSER_E2E_PORT`，运行器会先拒绝已被占用的端口。Playwright 只接受运行器注入的 `http://127.0.0.1:<port>`，避免误测其他本地服务。

可访问性扫描由锁定版本的 `@axe-core/playwright` 在本机浏览器上下文执行，不把页面内容发送给第三方服务。自动扫描不能替代键盘操作、屏幕阅读器和人工认知可用性评审，但任何已覆盖页面的 WCAG A/AA 违规都会直接使门禁失败。

性能预算保存在 `config/performance-budgets.json`。当前生产基线的共享 JavaScript 上限为 145 KiB、最大单个 JavaScript 文件为 75 KiB、全局 CSS 为 13 KiB、全部静态客户端资源为 540 KiB；setup、Dashboard、项目列表、指南和 MCP 连接路由分别使用 155、165、165、155 和 175 KiB 的 JavaScript 上限。所有数值均按每个构建文件独立 gzip 后计算，避免机器速度与临时负载造成误报；调整预算必须和可解释的产品或依赖变化一起评审。`pnpm test:performance` 会使用不可连接的 loopback 数据库占位地址生成新的生产构建再检查预算，避免误连部署数据库；CI 已有浏览器门禁产物，因此直接运行 `pnpm performance:check`。

容器交付门禁的隔离与清理规则见[本地持续交付候选门禁](local-release.md)。它只验证一次性本地候选，不发布镜像、不创建 tag、不升级正式 Compose，也不替代备份恢复和真实外部服务现场验收。

## 安全边界

- 工作流权限只有 `contents: read`，第三方 Action 固定到完整提交 SHA，checkout 不保留 Git 写凭据。
- CI 中的 PostgreSQL 密码仅属于当次隔离服务，不是部署凭据。
- 工作流不接收模型 API Key、Git Token/SSH Key、OIDC Client Secret 或 MCP Bearer Token，也不会调用真实外部服务。
- `pnpm test:browser-e2e` 会执行生产构建，但不能替代正式部署的备份恢复、Compose 状态或入口代理验收。

需要在正式本地实例旁运行候选 Compose 验收时，应使用独立 Compose 项目名，并同时覆盖 `POSTGRES_PORT`、`APP_PORT`、`AI_PROJECT_OS_PGDATA_VOLUME`、`AI_PROJECT_OS_SECRETS_VOLUME` 和 `AI_PROJECT_OS_UPLOADS_VOLUME`。缺少任何卷覆盖都可能复用正式数据，因此不属于隔离验收。

## 本地复现

先准备绑定 `127.0.0.1:56432` 的一次性 PostgreSQL 18 + pgvector 管理库，在未提交的 shell 环境中设置 `POSTGRES_GATE_ADMIN_URL` 和不少于 16 位的 `POSTGRES_GATE_TEST_PASSWORD`，再执行：

```bash
pnpm test:coverage
pnpm test:postgres-gates
pnpm exec playwright install chromium
pnpm test:browser-e2e
```

不要把管理 URL 或密码写入仓库，也不要把 `POSTGRES_GATE_ADMIN_URL` 指向正式数据库。运行器会重建固定测试数据库；它不适用于保留数据的环境。

## 仍需现场完成的门禁

CI 通过只证明仓库内的确定性行为、迁移、隔离 PostgreSQL 闭环和最小浏览器路径可重复。真实模型调用、多 Git 服务同步、OIDC 身份登录和第三方 MCP 审批调用仍必须按[外部服务现场验收](external-service-acceptance.md)在目标部署上完成，不能由本地替代服务或绿色 CI 冒充。
