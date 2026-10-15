# AI Project OS 项目约定

## 作用域

这是一个独立的 Next.js 单体应用，应用、自动化 Worker、Prisma 迁移、文档和测试均在本目录内。不要扩展到其他项目目录，不要引入独立 API 仓库、MCP server 或 monorepo 结构。

当前产品已开放页面化多用户/RBAC、邀请与 OIDC、加密凭据、OpenAI/DeepSeek/Qwen/GLM、项目 AI 路由、文件与视觉识别、多 Git 代码仓库、网页来源、本地文件夹、自动抽取、统一向量索引、语义检索、引用式 RAG、持久化自动化、受控动作与审批、远程只读 MCP 工具授权与逐次审批、成功 MCP 结果人工纳入、证据驱动项目计划、记忆质量、项目简报和受约束的只读项目智能体。产品说明必须区分真实能力与未实现能力；未通过实现与运行验收的内容不得在 README、产品文案或 UI 中宣称可用。

## 常用命令

```bash
pnpm install
docker compose up -d --build
pnpm db:generate
pnpm exec prisma migrate deploy --config prisma.config.ts
pnpm dev
pnpm worker
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm db:validate
```

## 边界与安全

- 模型、Git 与 OIDC 凭据只能在认证后的同源写接口中接收，并使用 AES-256-GCM 加密保存；主密钥必须位于数据库之外，API、日志和页面不得返回明文或密文。
- 模型网络请求只能使用内置供应商注册表中的固定官方地址。新增供应商必须先定义协议、能力、主机白名单、响应验证和安全错误码，不能只替换 Base URL。
- 每次项目内容外发必须绑定项目、operation、provider、model、输入清单指纹、有效期和用户当次确认；自动化不得绕过该确认。Provider 调用必须留下安全审计记录。
- 自动抽取必须输出可核对的结构化证据并保留 `sourceId`/`sourceExcerpt`；AI 候选不能绕过审核状态机成为已确认事实。
- 通用 Git 连接器只读。公网默认 HTTPS；内网必须显式授权；HTTPS/SSH 执行必须固定已经验证的解析地址，SSH 还要以原主机名检查 known_hosts。仓库扫描必须限制明确仓库、分支、目录与 frozen commit，并原子发布。
- 网页和 OIDC 服务端请求必须阻止云元数据地址、默认阻止私网、固定解析地址并限制响应体；重定向必须逐跳复核。
- OIDC 使用 Authorization Code + PKCE，并校验 issuer、audience、nonce、过期时间和受限签名算法。不得仅凭相同邮箱自动绑定已有账户；身份绑定必须是未来独立、显式、可审计流程。
- 工作区与项目权限必须由服务端统一执行，不能只依赖页面隐藏。不得降级最后一位启用 Owner；邀请与 OIDC 自动加入不得降低已有角色。
- 语义检索不得跨项目；RAG 只能引用本次检索集合中的不可变记录 ID。向量供应商、模型或维度变化后不得复用旧索引。
- 项目智能体只允许固定只读工具。模型计划必须严格解析，工具结果必须限定项目范围，最终引用只能来自本次工具取得的证据。
- Worker 使用持久化租约、心跳和幂等运行记录；归档项目不得被领取，归档时暂停活动规则，恢复后不自动重启。连续失败达到策略阈值后自动暂停。
- Action Engine 只能调用显式白名单中的内置能力，或经管理员验证、项目 Owner 逐项授权且每次单独审批的远程只读 MCP 工具。动作必须绑定项目、规范化输入、输入指纹、能力风险和策略快照；MCP 动作还必须绑定授权、工具定义、网络与凭据指纹。审批记录、策略修订、工具定义快照和审计记录不可变。项目 Owner 才能修改策略、授权工具或审批，租约过期和任何快照漂移必须失败关闭且不得自动重试外部读取。
- MCP 仅支持当前 Streamable HTTP 远程传输；禁止 stdio、本地子进程、旧式 HTTP+SSE、执行中交互输入、自动执行和任何写操作。远端 annotations 必须视为未受信提示；接入方仍需使用可信服务和最小权限只读凭据。工具结果不得自动进入记忆、RAG 或模型上下文；只有成功动作结果可由 Editor 或 Owner 手工纳入为未审核资料，并且必须绑定不可变的动作、输入、结果与内容指纹。
- 项目计划只管理目标、工作项、优先级、状态、依赖和追加式审计。智能体建议只能以带引用快照、输入清单指纹和证据指纹的 `proposed` 工作项纳入；接受、状态推进和依赖调整均由 Editor 或 Owner 明确操作。计划不得自动创建动作、调用模型或工具、修改代码、写入 Git、运行 Shell 或部署。
- 继续禁止自动改代码、Git 写操作、任意 Shell、任意文件系统写入、MCP 写操作、部署执行，以及任何未通过验收的运行时、API 或产品能力声明。
- 事实必须能追溯到 `ProjectSource`；不要移除 `sourceId` 或 `sourceExcerpt`。人工正文去重不能误伤不同来源但正文相同的文件、网页或仓库内容。
- `.env` 仅用于部署基础设施和本地开发且已被 Git 忽略；不要把数据库 URL、密码或其他密钥写入源码、日志或提交。
- 不要使用破坏性 Git 操作，不要回退其他协作者的修改。
- 生产代码遇到错误配置时应显式失败；API 对外只返回稳定的错误 code/message，不泄漏内部异常。

## 验收

每次行为变化先做与风险相称的聚焦检查，复用内容、输入和环境未变的成功证据。CI 按实际生产源版本到候选提交的累计差异分层；无法核实来源或分类时按高风险处理，不以最后一笔提交掩盖未发布的高风险变更。

- 低风险：文档、CSS、位图及经过内容比对的纯版本元数据变化。运行 Prisma Client 生成、Lint、类型检查、生产构建和性能预算。
- 中风险：不涉及认证、授权、额度、外发或数据边界的客户端交互、组件和 SVG。增加默认测试与覆盖率、隔离 PostgreSQL 的认证后浏览器与可访问性验证；不重复全部数据库业务门禁和 Compose 候选构建。
- 高风险：认证/授权、额度、服务端/API、模型外发、Schema/迁移、生产工具、CI/CD、构建、依赖及无法分类的改动。执行完整默认测试、Prisma 生成与校验、全部 PostgreSQL 业务门禁、账号认证与 PostgreSQL 18 OID10 门禁、生产浏览器与性能门禁、隔离 Compose 候选。完成后进行一次独立审查。

正式发布由用户在 Workflow 点击发起，复用精确同 SHA、覆盖实际累计风险与源版本的成功主分支 CI；版本标签只核对 annotated 类型、精确 SHA 和主分支 CI 身份，不再次运行整套测试。生产发布仍独立核对来源、版本与镜像、停写备份、数据库账本和上线健康。高风险发布保留隔离恢复/迁移演练；低/中风险且迁移清单完全相同的应用发布跳过恢复演练、迁移和权限协调，并在回执中明确记录。源码 CI、生产切换和真实外部服务是不同证据，但不是三次重复完整验收。真实模型、Git、OIDC 或第三方 MCP 服务未配置或未执行时，应明确其现场验证边界；MCP 协议联调使用隔离的只读测试服务。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
