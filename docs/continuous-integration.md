# 持续集成与浏览器门禁

仓库的 GitHub Actions 工作流按实际生产源版本到候选 SHA 的累计差异分层；无法确认线上源标签、祖先关系或改动风险时，保守运行高风险门禁。正式发布复用同 SHA 的主分支 CI，不再为版本标签重复整套测试。它是 GitHub 适配器，不改变产品对 Gitee、GitLab、自建 GitLab、Gitea、Forgejo 或通用 Git 的支持边界；使用其他 CI 平台时应按同样规则移植仓库命令。

## 自动门禁

正式发布由用户在[发布正式版本工作流](production-release.md)手动发起，CI 本身不自动上线。发布工作流与受限生产发布器分别核对同 SHA 成功主分支 CI 的源版本、风险层级及适用作业；annotated 标签负责版本身份，不重复代码测试。

| 风险 | 改动范围 | CI 检查 |
| --- | --- | --- |
| 低 | Markdown 文档、CSS、位图、经比对的纯版本元数据 | Prisma Client、Lint、类型检查、生产构建、性能预算 |
| 中 | 不触及认证/授权/额度/外发的数据展示与客户端交互、组件、SVG | 低风险静态检查、默认测试与覆盖率、隔离 PostgreSQL 浏览器/可访问性和性能验证 |
| 高 | 服务端/API、认证/授权/额度/模型外发、Schema/迁移、生产/CI/构建/依赖，以及未知改动 | 默认测试及覆盖率、按累计影响选择 PostgreSQL/账号/OID10/浏览器门禁、同镜像隔离候选；认证/授权、额度、Schema、依赖或未知影响运行完整门禁 |

混合改动取最高风险。`package.json`、公开版本文件和 Dockerfile 只有版本值变化时才能按纯版本元数据处理；依赖、脚本或构建指令同时变化仍是高风险。CI 与生产使用同一份受固定哈希保护的分类逻辑。最终验证作业记录实际基线 SHA 和风险层级，防止复用仅覆盖最后一笔轻量提交的结果。人工推送标签时，仅验证标签身份及同 SHA 的成功主分支 CI。

CI 使用 Node.js 24、pnpm 10 和隔离 PostgreSQL 18。`scripts/ci-impact-plan.mjs` 单独选择测试范围：认证/授权、额度、Schema、依赖和未知影响运行完整门禁，已映射业务运行对应门禁，发布/CI/构建工具变更运行发布合同及同镜像候选，明确无数据库影响时使用 `POSTGRES_GATE_FILTER=none`。空过滤器仍运行全部门禁。完整业务路径执行：

1. 冻结锁文件安装依赖，生成并校验 Prisma Client 和完整迁移目录。
2. 运行 Lint、TypeScript 类型检查和完整默认测试集；覆盖率门禁要求源代码行覆盖率不少于 60%、分支覆盖率不少于 78%、函数覆盖率不少于 67%。
3. 对一次性、名称受限的测试数据库实际运行 `pnpm test:postgres-gates` 中登记的全部 PostgreSQL 门禁。
4. 安装 Chromium，并通过 `pnpm test:browser-e2e` 启动本次构建的应用与 Worker 容器（本地未提供镜像时仍可构建）。
5. 在全新数据库中初始化管理员，检查安全响应头、Dashboard、健康接口、项目列表、使用指南和 MCP 连接页；同时拒绝浏览器控制台错误，并对关键页面执行 WCAG 2.2 A/AA 自动扫描。
6. 对同一次生产构建执行 `pnpm performance:check`，校验共享 JavaScript、单文件 JavaScript、全局 CSS、全部静态客户端资源，以及六个关键路由的 gzip 体积预算。
7. 运行 `pnpm release:local`，构建唯一隔离的 Compose 候选，核对迁移、镜像版本、容器与 API 健康，重启后复验并精确清理候选资源。

浏览器门禁固定为单 Worker，失败时保留截图、trace、视频和 HTML 报告。数据库和临时主密钥在门禁结束时精确清理；运行器只接受 `127.0.0.1:56432/postgres` 或等价 loopback 管理地址，并且只操作固定的 `ai_project_os_browser_e2e_test` 数据库。应用端口默认从 loopback 动态分配；如显式设置 `BROWSER_E2E_PORT`，运行器会先拒绝已被占用的端口。Playwright 只接受运行器注入的 `http://127.0.0.1:<port>`，避免误测其他本地服务。

可访问性扫描由锁定版本的 `@axe-core/playwright` 在本机浏览器上下文执行，不把页面内容发送给第三方服务。自动扫描不能替代键盘操作、屏幕阅读器和人工认知可用性评审，但任何已覆盖页面的 WCAG A/AA 违规都会直接使门禁失败。

性能预算保存在 `config/performance-budgets.json`。0.7.x 候选的共享 JavaScript 上限为 145 KiB、最大单个 JavaScript 文件为 75 KiB、全局 CSS 为 15 KiB、全站静态资产库存为 760 KiB。0.7.x 新增注册、MCP 与 Git 治理页面后，隔离生产构建实测 CSS 14.7 KiB、全站静态资产 752.2 KiB；因此 CSS 从 14.5 KiB、资产库存从 724 KiB 调整，保留约 1% 的库存余量。此调整不改变共享脚本、单文件或关键路由上限。setup、Dashboard、项目列表、指南、MCP 连接、账号访问、个人工作区和个人知识库路由分别使用 155、165、165、155、175、155、170 和 180 KiB 的 JavaScript 上限。全站静态资产库存会排除 Next 生成的 `static/chunks/app/api/**/route-*.js` 服务端 API 路由入口桩；页面和动态页面 chunk 不排除。库存是其余静态客户端构建文件逐文件 gzip 后的总量，不是首屏性能指标，也不等同于首屏加载体积。所有数值均按每个构建文件独立 gzip 后计算，避免机器速度与临时负载造成误报；调整预算必须和可解释的产品或依赖变化一起评审。`pnpm test:performance` 会使用不可连接的 loopback 数据库占位地址生成新的生产构建再检查预算，避免误连部署数据库；快速路径用 `pnpm test:performance` 建立无数据库连接的生产构建；完整路径的数据库作业已有浏览器门禁产物，因此直接运行 `pnpm performance:check`。

0.8 邮箱候选同时新增邮箱验证客户端并更新到 Next.js 16.3.8。2026-10-13 精确主分支 CI（`fcc5ba6`）的库存实测为 784.1 KiB，本地为 784.0 KiB；前一成功主分支 `bc90bc9` 为 779.2 KiB，本轮增加约 0.63%。现有 780 KiB 上限只比前一实测多 0.8 KiB，因此将库存上限调整为 792 KiB，保留约 1% 余量。共享 JavaScript、单文件 JavaScript、CSS 和全部关键路由上限保持不变；本轮 CI 的这些指标全部通过。此调整只重新设定全站构建库存基线，不改变计量算法、文件排除规则或首屏预算；该历史候选按当时规则要求完整主分支与标签 CI，当前正式版采用上文的同 SHA 复用规则。

1.0.3 候选增加管理员资源监控、知识导入视觉模型确认和项目概览入口。隔离生产构建实测全局 CSS 15,409 字节、全站库存 811,986 字节，分别比原上限多 49 和 978 字节；共享 JavaScript 为 131,233 字节、最大文件为 66,182 字节，全部关键路由均低于原预算。针对这些新增界面，将 CSS 上限设为 15.25 KiB、全站库存设为 800 KiB，保留约 1% 的库存余量。计量算法、排除规则、共享和单文件脚本及关键路由预算保持原值；后续同 SHA CI 仍须实际验证。

容器交付门禁的隔离与清理规则见[本地持续交付候选门禁](local-release.md)。它只验证一次性候选，不创建 tag、不升级正式 Compose，也不替代真实外部服务现场验收。CI 候选复用同次构建的镜像，清理隔离资源时保留共享镜像供后续发布。

## 安全边界

- CI 默认只读 `contents` 与 `actions`，镜像作业单独使用 `packages: write`，只在主分支 push 发布 GHCR 镜像。所有 Action 固定完整 SHA，checkout 不保留 Git 写凭据。手动发布工作流拥有创建版本标签和 GitHub Release 的权限以及读取镜像所需的 `packages: read`。
- CI 中的 PostgreSQL 密码仅属于当次隔离服务，不是部署凭据。
- 工作流不接收模型 API Key、Git Token/SSH Key、OIDC Client Secret 或 MCP Bearer Token，也不会调用真实外部服务。
- `RELEASE_IMAGES_MANIFEST` 指定本次镜像清单时，浏览器与候选不执行构建；性能验证从同一构建器导出 `.next`，不再次编译。生产仍核对精确摘要、Compose 状态及入口健康。

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
