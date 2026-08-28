# AI Project OS 项目约定

## 作用域

这是一个独立的 Next.js 单体应用，V2.1 的代码、迁移、文档和测试均在本目录内。不要扩展到其他项目目录，不要引入独立 API 服务、worker、MCP server 或 monorepo 结构。

当前产品已开放页面化本地管理员、加密凭据、OpenAI/DeepSeek/Qwen/GLM 连接、项目级模型路由、GitHub 多仓库只读扫描、自动抽取、统一向量索引、语义检索、引用式 RAG、项目状态简报和受约束的只读项目智能体。产品说明必须继续区分真实可执行能力与仍未实现的能力；未通过实现与运行验收的内容不得在 README、产品文案或 UI 中宣称可用。

## 常用命令

```bash
pnpm install
docker compose up -d
pnpm db:migrate --name init
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm db:validate
pnpm db:generate
```

## 边界与安全

- 网页可以接收 GitHub 与模型凭据，但只能在认证后的同源写接口中使用 AES-256-GCM 加密保存；主密钥必须位于数据库之外，API、日志和页面不得返回明文或密文。
- 模型网络请求只能使用内置供应商注册表中的固定官方地址；任何新增供应商必须先定义协议、能力、主机白名单、响应验证和安全错误码，不能只替换 Base URL。
- 每次项目内容外发都必须绑定明确项目、operation、provider、model、输入清单指纹、有效期和用户当次确认；Provider 调用必须留下安全审计记录。
- 自动抽取必须输出可核对的结构化证据并保留 `sourceId`/`sourceExcerpt`；AI 候选不能绕过专用审核状态机成为已确认事实。
- GitHub 连接器只读且必须限制明确仓库、范围和 frozen commit；代码/资料生成和统一向量索引都必须原子发布，失败时保留上一代活动指针。
- 语义检索不得跨项目；引用式 RAG 只能使用本次检索集合中的不可变记录 ID，任何越界引用都必须拒绝保存。
- 项目智能体只允许固定的只读工具集合；模型计划必须由服务端严格解析，工具执行结果必须限定项目范围，最终引用只能来自本次工具取得的证据。向量路由供应商、模型或维度变化后不得复用旧索引。
- 继续禁止自动改代码、GitHub 写操作、任意 Shell、任意文件系统写入、MCP 写操作、独立服务/worker/monorepo，以及任何未通过对应能力验收的运行时、API 或产品能力声明。
- 事实必须能追溯到 `ProjectSource`；不要移除 `sourceId` 或 `sourceExcerpt`。
- `.env` 仅用于本地开发且已被 Git 忽略；不要把数据库 URL、密码或其他密钥写入源码、日志或提交。
- 不要使用破坏性 Git 操作，不要回退其他协作者的修改。
- 生产代码遇到错误配置时应显式失败；API 对外只返回稳定的错误 code/message，不泄漏内部异常。

## 验收

每次有行为变化都要运行相关的聚焦检查。V2.1 发布前必须运行 README 中列出的项目级命令、真实 PostgreSQL AI 闭环、项目智能体 PostgreSQL 闭环、迁移状态、Docker Compose 健康/API smoke 和认证后页面 smoke；不要将只通过静态检查称作完成。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
