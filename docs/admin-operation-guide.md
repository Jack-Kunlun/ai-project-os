# 管理员操作指南

本指南面向 `AppUser.role=admin` 的系统管理员。管理工作台位于 `/admin`，工作区 Owner/Admin 不能替代系统管理员访问平台模型、连接器、用户会员和运维页面。所有平台接口都在服务端再次检查角色；页面隐藏不是权限边界。

## 1. 管理工作台与权限边界

管理工作台的一级入口如下：

| 页面 | 用途 | 权限 |
| --- | --- | --- |
| `/admin` | 应用服务状态、数据库/Worker 检查和安全聚合 | 系统管理员 |
| `/admin/models` | 平台模型、能力和自定义模型 ID | 系统管理员 |
| `/admin/connectors/git` | Git 服务登记、验证和凭据轮换 | 系统管理员 |
| `/admin/connectors/mcp` | MCP 发现、管理员认证和撤销 | 系统管理员 |
| `/admin/users/memberships` | 用户会员资格的发放、延期和撤销 | 系统管理员 |
| `/admin/operations/backups` | 备份/运维状态 | 初始超级管理员按更严格规则读取 |
| `/admin/guide` | 管理员流程、安全和验收 | 系统管理员 |

旧的 `/settings`、`/connections`、`/connections/mcp` 和 `/system/*` 仅保留兼容入口，并由服务端先检查角色。`/system/memberships` 对 system admin 兼容跳转 `/admin/users/memberships`，普通用户返回用户工作台；`/system/operations` 仅 initial super admin 可用并兼容跳转 `/admin/operations/backups`，其他 system admin 按现有安全行为返回不可见页面，普通用户返回用户工作台。其他旧设置/连接器入口也只会把有权限的 system admin 导向对应管理页面，不会让普通用户请求平台表单。

工作区 Owner/Admin 只管理所属工作区的成员、邀请、企业登录和项目权限，不等于系统管理员。工作区成员接口不提供通过成员更新全局 `AppUser.disabledAt` 的能力，也不会替其他工作区撤销会话。全局账户封禁若无配套审计接口，不应通过工作区页面伪装实现。

## 2. 首次启动与升级

### 2.1 首次启动

Docker Desktop 与本地 Compose：

```bash
cp .env.example .env
# 在未提交的 .env 中设置 POSTGRES_PASSWORD 等基础设施值
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

预期状态：`postgres` 为 `healthy`，`migrate` 为 `Exited (0)`，`app` 与 `worker` 为 `healthy`。检查应用和 Worker 是两个独立信号：

```bash
curl --fail http://127.0.0.1:3000/api/health
```

响应应包含 `status: ok`、`database: up`、`worker.status: up` 和当前应用版本。Worker 缺失、停止、降级或心跳超过 45 秒时，应用接口可能仍存活，但健康响应和容器状态必须明确显示异常。

### 2.2 初始化管理员

第一次打开本地地址进入初始化页面。管理员用户名为 3–64 位，密码为 12–128 位且同时包含字母和数字。初始化完成后系统建立默认工作区并把管理员加入为 Owner。当前开发版页面只管理默认工作区，不提供工作区创建/切换。

初始化账号、初始密码和任何恢复材料不得写进 Git、Issue、截图或日志。若初始化已经完成，后续成员应通过团队邀请或受控企业登录进入。

### 2.3 更新现有部署

每次升级前先在一致窗口备份 PostgreSQL、凭据主密钥和 uploads，然后执行：

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
curl --fail http://127.0.0.1:3000/api/health
```

Compose 会先执行未应用迁移，再启动应用和 Worker。禁止 `docker compose down -v`、删除正式卷或用 `prisma migrate dev` 代替部署迁移。若迁移失败，保留现场、收集不含秘密的迁移/容器日志并停止，不手工降级数据库。

### 2.4 局域网、公网与 CI

默认 Compose 只适合本机回环访问。对外提供服务前使用受信任 HTTPS 反向代理，设置 `AI_PROJECT_OS_SECURE_COOKIES=true`，限制数据库和应用端口来源，并为登录、OIDC 发起和初始化配置入口限流。只有确认全站 HTTPS 后才启用 HSTS。Nginx 示例需替换域名和证书路径并通过 `nginx -t`。

GitHub Actions 在 push 和 pull request 上执行 Prisma/迁移校验、Lint、类型检查、测试、PostgreSQL 门禁、生产浏览器与无障碍 E2E、性能预算和隔离 Compose 候选构建。CI 不读取真实模型、Git、OIDC 或 MCP 凭据。绿色 CI 不等于正式部署、备份恢复或外部服务现场验收；顺序和隔离边界见[持续集成与浏览器门禁](./continuous-integration.md)和[本地持续交付候选门禁](./local-release.md)。

## 3. 管理员、GitHub OAuth 与 OIDC

### 3.1 团队与会员

在 `/team` 或管理工作台关联的用户/会员页面中，系统管理员可以维护受控用户资格和会员订阅。会员操作只改变会员记录和审计，不改变 `AppUser` 角色或工作区角色。工作区 Owner/Admin 的邀请、角色调整仍限制在所属工作区，并保留至少一位启用的 Owner。

新用户领取的试用 Token、会员期限和自定义模型权限应以当前产品策略和服务端 entitlement 判断为准；页面不能因为用户可见就宣称任何未来免费模型供给已经上线。未定价的会员套餐先以内部成本模型评估，不能在页面硬编码未经批准的价格。

### 3.2 GitHub 登录

在 GitHub OAuth App 登记当前站点的回调地址，例如本地：

```text
http://127.0.0.1:3000/api/auth/github/callback
```

凭据只写入未提交的部署配置或受控密钥管理，不写入源码、文档、URL 或日志。`AI_PROJECT_OS_PUBLIC_ORIGIN` 必须是浏览器实际访问的规范 origin，不能填容器内部地址。生产 job 在首个正式版本前静态禁用；不要因为配置了 GitHub Secret 就绕过发布门禁。

用户首次使用 GitHub 登录且系统不存在同邮箱账户时，可按产品规则创建 `member` 并加入默认工作区；同邮箱已存在时不得静默合并，用户应先登录原账号，再走明确绑定流程。临时访问令牌验证后立即撤销，不作为长期 Git 凭据保存。

### 3.3 企业 OIDC

在身份提供商登记：

```text
http://127.0.0.1:3000/api/auth/oidc/callback
```

生产环境使用 HTTPS 站点回调。管理页面需要填写名称、Issuer URL、Client ID/Secret、包含 `openid` 的 scopes、Token 端点认证方式、自动加入角色、是否允许自动建号和邮箱域名。公司内网身份源才开启受信任内网访问。

保存时服务端读取 Discovery，检查 Authorization Code、PKCE 和允许的签名算法，固定 Discovery、Token 与 JWKS 地址。公网端点要求 HTTPS，云元数据地址始终阻止。登录回跳只允许单前导斜杠本站路径；绝对 URL、反斜线和编码路径分隔符必须拒绝或安全降级。登录时校验 issuer、audience、nonce、过期时间和 JWKS 签名；相同邮箱不会自动绑定已有本地账户。

## 4. 平台模型与 AI 路由

### 4.1 当前模型供应商管理流程

在 `/admin/models` 配置并测试 OpenAI、DeepSeek、Qwen 或 GLM 的平台连接。连接表单接收 API Key 后只在服务端以 AES-256-GCM 加密保存，页面只显示受限状态和掩码信息；禁止读取、记录或复制明文。

管理员配置并验证后，可作为平台默认路由建议/供项目选择。DeepSeek 可用于生成能力，GLM 可按已验证能力用于向量能力；不要把某个 provider 的存在写成普通用户可自由配置或永久免费的承诺。普通用户免费模型策略、自定义免费模型供给和自动按会员分配的未来策略均属于 **planned / 后续能力**，不是当前已支持能力。

平台表单允许自定义模型 ID，但每种 capability 仍需符合服务端供应商协议和能力校验。GLM 可以只配置向量模型与维度，生成/视觉字段保持未配置时应保存为 `null`；DeepSeek 的默认生成模型和现有视觉意图不能因该兼容路径回归。连接测试只展示真实能力的布尔/维度结果，例如“向量连接通过（1024 维）”，不展示模型返回正文。

项目内 AI 路由由项目权限和平台已验证连接共同决定。切换生成/视觉模型影响后续任务；切换向量供应商、模型或维度会让活动索引失配，必须重建索引。任何外发都需要项目页面的当次确认。

### 4.2 Token 与会员审计

管理总览的 Token 数来自只读数据库聚合：累计发放、当前可用、**预留 / 待对账占用**和已确认消耗。不得调用会恢复过期预留、产生写入的运行时摘要函数来渲染总览。无法可靠计算的字段不要显示；页面不返回个人账本、邮箱、密钥尾号或完整运行载荷。

## 5. Git 与 MCP 连接器

### 5.1 Git 连接

在 `/admin/connectors/git` 新建 Git 服务并选择 GitHub、Gitee、GitLab、Gitea、Forgejo 或受约束的通用 Git。公网默认 HTTPS；HTTPS 可用无认证、Token 或 Basic，SSH 只接受私钥和精确 known_hosts。自签 HTTPS 需要受信任 CA，公司内网必须显式开启允许私网。

凭据使用最小只读权限。GitHub fine-grained PAT 只授权所需仓库的 Contents Read；不要使用个人主 SSH Key，建议单独创建只读 Deploy Key。保存时验证地址、凭据和远端可达性，固定解析地址并关闭交互、钩子、非目标协议和重定向。DNS 地址变化后必须重新验证。

项目首次关联代码仓库只能由系统管理员完成。项目仓库页面只向系统管理员请求已验证的 `/api/settings/git-connections`，普通用户不请求全局连接列表；首次关联接口在加载凭据或远程 probe 前拒绝非 admin，并且只接受 `status=verified` 且 `disabledAt=null` 的连接。已关联项目成员可以查看安全仓库摘要和执行既有受控同步，响应不返回 `baseUrl`、凭据、错误连接详情或内部状态。

### 5.2 MCP 只读工具

在 `/admin/connectors/mcp` 添加远程 Streamable HTTP 端点，使用无认证或 Bearer Token。公网端点必须 HTTPS，内网需显式授权，云元数据地址不可放行。当前版本禁止 stdio、本地子进程、旧式 HTTP+SSE、执行中交互输入、自动执行和写操作。

保存后执行工具发现并固化目录。系统限制总数、Schema 深度和响应大小；有效定义保存输入/输出 Schema、annotations 和 SHA-256 指纹。只有明确 `readOnlyHint=true` 且 `destructiveHint=false` 的定义才可申请管理员认证；annotations 属于不可信提示，不能替代管理员认证。

管理员对精确工具、当前网络解析和凭据指纹执行“管理员认证”，认证/撤销写入追加式审计。工具定义、DNS、凭据或连接状态变化会使旧认证失效，需重新发现和认证。项目 Owner 再逐项授权，Editor/Owner 创建调用动作，每次由 Owner 审批。执行前重新核对所有指纹；漂移、撤销或过期都失败关闭。

成功 MCP 结果只能由 Editor/Owner 人工纳入为未审核项目资料，固定动作、输入、结果和内容指纹；不会自动成为事实、进入 RAG 或触发模型。

## 6. 资料、记忆、计划和治理的运维边界

管理员负责平台能力就绪和安全审计，项目资料仍由项目角色维护。文件、网页、仓库资料要保留来源身份；解析、网页刷新和仓库扫描失败时不得替换上一代完整活动版本。图片/扫描 PDF 的视觉识别必须由用户逐次确认并逐片段审核。

自动抽取只输出带来源摘录的候选；项目 Owner/Editor 审核后才进入事实。统一向量索引在资料或路由变化后重建，RAG 只能引用本次检索集合。项目世界状态由当前有效事实、关系和计划健康度的确定性规则计算，模型不能确认事实、建立关系、替代旧事实或覆盖状态。

项目计划中的智能体建议只能进入 `proposed`；负责人、验收标准、完成证据、依赖和状态由用户操作并留下追加审计。仓库变化只生成可核对信号，不自动创建工作项或动作。动作策略、Owner 审批、租约失败关闭和 MCP 漂移校验不可省略。

## 7. 备份与恢复

### 7.1 一致备份窗口

升级或高风险运维前，记录不含业务内容的迁移账本、健康状态和安全计数。短暂停止 app/worker 时让 postgres 保持运行，创建受限权限的持久备份目录；备份必须包括 PostgreSQL 自定义格式 dump、凭据主密钥和 uploads。不要把临时目录作为唯一备份。

示例（数据库连接参数应从受保护配置读取，不要把值写入命令历史）：

```bash
docker compose exec -T postgres pg_dump -U ai_project_os -d ai_project_os -Fc > ai-project-os.dump
pg_restore -l ai-project-os.dump
```

确认 dump 非空且 `pg_restore -l` 可解析；文件权限至少收紧到 `0600`，备份目录 `0700`。数据库、`ai-project-os-secrets` 主密钥卷和 `ai-project-os-uploads` 文件卷必须来自同一备份窗口并一起恢复。丢失主密钥会使已保存模型、Git、MCP 和 OIDC 凭据无法解密，丢失 uploads 会使原始文件不可恢复。

生产单节点可按[生产异地备份](./production-backup.md)使用 root-only 脚本和 systemd timer，在停写窗口生成三类数据、使用 age 公钥加密并上传 COS。只有远端长度与 CRC64 验证通过的本地目录参与保留期清理；项目 JSON 导出、健康接口或仅看到 COS 对象都不能替代独立恢复演练。

### 7.2 恢复核对

恢复后依次确认迁移账本无失败/回滚、postgres/app/worker healthy、`migrate` 成功退出、`/api/health` 显示数据库和 Worker 正常、三个持久卷仍挂载。再核对项目/连接/上传等安全计数没有下降，抽样验证凭据可以解密但绝不输出其内容。恢复演练应使用隔离卷和端口，不要直接覆盖正式数据。

## 8. 管理员故障排查与验收

| 现象 | 管理动作 |
| --- | --- |
| 总览显示 Worker 异常 | 先看 `/api/health` 的 `worker.status`、心跳和安全错误码，再检查 worker 容器单行 JSON 日志与重启次数 |
| 模型连接不能验证 | 检查内置 provider、能力字段、模型 ID、网络解析和凭据状态；不要放宽 Base URL 白名单 |
| GLM 只做向量 | 保持 generation/vision 为 `null`，配置已验证 embedding 模型和维度；测试文案只列真实能力 |
| Git 首次接入被拒绝 | 确认管理员角色、连接 `verified`、`disabledAt=null`、路径/分支和只读凭据；普通用户拒绝是预期安全边界 |
| Git 地址变化 | 重新执行连接验证，核对 DNS/CA/known_hosts，不要盲目接受新地址 |
| MCP 工具不能授权 | 重新发现并核对只读/非破坏性声明、工具定义、网络和凭据指纹；项目 Owner 重新授权并创建动作 |
| 迁移失败 | 保留数据库和日志现场，停止 app/worker；不要删卷、手工改账本或降级迁移 |
| 备份无法解析 | 停止恢复，保留原备份并重新生成；不得用导出 JSON 代替 dump+主密钥+uploads |
| 普通用户看到平台入口 | 检查 Header、旧 URL 服务端守卫和 `/api/settings/*`/`/api/system/*` 直接请求，不能只依赖页面隐藏 |

正式验收至少包含：`pnpm db:generate`、迁移校验、typecheck、Lint、定向及完整测试、生产构建、隔离 PostgreSQL 门禁、浏览器 smoke、Compose 健康、备份解析与恢复演练。真实模型、Git、OIDC、MCP 未配置时必须明确排除现场验收，不能用静态检查冒充。

相关基线：[部署安全基线](./deployment-security.md)、[运行监控基线](./monitoring.md)、[持续集成与浏览器门禁](./continuous-integration.md)、[本地持续交付候选门禁](./local-release.md)、[外部服务现场验收](./external-service-acceptance.md)。
