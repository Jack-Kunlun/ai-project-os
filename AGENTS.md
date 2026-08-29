# AI Project OS 项目约定

## 作用域

这是一个独立的 Next.js 单体应用，应用、自动化 Worker、Prisma 迁移、文档和测试均在本目录内。不要扩展到其他项目目录，不要引入独立 API 仓库、MCP server 或 monorepo 结构。

当前产品已开放页面化多用户/RBAC、邀请与 OIDC、加密凭据、OpenAI/DeepSeek/Qwen/GLM、项目 AI 路由、文件与视觉识别、多 Git 代码仓库、网页来源、本地文件夹、自动抽取、统一向量索引、语义检索、引用式 RAG、持久化自动化、记忆质量、项目简报和受约束的只读项目智能体。产品说明必须区分真实能力与未实现能力；未通过实现与运行验收的内容不得在 README、产品文案或 UI 中宣称可用。

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
- 继续禁止自动改代码、Git 写操作、任意 Shell、任意文件系统写入、MCP 写操作、部署执行，以及任何未通过验收的运行时、API 或产品能力声明。
- 事实必须能追溯到 `ProjectSource`；不要移除 `sourceId` 或 `sourceExcerpt`。人工正文去重不能误伤不同来源但正文相同的文件、网页或仓库内容。
- `.env` 仅用于部署基础设施和本地开发且已被 Git 忽略；不要把数据库 URL、密码或其他密钥写入源码、日志或提交。
- 不要使用破坏性 Git 操作，不要回退其他协作者的修改。
- 生产代码遇到错误配置时应显式失败；API 对外只返回稳定的错误 code/message，不泄漏内部异常。

## 验收

每次行为变化运行与风险相称的聚焦检查。V3.0.0 发布验收必须包含：Prisma 生成与校验、完整迁移链、类型检查、Lint、测试、生产构建、真实 PostgreSQL V3 闭环、Docker Compose `postgres/migrate/app/worker` 状态、认证后页面 smoke，以及按钮文字居中和共享 Header 一致性。真实外部模型、Git 或 OIDC 服务未配置时，必须明确说明对应连接未做现场验证，不得用静态检查替代。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
