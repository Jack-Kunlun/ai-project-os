# AI Project OS

AI Project OS 是一套可本地部署、证据驱动的项目运营工作台。它将人工资料、文件、网页与多 Git 仓库整理为可追溯、可审核的项目证据，并在此基础上提供项目状态、语义检索、引用式 RAG、自动化和受审批约束的只读操作。

外部模型、Git、OIDC 与 MCP 需由每个部署自行配置并现场验证；模型输出与自动抽取结果均需人工审核。项目智能体和 MCP 不具备 Shell、代码修改、Git 写入、合并或部署权限。

当前版本状态：`CONTROLLED_PRERELEASE` · `0.6.0-dev.5（受控升级预发布）`

`v0.5.0-dev.1` 的一次性 clean reset 和 `v0.5.0-dev.4` 的无迁移 preserve 通道都属于历史发布路径。`v0.6.0-dev.5` 通过 0.6 专用迁移通道复用现有 PostgreSQL、secrets、uploads、用户、平台配置和审计数据；它在精确标签 CI、停写备份、107 条迁移账本、健康、重启持久性和现场验收完成前，不宣称已经生产部署。

正式稳定版基线：无。当前生产基线为 `v0.5.0-dev.4`，当前受控升级候选为 `v0.6.0-dev.5`；两者仍是预发布，不是稳定版或 GitHub Latest。只有精确的 0.6 候选可进入当前生产 tag 通道，其他内部开发版本均失败关闭。

`v0.6.0-dev.4` 是未部署的历史失败候选：它的标签 CI 在 browser/accessibility 阶段失败，标签保持不可移动且不可复用；当前发布流程只接受 `v0.6.0-dev.5`。

0.5.0-dev.1 是历史受控生产基线，重点是移除默认工作区 Owner 初始化，并收紧普通用户个人工作区与 GitHub 登录的安全边界。平台管理员与普通用户进入不同工作台，权限边界由服务端角色检查保证。平台管理员在 `/admin/models` 管理供应商连接，并为每项能力选择已验证可用的模型；填写连接后可先测试，只有测试通过才能保存并启用，状态文案统一为“启用/停用”。平台默认托管模型按平台额度提供；有效会员可在个人中心维护个人模型，但必须经连接所有者与项目 Owner 双确认委托后才可在项目中使用，个人模型不会自动替代平台默认模型。Git 用户私有连接与双确认后的一次性手动只读读取已按当前页面开放。MCP 个人连接与工具发现、管理员净化快照审核、项目连接委托和只读工具授权控制面已开放；远端动作调用、调用审批、派发、结果查看/导入和真实第三方联调仍冻结或未现场验证，不构成已验证的第三方实时能力。旧管理员 Git、旧会员和账号矩阵路径只保留受守卫的兼容跳转。

0.5.0-dev.2 是供应商弹窗布局优化的受控升级候选：弹窗 Header 与 Footer 固定，表单内容区域独立滚动，且升级通道保留现有业务数据。它仍不是稳定版或已验收的生产部署。

0.5.0-dev.3 是保留数据发布通道的修复候选：修复维护隔离阶段对完整 Docker 容器 ID 的 Bash 算术误判，并保留 `.2` 的供应商弹窗布局优化。它仍不是稳定版或已验收的生产部署。

0.5.0-dev.4 是保留数据发布通道的回滚制品修复候选：生产部署先从精确 `.1` 源 checkout 构建并固定服务级回滚镜像引用，再构建 `.4` 目标镜像；它不把已经无法由 Docker inspect 找到的旧容器镜像记录当作回滚前提。源代码重建的 `.1` 镜像不保证与历史丢失镜像字节级相同，仍需以隔离恢复和现场门禁为准。

0.6.0-dev.5 将个人模型、Git、MCP 和个人知识库收拢到个人工作区；项目状态与治理合并到项目概览，项目配置集中展示项目采用的 AI、Git 和 MCP 连接；Dashboard 显示当前额度。管理后台同时扩大供应商弹窗可用高度并统一滚动条。生产发布新增从 0.5 精确迁移账本到 0.6 的 Actions 通道，迁移后失败保持写入隔离并输出恢复证据。

## 许可与商业授权

本仓库中项目权利人有权授权的软件代码采用 [PolyForm Strict License 1.0.0](LICENSE.md)。这是源码可见许可，不是 OSI 开源许可；具体权利以许可证全文为准。

项目作者署名：**风岚（笔名）**。

- **非商业使用**：可按许可证使用软件。该许可不授予修改、制作衍生作品或分发软件的权利；如需这些权利，须另行取得书面授权。
- **商业使用**：不在上述许可范围内，须事先取得项目权利人的单独书面授权。授权申请邮箱：[1837115857@qq.com](mailto:1837115857@qq.com)。
- **其他材料**：第三方组件适用其各自许可；文档等其他材料未另行授权。

## 从哪里开始

- 页面指南：启动后打开 <http://127.0.0.1:3000/guide>。
- 普通用户完整指南：[docs/user-operation-guide.md](docs/user-operation-guide.md)。
- 平台管理员完整指南：[docs/admin-operation-guide.md](docs/admin-operation-guide.md)。
- 兼容索引：[docs/operation-manual.md](docs/operation-manual.md)。
- 部署安全基线：[docs/deployment-security.md](docs/deployment-security.md)。
- GitHub Actions 受控生产部署：[docs/production-deployment.md](docs/production-deployment.md)。
- 单节点主机迁移与恢复：[docs/production-host-migration.md](docs/production-host-migration.md)。
- 运行监控基线：[docs/monitoring.md](docs/monitoring.md)。
- 持续集成与浏览器门禁：[docs/continuous-integration.md](docs/continuous-integration.md)。
- 本地持续交付候选门禁：[docs/local-release.md](docs/local-release.md)。
- 外部服务现场验收：[docs/external-service-acceptance.md](docs/external-service-acceptance.md)。
- 当前受控预发布状态：[docs/releases/next.md](docs/releases/next.md)。
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

1. 启动 Docker Compose 并初始化平台管理员。配置 GitHub OAuth 后，普通用户首次登录会获得自己的个人工作区及 Owner 身份；平台管理员仍只进入管理工作台，无须创建全局默认工作区 Owner。
2. 由平台管理员在“管理工作台 → 能力配置”（`/admin/models`）添加并测试 OpenAI、DeepSeek、Qwen 或 GLM，再为每项能力选择已验证模型并保存启用；不通过路由草稿或额外路由页面配置。
3. 进入项目仓库页查看已有安全摘要；旧版项目 Git 连接、首次关联和同步入口已冻结。个人 Git 连接可在个人工作区配置，项目页支持完成双确认后发起一次性手动只读读取；自动化、写入/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准。
4. 在个人工作区创建 MCP 连接并发现工具；管理员在 MCP 审核工作台核对净化快照，项目 MCP 页面再管理连接委托和只读工具授权。项目页面不提供远端动作调用、调用审批、派发、结果查看或结果导入；这些能力仍冻结，不能通过内部 API 绕过页面边界。
5. 创建项目，在项目“智能控制台”查看当前可用的视觉、抽取、向量与生成能力；项目内不维护独立模型路由。
6. 上传文件，或添加网页、本地文件夹；历史仓库资料仅保留迁移期安全摘要，不启动新的外发同步。
7. 审核 AI 候选并建立语义索引。
8. 在“项目状态”核对当前事实，人工建立关系、替代链并固化状态快照。
9. 使用语义搜索、引用式问答和只读项目智能体。
10. 在“自动化”“记忆质量”和“通知”中维护长期运行状态。
11. 在项目“动作与审批”中选择动作策略，核对待审批动作和执行审计。
12. MCP 远端动作调用、调用审批、派发、结果查看和结果导入当前均未开放；不得以内部 API 或隔离门禁结果形成产品现场验收证据，也不会由 MCP 结果自动创建项目来源、事实、索引或模型上下文。
13. 在“项目计划”中为工作项设置负责人、期限和验收标准，关联已确认事实、活动来源或仓库同步证据，再由人推进状态。
14. 人工核对仓库变化信号并关联到相关工作项，或明确忽略；需要定期提醒时创建“项目计划健康提醒”自动化。
15. 需要协作时，在“团队”中创建成员、邀请链接或 OIDC 身份源。

## 当前能力

| 能力 | 0.6.0-dev.5 受控升级候选行为 |
| --- | --- |
| Dashboard | 汇总跨项目世界状态、配置就绪度、计划风险、运营提醒、推荐下一步和最近任务；项目管理保持为独立顶部入口 |
| 项目与个人中心 | 项目搜索、创建、软归档、恢复和受限 JSON 导出；个人资料、登录名、密码和活动会话管理 |
| 多用户与 RBAC | 工作区角色 Owner/Admin/Member/Viewer，项目角色 Owner/Editor/Viewer；服务端对页面和 API 统一鉴权 |
| 邀请、GitHub 登录与 OIDC | 邮箱限定邀请；GitHub OAuth Authorization Code + PKCE 与个人中心显式绑定；OpenID Connect Authorization Code + PKCE、受控自动建号和企业内网显式授权 |
| 模型供应商 | 页面配置 OpenAI、DeepSeek、Qwen、GLM 的 API Key、生成/视觉/向量模型并测试连接；密钥不回显 |
| AI 能力与模型使用方式 | 平台默认托管模型由平台管理员维护；有效会员可维护个人模型，并在连接所有者与项目 Owner 双确认委托生效后按项目使用，个人模型不会自动替代平台默认模型 |
| 文件与图片识别 | TXT、Markdown、JSON、CSV、PDF、DOCX、PPTX、XLSX、PNG、JPEG、WebP；本地解析文本，图片和扫描 PDF 经当次授权后调用视觉模型并逐片段审核 |
| 外部资料 | 抓取公开网页或经明确授权的内网页面；浏览器选择本地文件夹后按文件批量导入；来源版本原子发布 |
| 多 Git 连接 | 个人 Git 连接、项目双确认委托和一次性手动只读读取已开放；自动化、写入/提交、旧版项目/管理员入口和旧 PAT 路径保持关闭，目标 Git 服务是否可用以连接测试和单次读取结果为准，页面不暴露凭据、CA 或 known_hosts |
| 受控 MCP 控制面 | 个人连接与工具发现、管理员净化快照审核、项目连接委托和只读工具授权控制面已开放；远端动作、调用审批、派发、结果查看/导入和第三方现场能力仍冻结或未验证 |
| 多仓库记忆 | 已关联仓库的历史资料保留安全边界；项目页可对已双确认委托发起一次性手动只读读取，自动同步和写入仍冻结 |
| GitHub 扩展资料 | 既有 GitHub 专用项目连接、CLI 和同步入口在迁移期间冻结；个人连接委托仅支持当前项目页的一次性手动只读范围 |
| 自动抽取与审核 | 从明确选择的资料抽取 decision、progress、issue、risk；结构与连续原文验证通过后进入人工审核 |
| 时态项目世界模型 | 只用当前有效、已确认事实计算项目状态；支持版本绑定的支持/冲突/依赖/阻断/因果/解决/相关关系、同类型事实替代链、陈旧关系提示、不可变状态快照和追加式治理审计 |
| 统一向量记忆 | 对人工/文件/网页/仓库资料和代码快照确定性分块；支持增量构建与全量重建，完成后原子切换索引 |
| 语义搜索与 RAG | 向量和关键词混合排序；回答只能引用本次检索命中的不可变证据记录 |
| 项目简报与只读智能体 | 复用确定性项目状态、当前事实、关系、输入指纹、语义记忆和仓库状态；模型计划只能调用固定的项目内只读工具，不能覆盖系统状态 |
| 自动化 Worker | Compose 独立 Worker 持久化领取规则、租约与运行结果；支持网页刷新、记忆质量、项目计划健康，以及需要人工确认的模型任务提醒，Git 仓库自动化尚未开放 |
| 动作与审批 | 项目级策略控制内置网页刷新、记忆质量检查等动作的自动执行、每次审批或禁止执行；MCP 仅开放连接委托与只读工具授权控制面，远端调用、审批、派发和结果处理仍冻结 |
| 项目运营闭环 | 工作项维护可编辑负责人、期限、独立验收标准和证据关联；开始前校验负责人/验收标准，完成前强制至少一条活动证据；终态不可改写 |
| 仓库变化与项目健康 | 从成功且完成对账的仓库同步生成确定性变化信号，由人关联或忽略；按逾期、受阻、依赖、负责人、验收、证据、建议、审批计算健康状态 |
| 记忆质量 | 确定性识别重复、冲突、过期、证据不足和低置信度记忆；可维护置信度、重要性、有效期、置顶和人工复核时间 |
| 通知中心 | 汇总自动化成功、失败、记忆质量、项目计划健康与模型外发待确认通知，支持已读状态 |
| 治理与审核 | 候选审核、历史成员资格双人签名清单、异常任务收口、模型使用与平台默认能力历史和 7/30/90 天用量核对 |

## 配置入口

平台配置仅由平台管理员在管理工作台维护；旧设置、Git 连接器、会员和账号矩阵 URL 仅作服务端角色检查后的兼容跳转，不是当前正常入口。业务配置均位于页面：

- `/admin/models`：平台供应商、模型连接和逐项能力配置；每项能力只能选择已经测试通过的可用模型（平台管理员）。
- `/admin/credits`：新注册赠送策略、额度记录和人工治理（平台管理员）。
- `/admin/operations/probes`：连接探测预算和告警阈值（平台管理员）。
- `/admin/connectors/mcp`：MCP 净化快照、候选详情与管理员不可变安全审核（平台管理员），不接收用户 Bearer Token。
- `/admin/users`：账号、会员和用户额度摘要；用户详情页处理账号停用、恢复和关联记录，停用账号仍可审计且有效结果为 `effective=false`（平台管理员）。
- `/admin/audit`、`/admin/operations/failures`：审计证据、失败和待对账状态（平台管理员）。
- `/admin/operations/backups`：备份/运维状态（按初始超级管理员规则）。
- `/team`：成员、邀请和 OIDC。
- `/projects/:projectId/control`：项目 AI 能力状态和模型使用方式（不维护独立项目路由）。
- `/projects/:projectId/repositories`：个人 Git 委托安全摘要、双确认和一次性手动只读读取。
- `/projects/:projectId/world`：当前项目状态、事实关系、替代链、冲突、快照与审计。
- `/projects/:projectId/external-sources`：网页与本地文件夹资料。
- `/projects/:projectId/automations`：自动化规则与运行记录。
- `/projects/:projectId/actions`：动作策略、审批与执行审计。
- `/projects/:projectId/tools`：项目 MCP 连接委托与只读工具授权控制面；工具发现从个人工作区进入，不提供远端调用、调用审批、派发或结果入口。
- `/projects/:projectId/plan`：目标、负责人、期限、验收标准、证据、仓库变化、健康、依赖和审计。

`.env` 只承载部署基础设施参数，例如数据库连接、端口和安全 Cookie 开关；模型 API Key、Git Token、SSH Key、MCP Bearer Token 与 OIDC Client Secret 不写入环境变量。

## 安全与可信边界

- 密码使用 scrypt 与随机盐；会话 Token 只保存 SHA-256；Cookie 为 HttpOnly、SameSite=Lax。
- 模型、Git、MCP 和 OIDC Secret 使用 AES-256-GCM、随机 nonce、认证标签与用途绑定 AAD；API 不返回明文或密文。
- 账号停用会递增访问代次、撤销活动会话并使旧个人模型、Git 与 MCP 授权链失效；恢复只允许新会话和经明确重新验证的新授权链进入。AI、Git 与 MCP 使用同一最终准入语义：停用先完成时后续调用失败关闭，最终准入记录先提交时该次已授权外发仍可收口，不承诺追溯撤回已经获准发送的数据。
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
- MCP 工具定义采用追加式快照。个人连接负责工具发现；远端 annotations 只保存为不可信提示，不能直接产生授权资格；管理员对精确工具定义执行净化审核并可追加撤销审计，审核绑定工具、网络和凭据指纹。项目 Owner 逐项管理连接委托与只读工具授权；远端动作调用、调用审批、派发、结果查看/导入和任何公开外发入口仍固定关闭，不能通过内部 API 绕过。传输歧义进入 `unknown` 且不重试。
- MCP 隔离门禁或内部服务中的结果证据不构成当前产品能力；公开 API 与项目页面不提供远端调用、调用审批、派发、结果查看或导入，也不会自动创建项目来源、事实、索引或模型上下文。
- 智能体建议纳入计划时固定建议索引、引用快照、运行输入清单指纹和证据指纹。建议只进入 `proposed`，状态推进与依赖调整必须由用户完成并留下追加式审计。
- 工作项开始或完成前必须有当前可编辑负责人和验收标准；完成前还必须关联活动证据。证据以内容快照和 SHA-256 指纹固化，移除只做软移除，完成/取消后的工作项不可改写。
- 仓库变化信号只来自成功且完成对账的同步记录，并明确不推断业务影响。关联或忽略必须由 Editor/Owner 人工决定，原始信号与计划审计保持可追溯。
- 事实关系只允许连接同项目、当前已确认事实，并固定双方精确修订和证据清单。事实变化后旧关系标记为陈旧，不会静默迁移到新版本。
- 事实替代只允许同类型、已确认事实建立单一无环链；旧事实保留确认时间、来源证据和修订历史。状态快照与世界模型审计只追加、不覆盖。
- Dashboard、项目简报和只读智能体复用同一确定性项目状态与输入指纹。模型不能确认事实、建立关系、替代事实或修改状态。
- 项目计划健康与提醒只读取本地数据库，不调用模型、不向外发送项目内容；通知发送前重新核对接收者当前项目访问权。

## 当前限制

- 当前发布目标为 `0.6.0-dev.5`，只允许从生产实际运行的 `0.5.0-dev.1` 或 `0.5.0-dev.4` 进入受控迁移通道；这些版本都不是稳定版或 GitHub Latest。平台管理员只负责平台运营和安全治理，不进入项目、团队或用户工作区；普通用户负责自己的项目和个人连接。个人 MCP 工具发现、管理员净化审核与项目委托/只读授权控制面已开放；旧管理员 Git、旧会员和账号矩阵入口只保留受守卫的兼容跳转。
- 数据库 trigger 只约束正常应用写入的一致性，不是抵抗已取得应用数据库凭据或任意 SQL 能力的独立授权边界；生产需隔离 runtime 与 migrator 角色并限制网络访问。账号访问代次迁移不支持旧、新应用滚动并存，部署必须在维护窗口停止旧 app/worker、执行迁移，再启动新版本。
- OIDC 不提供“按邮箱自动合并已有本地账户”。已有账户需要未来的显式身份绑定流程；当前遇到相同邮箱会拒绝登录，避免账户劫持。
- Git 通用连接器和 GitHub 扩展资料的既有外发入口在迁移期间冻结；Issue、PR、Release 等扩展资料的个人连接能力属于 planned 范围。
- 网页来源只抓取服务端可读取的静态文本，不执行 JavaScript，也不提供页面登录或自定义请求头。
- Office 内嵌图片、音频和视频不会识别；单文件最大 25 MiB，其他细分限制见操作手册。
- 平台托管模型消耗平台额度；个人模型连接才消耗用户自己的供应商额度并可能产生供应商费用；系统不维护实时价格，因此不估算账单。
- 自动化可以刷新网页和运行确定性质量检查；Git 仓库自动化尚未开放。涉及向模型发送内容的索引与简报任务只创建待确认通知，不会绕过当次授权。
- 动作中心不是通用 Agent 工具平台。三个内置能力仍使用固定输入；MCP 个人连接、工具发现、管理员审核、项目委托和只读工具授权控制面已开放，但远端调用、调用审批、派发与结果控制仍冻结，公开 API 与产品页面均不能接受模型生成或批准的工具调用。
- MCP 不支持 stdio、本地子进程、独立旧式 SSE、执行中继续索取输入、自动执行或任何写操作；同一 POST 的 request-scoped JSON/SSE 响应仍需严格匹配持久请求 ID。伪造或篡改服务端 annotations 不能绕过管理员认证；接入方仍需使用可信服务和最小权限只读凭据。
- 隔离门禁中的 MCP 成功结果仅是受限、净化的内部证据，不构成产品现场能力；公开 API 与当前页面不提供远端结果查看或纳入。结果不会自动成为项目资料或事实、建立索引、进入模型上下文，也不会自动展开图片、音频和资源链接。
- 项目计划不会自动生成执行动作。智能体建议、仓库变化信号和健康提醒都必须由人核对；系统不会因此修改代码、调用工具、创建分支/PR、合并或部署。
- 项目世界模型不会自动推断或创建事实关系，也不会自动解决冲突。当前状态是确定性汇总，不代表业务真伪已经由系统证明；关系、替代和冲突处置仍需人工判断。
- 智能体没有 Shell、任意文件系统、代码修改、Git 写入、部署或 MCP 工具调用权限；隔离门禁可能直接调用 MCP 后端仅用于内部验证，公开 API 与产品页面都没有远端调用入口。
- 受限 JSON 导出不是数据库备份，不包含凭据、向量、上传二进制和完整运行账本。

## 本地 Docker 部署

要求：Docker Desktop。

```bash
cp .env.example .env
# 编辑 .env，至少设置 cluster-admin、migrator、runtime、writer 和
# inventory-reader 密码；不要提交 .env
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

打开 <http://127.0.0.1:3000>。正常状态应为：

- `postgres`：healthy
- `principal-bootstrap`：Exited (0)
- `migrate`：Exited (0)
- `reconcile`：Exited (0)
- `app`：healthy
- `worker`：healthy

`/api/health` 会分别报告数据库与 Worker 心跳；Worker 日志为单行 JSON，可按[运行监控基线](docs/monitoring.md)采集和告警。

Compose 默认使用三个命名卷：`ai-project-os-pgdata`、`ai-project-os-secrets`、`ai-project-os-uploads`。不要执行 `docker compose down -v`，该命令会删除数据库、凭据主密钥和上传文件。需要并行运行一次性候选验收时，必须同时改用独立 `POSTGRES_PORT`、`APP_PORT`、`AI_PROJECT_OS_PGDATA_VOLUME`、`AI_PROJECT_OS_SECRETS_VOLUME` 和 `AI_PROJECT_OS_UPLOADS_VOLUME`；不要让候选栈复用正式卷。

面向局域网外提供服务前，应按[部署安全基线](docs/deployment-security.md)配置 HTTPS、入口限流和可信反向代理，并设置 `AI_PROJECT_OS_SECURE_COOKIES=true` 与实际 HTTPS `AI_PROJECT_OS_PUBLIC_ORIGIN`。仓库提供的 Nginx 示例必须替换域名与证书路径并通过 `nginx -t` 后才能启用。`v0.6.0-dev.5` 必须经 0.6 专用迁移通道验证后才可进入生产；历史 `v0.5.0-dev.1` clean reset 和 `v0.5.0-dev.4` preserve 通道只保留用于审计与源版本识别。cluster-admin、migrator、runtime、writer 和 inventory-reader 密码若包含 URL 保留字符，需要先进行 URL 编码。

### 现有卷的数据库账号升级

ENT-009 的 Compose 顺序是 `principal-bootstrap → migrate → reconcile → app/worker`。`ai_project_os_cluster_admin` 是 initdb/维护窗口专用的超级用户，`ai_project_os_migrator` 是实际迁移 owner；runtime、writer 和 inventory-reader 只获得各自最小权限。迁移不会在线滚动执行，必须先停止旧 app/worker 并在维护窗口完成。

如果现有卷仍由旧 owner 持有，请先备份并停止旧 app/worker。在未提交的 `.env` 中保留 `POSTGRES_USER=ai_project_os_cluster_admin`、设置新的 `POSTGRES_CLUSTER_ADMIN_PASSWORD`/`POSTGRES_MIGRATOR_PASSWORD`，并临时设置 `DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL` 为旧 owner 的 owner-only PostgreSQL URL。启动并确认 `principal-bootstrap`、`migrate`、`reconcile` 均为 `Exited (0)` 后，bootstrap 会先创建独立 cluster-admin，再把旧 owner 的当前数据库对象迁移到 migrator。普通旧 owner 会在事务内封存为 `NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`；官方 initdb 的 OID10 旧超级用户不能安全降级为 `NOSUPERUSER`，会保留 `SUPERUSER` 但设置 `NOLOGIN`、清除密码/成员关系并终止其会话。确认升级成功后从 `.env` 删除并轮换一次性 legacy URL（即使暂时保留，后续 admin-ready 重启也不会再次连接它）；不要把它放入 app/worker/migrate 环境、日志或仓库。只有在检查完外部依赖、成员关系和审计要求后，才可在单独维护窗口受控地 `DROP ROLE`；bootstrap 不会自动删除封存角色。若 bootstrap 缺失或凭据错误，流程会在迁移前 fail closed 并保留数据现场。

需要运行 entitlement 历史盘点时，使用独立 reader URL 通过 `127.0.0.1` 或 SSH tunnel 执行 `pnpm db:account-entitlement-inventory`；该 reader 只能执行聚合函数，不能读取基础表，输出也不含用户标识或额度明细。详见[管理员操作指南](docs/admin-operation-guide.md)。

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
- `/admin`：平台管理员管理工作台总览，不展示项目、团队或个人连接。
- `/admin/models`：平台管理员配置平台模型连接，并为每项能力选择已验证模型。
- `/admin/credits`：平台管理员管理赠送策略和额度记录。
- `/admin/operations/probes`：平台管理员配置连接探测预算。
- `/admin/connectors/mcp`：平台管理员执行 MCP 候选与不可变安全审核，不接收个人凭据。
- `/admin/users`：平台管理员管理用户、会员、账号状态和额度摘要。
- `/admin/operations/backups`：平台管理员查看受限备份/运维状态。
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
- `/projects/:projectId/tools`：MCP 连接委托与只读工具授权控制面；工具发现从个人中心进入，当前不提供远端调用、调用审批、派发或结果入口。
- `/projects/:projectId/plan`：目标、负责人、期限、验收标准、证据、仓库变化、工作项、依赖、健康与计划审计。
- `/projects/:projectId/control`：AI 能力状态和模型使用方式（不维护独立项目路由）。
- `/projects/:projectId/memory`：抽取、索引、搜索和 RAG。
- `/projects/:projectId/memory-quality`：记忆质量与生命周期。
- `/projects/:projectId/intelligence`：简报和只读智能体。
- `/projects/:projectId/governance`：审核、异常与用量。

## 历史材料

V1 CLI 手册和历史运行合同继续保留用于兼容与审计，但不覆盖当前 `0.6.0-dev.5` 受控升级预发布的页面能力。当前能力、限制和使用方式以本 README、页面指南和操作手册为准；`0.6.0-dev.5` 仍是预发布，不是稳定版或 GitHub Latest，`v0.5.0-dev.1` 与 `v0.5.0-dev.4` 作为允许的历史源版本保留。
