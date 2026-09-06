# AI Project OS

AI Project OS 是一套可本地部署、证据驱动的项目运营工作台。它将人工资料、文件、网页与多 Git 仓库整理为可追溯、可审核的项目证据，并在此基础上提供项目状态、语义检索、引用式 RAG、自动化和受审批约束的只读操作。

外部模型、Git、OIDC 与 MCP 需由每个部署自行配置并现场验证；模型输出与自动抽取结果均需人工审核。项目智能体和 MCP 不具备 Shell、代码修改、Git 写入、合并或部署权限。

当前版本状态：`INTERNAL_DEVELOPMENT` · `0.2.0-dev.1`

正式发布基线：无。已发布的内部 prerelease 基线为 `v0.1.0-dev.1`，当前开发版本为 `0.2.0-dev.1`；首个正式公开版本计划为 `1.0.0`，在此之前生产部署入口静态禁用，任何内部开发版本都不得进入生产 tag 通道。

0.2.x 当前仅表示内部开发版本。会员个人模型与平台默认模型路由已按现行页面和服务端权限开放；Git 用户私有连接与双确认后的一次性手动只读读取已按当前页面开放。MCP 的精确授权、一次性只读 Streamable HTTP 派发和结果留存目前只完成后端/API 控制面，项目页面入口尚未开放，不构成当前用户可用能力，第三方现场能力也仍未验证。

## 从哪里开始

- 页面指南：启动后打开 <http://127.0.0.1:3000/guide>。
- 普通用户完整指南：[docs/user-operation-guide.md](docs/user-operation-guide.md)。
- 系统管理员完整指南：[docs/admin-operation-guide.md](docs/admin-operation-guide.md)。
- 兼容索引：[docs/operation-manual.md](docs/operation-manual.md)。
- 部署安全基线：[docs/deployment-security.md](docs/deployment-security.md)。
- GitHub Actions 生产部署（未来能力，当前禁用）：[docs/production-deployment.md](docs/production-deployment.md)。
- 单节点主机迁移与恢复：[docs/production-host-migration.md](docs/production-host-migration.md)。
- 运行监控基线：[docs/monitoring.md](docs/monitoring.md)。
- 持续集成与浏览器门禁：[docs/continuous-integration.md](docs/continuous-integration.md)。
- 本地持续交付候选门禁：[docs/local-release.md](docs/local-release.md)。
- 外部服务现场验收：[docs/external-service-acceptance.md](docs/external-service-acceptance.md)。
- 当前内部开发状态：[docs/releases/next.md](docs/releases/next.md)。
- V5.1.2 内部研发里程碑记录（非正式发布）：[docs/releases/v5.1.2.md](docs/releases/v5.1.2.md)。
- V5.1.1 内部研发里程碑记录（非正式发布）：[docs/releases/v5.1.1.md](docs/releases/v5.1.1.md)。
- V5.1.0 内部研发里程碑记录（非正式发布）：[docs/releases/v5.1.0.md](docs/releases/v5.1.0.md)。
- V5.0.1 内部研发里程碑记录（非正式发布）：[docs/releases/v5.0.1.md](docs/releases/v5.0.1.md)。
- V5.0.0 内部研发里程碑记录（非正式发布）：[docs/releases/v5.0.0.md](docs/releases/v5.0.0.md)。
- V4.1.0 内部研发里程碑记录（非正式发布）：[docs/releases/v4.1.0.md](docs/releases/v4.1.0.md)。
- V4.0.0 内部研发里程碑记录（非正式发布）：[docs/releases/v4.0.0.md](docs/releases/v4.0.0.md)。
- V3.2.0 内部研发里程碑记录（非正式发布）：[docs/releases/v3.2.0.md](docs/releases/v3.2.0.md)。
- V3.1.0 内部研发里程碑记录（非正式发布）：[docs/releases/v3.1.0.md](docs/releases/v3.1.0.md)。
- V3.0.0 内部研发里程碑记录（非正式发布）：[docs/releases/v3.0.0.md](docs/releases/v3.0.0.md)。
- 版本记录：[CHANGELOG.md](CHANGELOG.md)。
- 历史 CLI 手册：[docs/v1-operations.md](docs/v1-operations.md)，仅用于兼容旧流程。

推荐首次使用顺序：

1. 启动 Docker Compose，初始化本地管理员。
2. 由系统管理员在“管理工作台 → 平台模型”（`/admin/models`）添加并测试 OpenAI、DeepSeek、Qwen 或 GLM。
3. 进入项目仓库页查看已有安全摘要；旧版项目 Git 连接、首次关联和同步入口已冻结。个人 Git 连接可在个人中心配置，项目页支持完成双确认后发起一次性手动只读读取；自动化、写入/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准。
4. 项目 MCP 页面当前仅显示未开放状态，不提供工具发现、授权、动作创建、派发或结果查看。对应后端/API 控制面仍处于内部门禁验证：管理员安全审查和项目授权要求精确指纹与当前 Owner，预约和最后一次外发前检查阶段若发现撤销或漂移会在 POST 前阻止请求；外发边界之后无法追溯撤销，超时、断连或响应歧义进入 `unknown` 且不会重试。
5. 创建项目，在项目“智能控制台”分配视觉、抽取、向量与生成模型。
6. 上传文件，或添加网页、本地文件夹；历史仓库资料仅保留迁移期安全摘要，不启动新的外发同步。
7. 审核 AI 候选并建立语义索引。
8. 在“项目状态”核对当前事实，人工建立关系、替代链并固化状态快照。
9. 使用语义搜索、引用式问答和只读项目智能体。
10. 在“自动化”“记忆质量”和“通知”中维护长期运行状态。
11. 在项目“动作与审批”中选择动作策略，核对待审批动作和执行审计。
12. 后端成功的 MCP 动作只保留受限、净化且仅允许直接项目 Owner 读取的结果证据；当前页面没有查看或纳入口，也不会创建项目来源。Editor 纳入、资料导入、事实确认、索引和模型上下文均需后续明确开放。
13. 在“项目计划”中为工作项设置负责人、期限和验收标准，关联已确认事实、活动来源或仓库同步证据，再由人推进状态。
14. 人工核对仓库变化信号并关联到相关工作项，或明确忽略；需要定期提醒时创建“项目计划健康提醒”自动化。
15. 需要协作时，在“团队”中创建成员、邀请链接或 OIDC 身份源。

## 当前能力

| 能力 | 0.2.0-dev.1 当前开发线行为（承接 v0.1.0-dev.1） |
| --- | --- |
| Dashboard | 汇总跨项目世界状态、配置就绪度、计划风险、运营提醒、推荐下一步和最近任务；项目管理保持为独立顶部入口 |
| 项目与个人中心 | 项目搜索、创建、软归档、恢复和受限 JSON 导出；个人资料、登录名、密码和活动会话管理 |
| 多用户与 RBAC | 工作区角色 Owner/Admin/Member/Viewer，项目角色 Owner/Editor/Viewer；服务端对页面和 API 统一鉴权 |
| 邀请、GitHub 登录与 OIDC | 邮箱限定邀请；GitHub OAuth Authorization Code + PKCE 与个人中心显式绑定；OpenID Connect Authorization Code + PKCE、受控自动建号和企业内网显式授权 |
| 模型供应商 | 页面配置 OpenAI、DeepSeek、Qwen、GLM 的 API Key、生成/视觉/向量模型并测试连接；密钥不回显 |
| 项目 AI 路由 | 每个项目独立选择图片识别、自动抽取、向量索引和引用式生成模型；路由变更保留审计与影响提示 |
| 文件与图片识别 | TXT、Markdown、JSON、CSV、PDF、DOCX、PPTX、XLSX、PNG、JPEG、WebP；本地解析文本，图片和扫描 PDF 经当次授权后调用视觉模型并逐片段审核 |
| 外部资料 | 抓取公开网页或经明确授权的内网页面；浏览器选择本地文件夹后按文件批量导入；来源版本原子发布 |
| 多 Git 连接 | 个人 Git 连接、项目双确认委托和一次性手动只读读取已开放；自动化、写入/提交、旧版项目/管理员入口和旧 PAT 路径保持关闭，目标 Git 服务是否可用以连接测试和单次读取结果为准，页面不暴露凭据、CA 或 known_hosts |
| 受控 MCP 连接与结果留存 | 精确授权、一次性只读派发和结果留存仅完成后端/API 控制面并处于内部门禁验证；项目页面入口、Editor 纳入、资料导入和第三方现场验证均未开放，不能视为当前用户能力 |
| 多仓库记忆 | 已关联仓库的历史资料保留安全边界；项目页可对已双确认委托发起一次性手动只读读取，自动同步和写入仍冻结 |
| GitHub 扩展资料 | 既有 GitHub 专用项目连接、CLI 和同步入口在迁移期间冻结；个人连接委托仅支持当前项目页的一次性手动只读范围 |
| 自动抽取与审核 | 从明确选择的资料抽取 decision、progress、issue、risk；结构与连续原文验证通过后进入人工审核 |
| 时态项目世界模型 | 只用当前有效、已确认事实计算项目状态；支持版本绑定的支持/冲突/依赖/阻断/因果/解决/相关关系、同类型事实替代链、陈旧关系提示、不可变状态快照和追加式治理审计 |
| 统一向量记忆 | 对人工/文件/网页/仓库资料和代码快照确定性分块；支持增量构建与全量重建，完成后原子切换索引 |
| 语义搜索与 RAG | 向量和关键词混合排序；回答只能引用本次检索命中的不可变证据记录 |
| 项目简报与只读智能体 | 复用确定性项目状态、当前事实、关系、输入指纹、语义记忆和仓库状态；模型计划只能调用固定的项目内只读工具，不能覆盖系统状态 |
| 自动化 Worker | Compose 独立 Worker 持久化领取规则、租约与运行结果；支持仓库同步、网页刷新、记忆质量、项目计划健康，以及需要人工确认的模型任务提醒 |
| 动作与审批 | 项目级策略控制自动执行、每次审批或禁止执行；网页刷新和记忆质量检查按项目策略运行；MCP 单次审批派发仅存在于尚未开放页面入口的后端/API 控制面 |
| 项目运营闭环 | 工作项维护可编辑负责人、期限、独立验收标准和证据关联；开始前校验负责人/验收标准，完成前强制至少一条活动证据；终态不可改写 |
| 仓库变化与项目健康 | 从成功且完成对账的仓库同步生成确定性变化信号，由人关联或忽略；按逾期、受阻、依赖、负责人、验收、证据、建议、审批计算健康状态 |
| 记忆质量 | 确定性识别重复、冲突、过期、证据不足和低置信度记忆；可维护置信度、重要性、有效期、置顶和人工复核时间 |
| 通知中心 | 汇总自动化成功、失败、记忆质量、项目计划健康与模型外发待确认通知，支持已读状态 |
| 治理与审核 | 候选审核、历史成员资格双人签名清单、异常任务收口、模型路由历史和 7/30/90 天用量核对 |

## 配置入口

平台配置仅由 system admin 在管理工作台维护；旧设置/连接器 URL 仅作服务端角色检查后的兼容跳转。业务配置均位于页面：

- `/admin/models`：平台模型、能力、自定义模型 ID 与 API Key（system admin）。
- `/admin/connectors/git`：Git 连接迁移/冻结说明（system admin），不接收用户凭据。
- `/admin/connectors/mcp`：MCP 连接迁移/冻结说明（system admin），不接收用户 Bearer Token。
- `/admin/users/memberships`：用户会员资格（system admin）。
- `/admin/operations/backups`：备份/运维状态（按初始超级管理员规则）。
- `/team`：成员、邀请和 OIDC。
- `/projects/:projectId/control`：项目级 AI 路由。
- `/projects/:projectId/repositories`：个人 Git 委托安全摘要、双确认和一次性手动只读读取。
- `/projects/:projectId/world`：当前项目状态、事实关系、替代链、冲突、快照与审计。
- `/projects/:projectId/external-sources`：网页与本地文件夹资料。
- `/projects/:projectId/automations`：自动化规则与运行记录。
- `/projects/:projectId/actions`：动作策略、审批与执行审计。
- `/projects/:projectId/tools`：项目 MCP 未开放状态页；当前不提供工具授权、调用动作或结果入口。
- `/projects/:projectId/plan`：目标、负责人、期限、验收标准、证据、仓库变化、健康、依赖和审计。

`.env` 只承载部署基础设施参数，例如数据库连接、端口和安全 Cookie 开关；模型 API Key、Git Token、SSH Key、MCP Bearer Token 与 OIDC Client Secret 不写入环境变量。

## 安全与可信边界

- 密码使用 scrypt 与随机盐；会话 Token 只保存 SHA-256；Cookie 为 HttpOnly、SameSite=Lax。
- 模型、Git、MCP 和 OIDC Secret 使用 AES-256-GCM、随机 nonce、认证标签与用途绑定 AAD；API 不返回明文或密文。
- Git HTTPS 执行固定验证过的 DNS 地址并拒绝重定向；SSH 固定解析地址，同时以原主机名校验 known_hosts。云元数据地址始终阻止，私网必须显式授权。
- 网页与 OIDC 服务端请求固定 DNS 解析、限制响应大小并阻止云元数据地址；公网默认要求 HTTPS。
- OIDC 校验 issuer、audience、nonce、过期时间和允许的 JWKS 签名算法；未知身份不会仅凭相同邮箱自动绑定到已有账户。
- OIDC returnTo 只允许本站单斜杠路径，编码分隔符、绝对地址和协议相对地址会被拒绝或降级；每个身份源最多保留 200 条未消费流程，并在事务内清理/淘汰旧流程。匿名 churn 的速率限制仍需由部署层提供。
- 历史工作区/项目成员默认进入 `pending` 隔离状态；只有覆盖全量待审核行、绑定盘点指纹并通过两个不同受信 Ed25519 签名者批准的离线清单才能确认或撤销。清单执行器使用专用数据库地址、单事务和不可变证据，详见[管理员操作指南](docs/admin-operation-guide.md#32-历史成员资格治理)。
- 仓库扫描先固定远端 commit，再在隔离临时目录读取受控范围；Git 交互、系统/全局配置、钩子和非目标协议均关闭。
- JSON 请求体和 multipart 上传均按实际流式字节数限制；上传文件核对扩展名与真实格式，限制压缩包条目、解压体积、图片像素和 PDF 页数。PDF 视觉渲染还会在分配画布前限制边长和像素预算。
- 模型输出和网页内容一律视为不可信数据；抽取证据、RAG 引用与智能体工具结果均由服务端验证项目边界。
- 索引、仓库快照和网页修订失败时不会替换上一代完整活动版本。
- 项目归档会暂停活动自动化；运行中任务会阻止归档，恢复项目不会自动恢复原自动化规则。
- 动作创建会固定能力、规范化输入、输入指纹和当时的项目策略。需要审批的动作仅由项目 Owner 决策，24 小时后自动过期。
- 动作 Worker 使用持久化租约和心跳。租约过期会失败关闭，不自动重复外部读取；项目归档会取消尚未执行的动作并阻止新动作领取。
- MCP 工具定义采用追加式快照。远端 annotations 只保存为不可信提示，不能直接产生授权资格；管理员必须对精确工具定义追加式认证并可追加撤销审计，认证绑定工具、网络和凭据指纹。项目 Owner 逐项授权，每次调用单独审批；最后一次外发边界记录前会重新核对认证、授权、工具定义、DNS 和凭据指纹，边界前发现漂移或撤销会失败关闭。边界记录后不承诺追溯撤销，传输歧义进入 `unknown` 且不重试。
- 内部 MCP 动作结果读取服务只允许直接项目 Owner；公开 API 与项目页面均固定关闭，Editor 纳入、资料导入、事实确认、索引或模型调用也未开放。
- 智能体建议纳入计划时固定建议索引、引用快照、运行输入清单指纹和证据指纹。建议只进入 `proposed`，状态推进与依赖调整必须由用户完成并留下追加式审计。
- 工作项开始或完成前必须有当前可编辑负责人和验收标准；完成前还必须关联活动证据。证据以内容快照和 SHA-256 指纹固化，移除只做软移除，完成/取消后的工作项不可改写。
- 仓库变化信号只来自成功且完成对账的同步记录，并明确不推断业务影响。关联或忽略必须由 Editor/Owner 人工决定，原始信号与计划审计保持可追溯。
- 事实关系只允许连接同项目、当前已确认事实，并固定双方精确修订和证据清单。事实变化后旧关系标记为陈旧，不会静默迁移到新版本。
- 事实替代只允许同类型、已确认事实建立单一无环链；旧事实保留确认时间、来源证据和修订历史。状态快照与世界模型审计只追加、不覆盖。
- Dashboard、项目简报和只读智能体复用同一确定性项目状态与输入指纹。模型不能确认事实、建立关系、替代事实或修改状态。
- 项目计划健康与提醒只读取本地数据库，不调用模型、不向外发送项目内容；通知发送前重新核对接收者当前项目访问权。

## 当前限制

- 当前 `0.2.0-dev.1` 内部开发版本承接 `v0.1.0-dev.1` 的默认工作区；数据模型支持多个工作区，但页面尚未提供工作区创建和切换。会员个人模型与平台默认模型路由按现行页面和服务端权限提供；旧版项目 GitHub、管理员连接和 MCP attestation 入口保持冻结。
- OIDC 不提供“按邮箱自动合并已有本地账户”。已有账户需要未来的显式身份绑定流程；当前遇到相同邮箱会拒绝登录，避免账户劫持。
- Git 通用连接器和 GitHub 扩展资料的既有外发入口在迁移期间冻结；Issue、PR、Release 等扩展资料的个人连接能力属于 planned 范围。
- 网页来源只抓取服务端可读取的静态文本，不执行 JavaScript，也不提供页面登录或自定义请求头。
- Office 内嵌图片、音频和视频不会识别；单文件最大 25 MiB，其他细分限制见操作手册。
- 模型调用使用用户自己的供应商额度，可能产生费用；系统不维护实时价格，因此不估算账单。
- 自动化可以自动同步仓库、刷新网页和运行确定性质量检查；涉及向模型发送内容的索引与简报任务只创建待确认通知，不会绕过当次授权。
- 动作中心不是通用 Agent 工具平台。三个内置能力仍使用固定输入；MCP 派发与结果控制面当前仅供隔离门禁验证，公开 API 与产品页面均固定关闭，也不能接受模型生成或批准的工具调用。
- MCP 不支持 stdio、本地子进程、独立旧式 SSE、执行中继续索取输入、自动执行或任何写操作；同一 POST 的 request-scoped JSON/SSE 响应仍需严格匹配持久请求 ID。伪造或篡改服务端 annotations 不能绕过管理员认证；接入方仍需使用可信服务和最小权限只读凭据。
- 隔离门禁中的 MCP 成功结果仅保留受限、净化且由内部服务限制为直接 Owner 读取的证据；公开 API 与当前页面不提供查看或纳入。结果不会自动成为项目资料或事实、建立索引、进入模型上下文，也不会自动展开图片、音频和资源链接。
- 项目计划不会自动生成执行动作。智能体建议、仓库变化信号和健康提醒都必须由人核对；系统不会因此修改代码、调用工具、创建分支/PR、合并或部署。
- 项目世界模型不会自动推断或创建事实关系，也不会自动解决冲突。当前状态是确定性汇总，不代表业务真伪已经由系统证明；关系、替代和冲突处置仍需人工判断。
- 智能体没有 Shell、任意文件系统、代码修改、Git 写入、部署或 MCP 工具调用权限；MCP 后端派发当前只由隔离门禁直接调用，公开 API 与产品页面都没有可用入口。
- 受限 JSON 导出不是数据库备份，不包含凭据、向量、上传二进制和完整运行账本。

## 本地 Docker 部署

要求：Docker Desktop。

```bash
cp .env.example .env
# 编辑 .env，至少设置 POSTGRES_PASSWORD；不要提交 .env
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

打开 <http://127.0.0.1:3000>。正常状态应为：

- `postgres`：healthy
- `migrate`：Exited (0)
- `app`：healthy
- `worker`：healthy

`/api/health` 会分别报告数据库与 Worker 心跳；Worker 日志为单行 JSON，可按[运行监控基线](docs/monitoring.md)采集和告警。

Compose 默认使用三个命名卷：`ai-project-os-pgdata`、`ai-project-os-secrets`、`ai-project-os-uploads`。不要执行 `docker compose down -v`，该命令会删除数据库、凭据主密钥和上传文件。需要并行运行一次性候选验收时，必须同时改用独立 `POSTGRES_PORT`、`APP_PORT`、`AI_PROJECT_OS_PGDATA_VOLUME`、`AI_PROJECT_OS_SECRETS_VOLUME` 和 `AI_PROJECT_OS_UPLOADS_VOLUME`；不要让候选栈复用正式卷。

面向局域网外提供服务前，应按[部署安全基线](docs/deployment-security.md)配置 HTTPS、入口限流和可信反向代理，并设置 `AI_PROJECT_OS_SECURE_COOKIES=true` 与实际 HTTPS `AI_PROJECT_OS_PUBLIC_ORIGIN`。仓库提供的 Nginx 示例必须替换域名与证书路径并通过 `nginx -t` 后才能启用。当前生产部署入口仍为未来能力，首个正式 `v1.0.0` 前不可执行；`POSTGRES_PASSWORD` 若包含 URL 保留字符，需要先进行 URL 编码。

## 本地开发

要求：Node.js 24+、pnpm 10+、PostgreSQL 18 + pgvector。

```bash
pnpm install
cp .env.example .env
pnpm db:generate
pnpm exec prisma migrate deploy --config prisma.config.ts
pnpm dev
pnpm worker
```

应用默认运行于 <http://localhost:3000>。直接运行时，凭据主密钥默认创建在 `~/.ai-project-os/master.key`，文件权限应为 `0600`。

## 验证

```bash
pnpm test
pnpm test:coverage
pnpm test:performance
pnpm lint
pnpm typecheck
pnpm build
pnpm db:validate
git diff --check

# 需要绑定 127.0.0.1:56432 的一次性 PostgreSQL 18 + pgvector 管理库
pnpm test:postgres-gates
pnpm exec playwright install chromium
pnpm test:browser-e2e
pnpm release:local

V3_POSTGRES_GATE=1 pnpm exec tsx --test test/v3-postgres.test.ts
ACTION_ENGINE_POSTGRES_GATE=1 pnpm test:action-engine-postgres
MCP_CAPABILITIES_POSTGRES_GATE=1 pnpm test:mcp-capabilities-postgres
PROJECT_PLAN_POSTGRES_GATE=1 pnpm test:project-plan-postgres
PROJECT_WORLD_POSTGRES_GATE=1 pnpm test:project-world-postgres
PROJECT_INTELLIGENCE_POSTGRES_GATE=1 pnpm test:project-intelligence-postgres
pnpm exec prisma migrate status --config prisma.config.ts
```

统一 PostgreSQL 与浏览器门禁的隔离环境变量、清理边界和 CI 顺序见[持续集成与浏览器门禁](docs/continuous-integration.md)。所有 PostgreSQL 门禁都必须使用名称可识别、可整体丢弃的专用测试数据库；不得对正式数据库运行。`pnpm build` 使用 Next.js Webpack 构建。真实 PostgreSQL V3 测试使用本地签名 OIDC 服务与隔离测试数据，不调用真实模型供应商。

真实模型、Git、OIDC 和 MCP 验收不能由本地替代服务或 CI 冒充。按[外部服务现场验收](docs/external-service-acceptance.md)完成页面操作后，在同一部署数据库上运行 `pnpm external:acceptance`；命令只读取脱敏证据计数，不会读取或输出凭据。

## 主要页面

- `/dashboard`：跨项目概览、就绪度和最近任务。
- `/projects`：项目管理。
- `/admin`：system admin 管理工作台总览。
- `/admin/models`：system admin 平台模型。
- `/admin/connectors/git`：system admin Git 连接迁移/冻结说明，不接收凭据。
- `/admin/connectors/mcp`：system admin MCP 连接迁移/冻结说明，不接收凭据。
- `/admin/users/memberships`：system admin 用户与会员。
- `/admin/operations/backups`：system admin 备份/运维状态。
- `/settings`、`/connections`、`/connections/mcp`：兼容跳转，非 admin 返回用户工作台。
- `/team`：成员、邀请和 OIDC。
- `/notifications`：通知中心。
- `/profile`：个人资料与登录安全。
- `/guide`：页面操作指南。
- `/projects/:projectId/assets`：文件资料。
- `/projects/:projectId/external-sources`：网页与本地文件夹。
- `/projects/:projectId/repositories`：个人 Git 委托安全摘要、双确认和一次性手动只读读取。
- `/projects/:projectId/world`：时态项目状态、事实关系、替代链、冲突、快照与审计。
- `/projects/:projectId/automations`：自动化。
- `/projects/:projectId/actions`：动作策略、审批和审计。
- `/projects/:projectId/tools`：MCP 未开放状态页，当前不提供授权、调用或结果入口。
- `/projects/:projectId/plan`：目标、负责人、期限、验收标准、证据、仓库变化、工作项、依赖、健康与计划审计。
- `/projects/:projectId/control`：AI 路由。
- `/projects/:projectId/memory`：抽取、索引、搜索和 RAG。
- `/projects/:projectId/memory-quality`：记忆质量与生命周期。
- `/projects/:projectId/intelligence`：简报和只读智能体。
- `/projects/:projectId/governance`：审核、异常与用量。

## 历史材料

V1 CLI 手册和历史运行合同继续保留用于兼容与审计，但不覆盖当前 `0.2.0-dev.1` 开发线的页面能力。当前能力、限制和使用方式以本 README、页面指南和操作手册为准；0.2.x 改造目标仍以需求文档和开发计划为准，不视为已交付能力。
