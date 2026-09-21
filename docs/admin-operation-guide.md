# 管理员操作指南

本指南面向 `AppUser.role=admin` 的平台管理员。平台管理员只负责平台配置、用户运营、安全审核和受限运维；管理工作台位于 `/admin`，不展示项目、团队、工作区或用户个人连接。工作区 Owner/Admin 不能替代平台管理员访问这些页面。所有平台接口都在服务端再次检查角色，页面隐藏不是权限边界。

## 1. 管理工作台与权限边界

管理工作台的一级入口如下：

| 页面 | 用途 | 权限 |
| --- | --- | --- |
| `/admin` | 应用服务状态、数据库/Worker 检查和安全聚合 | 平台管理员 |
| `/admin/models` | 平台供应商、模型连接和逐项能力配置 | 平台管理员 |
| `/admin/credits` | 新注册赠送策略、额度记录和人工治理 | 平台管理员 |
| `/admin/operations/probes` | 供应商连接探测预算和告警阈值 | 平台管理员 |
| `/admin/connectors/mcp` | MCP 净化快照和不可变安全审核 | 平台管理员 |
| `/admin/users` | 账号状态、会员和用户额度摘要 | 平台管理员 |
| `/admin/audit` | 安全证据和变更历史 | 平台管理员 |
| `/admin/operations/failures` | 失败收件箱和待对账状态 | 平台管理员 |
| `/admin/operations/backups` | 备份/运维状态 | 初始超级管理员按更严格规则读取 |
| `/admin/guide` | 管理员流程、安全和验收 | 平台管理员 |
| `/admin/account` | 管理员登录资料和安全设置 | 平台管理员 |

`/settings` 与 `/system/*` 只保留受守卫的兼容跳转，不是当前管理导航。`/admin/connectors/git` 和 `/system/account-access` 已退出正常入口；访问时分别回到平台总览或用户运营页面。`/admin/users/memberships` 是用户与权益下的会员二级页面；`/system/memberships` 对 system admin 兼容跳转 `/admin/users/memberships`，普通用户返回用户工作台；`/system/operations` 仅 initial super admin 可用并兼容跳转 `/admin/operations/backups`，其他 system admin 按现有安全行为返回不可见页面，普通用户返回用户工作台。`/connections` 与 `/connections/mcp` 属于普通用户个人连接流程，不是管理员连接器页面。

账号停用/恢复现在归 `/admin/users` 的用户详情页管理。管理员可以查看安全摘要和必要的有效访问结果，但不通过旧的账号矩阵入口管理项目关系；停用账号仍可审计，所有有效结果均为 `effective=false`。system admin 角色只代表平台管理权限，不隐含任何工作区或项目 Owner 权限。

工作区 Owner/Admin 只管理所属工作区的成员、邀请、企业登录和项目权限，不等于平台管理员。工作区成员接口不提供通过成员更新全局 `AppUser.disabledAt` 的能力，也不会替其他工作区撤销会话。全局账户封禁若无配套审计接口，不应通过工作区页面伪装实现。

## 2. 首次启动与升级

### 2.1 首次启动

Docker Desktop 与本地 Compose：

```bash
cp .env.example .env
# 在未提交的 .env 中设置 cluster-admin、migrator、runtime、writer
# 和 inventory-reader 密码等基础设施值
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

预期状态：`postgres` 为 `healthy`，`principal-bootstrap`、`migrate`、`reconcile` 为 `Exited (0)`，`app` 与 `worker` 为 `healthy`。检查应用和 Worker 是两个独立信号：

```bash
curl --fail http://127.0.0.1:3000/api/health
```

响应应包含 `status: ok`、`database: up`、`worker.status: up` 和当前应用版本。Worker 缺失、停止、降级或心跳超过 45 秒时，应用接口可能仍存活，但健康响应和容器状态必须明确显示异常。

### 2.2 初始化平台管理员

第一次打开本地地址进入初始化页面。平台管理员用户名为 3–64 位，密码为 12–128 位且同时包含字母和数字。平台管理员创建后即可进入 `/admin`，无需另建默认工作区 Owner。配置有效的 GitHub OAuth 后，普通用户首次登录会创建自己的个人工作区并成为 Owner；工作区 Owner 可以在自己的工作区配置 OIDC、邀请成员或创建本地成员。OIDC 和本地新增的普通用户也各自拥有个人工作区，加入其他工作区是额外的成员关系。

初始化账号、初始密码和任何恢复材料不得写进 Git、Issue、截图或日志。平台管理员继续使用独立管理工作台，不自动加入任何普通用户的工作区，也不代持项目、团队或个人连接权限。当前首位普通用户需要通过已配置的 GitHub 登录进入；尚无独立的公开密码注册入口。

### 2.3 更新现有部署

每次升级前先在一致窗口备份 PostgreSQL、凭据主密钥和 uploads，然后执行：

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
curl --fail http://127.0.0.1:3000/api/health
```

Compose 会按 `principal-bootstrap → migrate → reconcile → app/worker` 执行。cluster-admin 只用于 initdb/维护窗口和两个 one-shot 阶段，migrate 只使用非超级用户 migrator；inventory reader 是独立的本机/SSH tunnel 只读维护入口。bootstrap 阶段检查并修复数据库/schema/对象 owner，未完成时在迁移前 fail closed。禁止 `docker compose down -v`、删除正式卷或用 `prisma migrate dev` 代替部署迁移。若 bootstrap 或迁移失败，保留现场、收集不含秘密的迁移/容器日志并停止，不手工降级数据库。

#### 现有卷的账号拓扑升级

这不是在线或滚动升级。部署器先完成候选构建和旧库只读预检，再在一致维护窗口停止精确的旧 app/worker，完成维护隔离与 post-stop 只读预检后生成最终迁移备份；备份成功后才启动迁移，迁移开始后不恢复旧代码。设置 `POSTGRES_USER=ai_project_os_cluster_admin`、`POSTGRES_CLUSTER_ADMIN_PASSWORD`、`POSTGRES_MIGRATOR_PASSWORD`，并将旧 owner（例如 `ai_project_os`）的凭据只写入临时 `DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL`。启动 Compose 后确认 `principal-bootstrap`、`migrate`、`reconcile` 全部成功；bootstrap 会先创建 cluster-admin，再在当前数据库转移旧 owner 的受支持对象、清理成员关系并封存旧角色。普通旧 owner 变为 `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`；官方 initdb OID10 不能降级为 `NOSUPERUSER`，只保留不可避免的 `SUPERUSER`，同时设置 `NOLOGIN`、清除密码、清除成员关系并终止其他会话。随后删除并轮换 legacy URL；它不能出现在 app/worker/migrate 环境、提交文件或日志中。封存角色仍保留以便依赖审查，只有检查外部依赖和成员关系后才可在单独维护窗口受控地 `DROP ROLE`。bootstrap 缺失、owner 不支持或凭据错误时必须在迁移前 fail closed。升级会保留业务数据并转移当前数据库的受支持关系、序列、函数、过程和类型；不要删除正式卷。

连接 URL 中的密码必须按 URL 规则编码；生产部署的五个 PostgreSQL 密码使用 64 位十六进制值。若 bootstrap URL 中含旧 owner 密码，升级完成后应立即轮换旧 owner 凭据。

#### Entitlement 只读盘点

`db:account-entitlement-inventory` 使用独立的 `ai_project_os_entitlement_inventory_reader`，只允许执行 migrator-owned 的聚合函数，不授予四张基础表的 `SELECT`。生产执行必须通过本机回环或 SSH tunnel，把 `ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL` 指向 `127.0.0.1`；不要把 reader URL、cluster-admin 或 migrator 凭据放入 app/worker：

```bash
ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL='postgresql://ai_project_os_entitlement_inventory_reader:<password>@127.0.0.1:5433/ai_project_os' \
  pnpm db:account-entitlement-inventory
```

输出仅包含 eligible/issued/ambiguous/missing 计数，不返回 userId、余额、原因或 digest。若盘点命令报告 raw-table ACL、函数权限或 read-only preflight 失败，应停止并重新运行 `principal-bootstrap → migrate → reconcile`，不要手工授予表权限。

### 2.4 局域网、公网与 CI

默认 Compose 只适合本机回环访问。对外提供服务前使用受信任 HTTPS 反向代理，设置 `AI_PROJECT_OS_SECURE_COOKIES=true`，限制数据库和应用端口来源，并为登录、OIDC 发起和初始化配置入口限流。只有确认全站 HTTPS 后才启用 HSTS。Nginx 示例需替换域名和证书路径并通过 `nginx -t`。

GitHub Actions 在 push 和 pull request 上执行 Prisma/迁移校验、Lint、类型检查、测试、PostgreSQL 门禁、生产浏览器与无障碍 E2E、性能预算和隔离 Compose 候选构建。CI 不读取真实模型、Git、OIDC 或 MCP 凭据。绿色 CI 不等于正式部署、备份恢复或外部服务现场验收；顺序和隔离边界见[持续集成与浏览器门禁](./continuous-integration.md)和[本地持续交付候选门禁](./local-release.md)。

## 3. 用户运营、GitHub OAuth 与 OIDC

### 3.1 团队与会员

在 `/admin/users` 和用户详情页中，平台管理员可以维护账号状态、会员资格和用户额度摘要。会员操作只改变会员记录和审计，不改变 `AppUser` 角色或工作区角色。工作区 Owner/Admin 的邀请、角色调整仍限制在所属工作区，并保留至少一位启用的 Owner；平台管理员不代替用户进入项目或团队页面。

新用户领取的试用额度、会员期限和自定义模型权限应以当前产品策略和服务端 entitlement 判断为准；页面不能因为用户可见就宣称任何未来免费模型供给已经上线。未定价的会员套餐先以内部成本模型评估，不能在页面硬编码未经批准的价格。

### 3.2 会员和历史证据

当前测试环境按全新身份边界使用，不需要为旧数据设计迁移或兼容流程。会员变更只写入会员记录和审计，不会把平台管理员变成工作区 Owner，也不会让平台管理员代持普通用户的连接。

治理清单由只读盘点生成候选内容后离线编制，必须覆盖数据库当前全部 `pending` 行，每行明确 `confirm` 或 `revoke`，并绑定成员行指纹、身份、角色、工作区/项目和全量盘点指纹。清单使用 Ed25519，由两个不同的受信外部签名者批准；签名者公钥只能放在受控的 `MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_JSON` 注册表中，不能从清单或审批文件带入。审批文件不包含私钥。

执行前应完成数据库备份和人工复核。先运行无写入的盘点/校验，再在隔离维护窗口显式添加 `--apply`：

```bash
MEMBERSHIP_GOVERNANCE_INVENTORY_DATABASE_URL='受保护的只读数据库地址' \
  pnpm db:membership-governance-inventory > membership-inventory.json

MEMBERSHIP_GOVERNANCE_TRUSTED_SIGNERS_JSON='{"signer_a":"受信Ed25519公钥PEM","signer_b":"受信Ed25519公钥PEM"}' \
MEMBERSHIP_GOVERNANCE_APPLY_DATABASE_URL='受保护的治理数据库地址' \
MEMBERSHIP_GOVERNANCE_EXECUTOR_LABEL='maintenance-window-20260904' \
  pnpm db:membership-governance-apply -- \
    --manifest membership-manifest.json \
    --approval approval-a.json \
    --approval approval-b.json \
    --apply
```

盘点同样只接受 `MEMBERSHIP_GOVERNANCE_INVENTORY_DATABASE_URL`，不会回退到 `DATABASE_URL`。`MEMBERSHIP_GOVERNANCE_APPLY_DATABASE_URL` 是唯一允许执行写入的数据库变量；没有 `--apply` 时只做解析和双签校验。执行在单个 `SERIALIZABLE` 事务中完成，清单过期、数据库指纹变化、成员身份/角色漂移、漏项/多项、签名不满足双人要求或会移除最后一位 enabled confirmed Owner 时整批失败。成功执行会保存不可修改的清单、签名注册表指纹、签名/公钥证据和成员审计证据；相同清单重放只返回 `alreadyApplied`，不会重复成员变更或审计。

数据库触发器和服务端守卫会拒绝缺失或不一致同事务证据的普通应用路径/直接 DML；账号访问、个人 AI、Git、MCP 与会员治理使用的 `app.*` 事务上下文同样依赖受信的应用数据库会话，不能被描述为抵抗已取得 runtime 数据库凭据或任意 SQL 能力的独立授权边界。拥有 governance execution、approval、audit 全表写权限的数据库凭据仍可能构造结构自洽的伪证据，数据库超级用户或能够执行任意进程代码的攻击者也可能停用触发器或篡改受信注册表环境变量，这些不属于本工具的防御边界。Ed25519 的密码学验签由本地执行器完成，PostgreSQL 只校验证据结构、指纹、事务和清单/审计绑定，不应被视为原生 Ed25519 验签器。生产环境应将常驻 app/worker、迁移 owner 与仅维护窗口可用的离线 governance apply 角色隔离并最小授权，限制 runtime 角色执行任意 DDL 或治理表写入；当前 Compose 复用 `POSTGRES_USER` 仅用于本地开发，不是生产权限基线。

### 3.3 GitHub 登录

在 GitHub OAuth App 登记当前站点的回调地址，例如本地：

```text
http://127.0.0.1:3000/api/auth/github/callback
```

凭据只写入未提交的部署配置或受控密钥管理，不写入源码、文档、URL 或日志。`AI_PROJECT_OS_PUBLIC_ORIGIN` 必须是浏览器实际访问的规范 origin，不能填容器内部地址。当前生产 job 只精确允许目标 `v0.6.0-dev.5`，并要求显式选择实际运行的 `v0.5.0-dev.1` 或 `v0.5.0-dev.4` 源版本；其他标签均失败关闭，不要因为配置了 GitHub Secret 就绕过标签 CI、备份恢复、旧库预检和停写切换门禁。

用户首次使用 GitHub 登录且系统不存在同邮箱账户时，系统会创建普通用户账号、为其创建独立的个人工作区并授予该工作区 Owner，不会自动加入其他人的工作区；同邮箱已存在时不得静默合并，用户应先登录原账号，再走明确绑定流程。临时访问令牌验证后立即撤销，不作为长期 Git 凭据保存。

### 3.4 企业 OIDC

在身份提供商登记：

```text
http://127.0.0.1:3000/api/auth/oidc/callback
```

生产环境使用 HTTPS 站点回调。管理页面需要填写名称、Issuer URL、Client ID/Secret、包含 `openid` 的 scopes、Token 端点认证方式、自动加入角色、是否允许自动建号和邮箱域名。公司内网身份源才开启受信任内网访问。

保存时服务端读取 Discovery，检查 Authorization Code、PKCE 和允许的签名算法，固定 Discovery、Token 与 JWKS 地址。公网端点要求 HTTPS，云元数据地址始终阻止。登录回跳只允许单前导斜杠本站路径；绝对 URL、反斜线和编码路径分隔符必须拒绝或安全降级。登录时校验 issuer、audience、nonce、过期时间和 JWKS 签名；相同邮箱不会自动绑定已有本地账户。

## 4. 平台模型与有效能力来源

### 4.1 当前模型供应商管理流程

在 `/admin/models` 配置并测试 OpenAI、DeepSeek、Qwen 或 GLM 的平台连接。平台能力配置页同时负责供应商连接、模型信息和逐项能力选择；连接表单填写完成后可以先测试，只有测试通过才能保存并启用，状态文案统一为“启用/停用”。API Key 只在服务端以 AES-256-GCM 加密保存，页面只显示受限状态和掩码信息，禁止读取、记录或复制明文。

在 `/admin/models` 的能力卡片中分别为视觉、抽取、向量和生成能力选择已验证可用的模型；不创建路由草稿，也不通过额外路由页面绕过测试。`/admin/credits` 管理新注册赠送策略、额度记录和人工额度治理；`/admin/operations/probes` 设置供应商连接探测预算、告警阈值和有效期。DeepSeek 可用于生成能力，GLM 可按已验证能力用于向量能力；不要把某个供应商的存在写成永久免费的承诺。普通用户使用平台额度；只有有效会员可以维护个人模型连接，且个人模型必须经连接所有者与项目 Owner 双确认委托后才可在项目中使用，不会自动替代平台默认模型。会员到期或撤销后不能继续测试、启用或调用个人模型。

平台表单允许自定义模型 ID，但每种 capability 仍需符合服务端供应商协议和能力校验。GLM 可以只配置向量模型与维度，生成/视觉字段保持未配置时应保存为 `null`；DeepSeek 的默认生成模型和现有视觉意图不能因该兼容路径回归。连接测试只展示真实能力的布尔/维度结果，例如“向量连接通过（1024 维）”，不展示模型返回正文。

项目内不维护独立 AI 路由；有效能力来自平台默认模型，或来自已完成连接所有者与项目 Owner 双确认的个人模型委托。切换有效模型来源、生成/视觉模型，或向量模型/维度会影响后续任务；向量变化会让活动索引失配，必须重建索引。任何外发都需要项目页面的当次确认。

### 4.2 平台额度与会员审计

管理总览的平台额度数据来自只读数据库聚合：累计发放、当前可用、**预留 / 待对账占用**和已确认消耗。不得调用会恢复过期预留、产生写入的运行时摘要函数来渲染总览。无法可靠计算的字段不要显示；页面不返回个人账本、邮箱、密钥尾号或完整运行载荷。

## 5. 个人连接与 MCP 安全边界

### 5.1 Git 连接

管理员没有 Git 连接配置页面。旧的 `/admin/connectors/git` 只作为受守卫的退场跳转，不接收凭据，也不应作为操作入口。个人 Git 连接和项目页的一次性手动只读委托由用户和项目 Owner 管理，平台管理员不代替用户持有或配置凭据。

个人 Git 连接应使用最小只读权限。GitHub fine-grained PAT 只授权所需仓库的 Contents Read；不要使用个人主 SSH Key，建议单独创建只读 Deploy Key。管理员冻结页面不会保存、验证或轮换任何凭据。

账号停用会让旧个人 Git 连接及其委托、手动运行链失去执行资格；恢复账号不会自动复活旧链。最终读取准入记录先于停用提交时，该次已经获准的读取仍可完成，因此操作历史必须按最终准入时间解释，不能把停用描述为追溯撤销已经获准的网络请求。

平台 Git 连接的旧管理员配置和 legacy 项目仓库新增接口均已退场：项目仓库页面不再请求全局连接列表，也不提供管理员选择平台连接并首次关联仓库的入口。用户可在个人中心维护自己的连接，并在项目页完成双确认后发起一次性手动只读读取；自动化、写入/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准。

### 5.2 MCP 只读工具

当前 `/admin/connectors/mcp` 提供净化快照和候选的管理员不可变审核；旧版管理员 MCP 端点添加、发现和凭据轮换入口已冻结，不会读取或提交 Bearer Token。个人 MCP 连接由用户在个人中心创建、停用和发现工具，凭据归该用户所有；管理员不代持或配置个人 Token。

个人 MCP 连接执行工具发现时会固化目录，并限制工具总数、Schema 深度和响应大小；有效定义保存输入/输出 Schema、annotations 和 SHA-256 指纹。只有明确 `readOnlyHint=true` 且 `destructiveHint=false` 的定义才可进入管理员认证流程；annotations 属于不可信提示，不能替代管理员认证。

账号停用会让旧个人 MCP 连接、认证、项目授权和待执行动作链失去执行资格；恢复账号不会自动复活旧链。最终外发边界先于停用提交时，该次已经获准的单次请求仍可收口，响应歧义保持 `unknown` 且不自动重试。

管理员对精确工具、当前网络解析和凭据指纹执行净化审核，审核/撤销写入追加式审计。工具定义、DNS、凭据或连接状态变化会使旧审核失效，需重新发现并审核。项目 Owner 在项目页面管理连接委托和只读工具授权；远端动作调用、调用审批、派发、结果查看和结果导入当前均未开放，不能通过内部 API 绕过，也不能把隔离门禁结果作为当前页面能力验收。

隔离门禁中的成功 MCP 结果只能作为净化、受限的内部证据，不构成当前产品结果能力；当前页面和公开 API 不提供远端结果查看或纳入。它不会创建 `ProjectSource`、自动成为事实、进入 RAG/记忆/模型上下文，也不会触发后续动作。

## 6. 资料、记忆、计划和治理的运维边界

管理员负责平台能力就绪和安全审计，项目资料仍由项目角色维护。文件、网页、仓库资料要保留来源身份；解析、网页刷新和仓库扫描失败时不得替换上一代完整活动版本。图片/扫描 PDF 的视觉识别必须由用户逐次确认并逐片段审核。

自动抽取只输出带来源摘录的候选；项目 Owner/Editor 审核后才进入事实。统一向量索引在资料或有效模型来源变化后重建，RAG 只能引用本次检索集合。项目世界状态由当前有效事实、关系和计划健康度的确定性规则计算，模型不能确认事实、建立关系、替代旧事实或覆盖状态。

项目计划中的智能体建议只能进入 `proposed`；负责人、验收标准、完成证据、依赖和状态由用户操作并留下追加审计。仓库变化只生成可核对信号，不自动创建工作项或动作。动作策略、Owner 审批、租约失败关闭和 MCP 漂移校验不可省略。

## 7. 备份与恢复

### 7.1 一致备份窗口

升级或高风险运维前，记录不含业务内容的迁移账本、健康状态和安全计数。短暂停止 app/worker 时让 postgres 保持运行，创建受限权限的持久备份目录；备份必须包括 PostgreSQL 自定义格式 dump、凭据主密钥和 uploads。不要把临时目录作为唯一备份。

示例（数据库连接参数应从受保护配置读取，不要把值写入命令历史）：

```bash
docker compose exec -T postgres pg_dump -U ai_project_os_cluster_admin -d ai_project_os -Fc > ai-project-os.dump
pg_restore -l ai-project-os.dump
```

确认 dump 非空且 `pg_restore -l` 可解析；文件权限至少收紧到 `0600`，备份目录 `0700`。数据库、`ai-project-os-secrets` 主密钥卷和 `ai-project-os-uploads` 文件卷必须来自同一备份窗口并一起恢复。丢失主密钥会使已保存模型、Git、MCP 和 OIDC 凭据无法解密，丢失 uploads 会使原始文件不可恢复。

生产单节点可按[生产异地备份](./production-backup.md)使用 root-only 脚本和 systemd timer，在停写窗口生成三类数据、使用 age 公钥加密并上传 COS。只有远端长度与 CRC64 验证通过的本地目录参与保留期清理；项目 JSON 导出、健康接口或仅看到 COS 对象都不能替代独立恢复演练。

### 7.2 恢复核对

恢复后依次确认迁移账本无失败/回滚、postgres/app/worker healthy、`migrate` 成功退出、`/api/health` 显示数据库和 Worker 正常、三个持久卷仍挂载。再核对项目/连接/上传等安全计数没有下降，抽样验证凭据可以解密但绝不输出其内容。恢复演练应使用隔离卷和端口，不要直接覆盖正式数据。可执行的本地步骤与生产独立主机边界见[恢复演练 Runbook](./recovery-drill.md)。

## 8. 管理员故障排查与验收

| 现象 | 管理动作 |
| --- | --- |
| 总览显示 Worker 异常 | 先看 `/api/health` 的 `worker.status`、心跳和安全错误码，再检查 worker 容器单行 JSON 日志与重启次数 |
| 模型连接不能验证 | 检查内置 provider、能力字段、模型 ID、网络解析和凭据状态；不要放宽 Base URL 白名单 |
| GLM 只做向量 | 保持 generation/vision 为 `null`，配置已验证 embedding 模型和维度；测试文案只列真实能力 |
| Git 仓库新增被拒绝 | 当前 legacy 项目仓库新增已冻结；请使用个人 Git 连接和项目页双确认的一次性手动只读读取。已关联仓库仍按历史边界保留，自动同步和写入不开放 |
| Git 地址变化 | 重新执行连接验证，核对 DNS/CA/known_hosts，不要盲目接受新地址 |
| MCP 工具不能授权 | 在个人中心重新发现并核对只读/非破坏性声明；管理员复核净化快照、网络和凭据指纹，项目 Owner 重新管理连接委托和只读工具授权。远端动作调用、审批和派发当前未开放 |
| 迁移失败 | 保留数据库和日志现场，停止 app/worker；不要删卷、手工改账本或降级迁移 |
| 备份无法解析 | 停止恢复，保留原备份并重新生成；不得用导出 JSON 代替 dump+主密钥+uploads |
| 普通用户看到平台入口 | 检查 Header、旧 URL 服务端守卫和 `/api/settings/*`/`/api/system/*` 直接请求，不能只依赖页面隐藏 |

正式验收至少包含：`pnpm db:generate`、迁移校验、typecheck、Lint、定向及完整测试、生产构建、隔离 PostgreSQL 门禁、浏览器 smoke、Compose 健康、备份解析与恢复演练。真实模型、Git、OIDC、MCP 未配置时必须明确排除现场验收，不能用静态检查冒充。

相关基线：[部署安全基线](./deployment-security.md)、[运行监控基线](./monitoring.md)、[持续集成与浏览器门禁](./continuous-integration.md)、[本地持续交付候选门禁](./local-release.md)、[外部服务现场验收](./external-service-acceptance.md)。
