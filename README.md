# AI Project OS

AI Project OS V2.0 是一套可在本机部署的项目长期记忆工作台。它把人工资料和多个 GitHub 仓库整理成可追溯记忆，并提供页面化的模型配置、自动抽取、向量索引、语义检索和带引用 RAG。

所有模型与 GitHub 凭据都在网页录入，由服务端使用 AES-256-GCM 加密后保存；主密钥位于数据库之外。每次向模型供应商发送项目内容前，用户仍需在页面明确确认本次传输范围。模型抽取结果只会进入候选队列，必须人工确认后才成为已确认项目事实。

## 当前能力

| 能力 | V2.0 行为 |
| --- | --- |
| 本地管理员 | 首次启动创建唯一管理员；数据库会话、HttpOnly Cookie、同源写请求校验和退出登录 |
| 模型供应商 | 页面配置和测试 OpenAI、DeepSeek、Qwen、GLM；API Key 加密保存且永不回显 |
| 能力路由 | 每个项目分别选择自动抽取、向量索引和引用式生成所使用的供应商与模型 |
| 项目资料 | 保存人工原文、来源、时间和 SHA-256；条目必须引用同项目资料中的精确摘录 |
| GitHub 多仓库 | 页面连接多个仓库；只读 fine-grained PAT；按分支与目录冻结 commit、扫描代码并同步 README、Markdown、Issue、PR、Release |
| 自动抽取 | 从明确选择的资料抽取 decision、progress、issue、risk；结构和精确原文摘录验证失败时整次拒绝 |
| 人工审核 | 接受或驳回 AI 候选；所有动作保留模型、作业、证据和修订记录 |
| 统一向量记忆 | 对人工资料、当前仓库资料生成和当前项目代码快照确定性分块；分批生成向量并原子切换活动索引 |
| 语义搜索 | 查询向量与关键词混合排序，返回原文片段、路径、冻结 commit 和分数 |
| 引用式 RAG | 只把本次命中的证据片段交给生成模型；响应中的引用 ID 必须属于检索集合，否则拒绝保存 |
| 作业与审计 | GitHub 与 AI 操作持久化为任务；记录授权范围、输入清单指纹、供应商调用、Token 用量、安全错误码和最终状态 |
| 人工快照 | 继续支持手工条目审核和不可变 Project Snapshot，作为人工确认状态的独立读取点 |

DeepSeek 在 V2.0 中用于生成；它不提供向量路由。语义索引可选择 OpenAI、Qwen 或 GLM。供应商模型 ID 可在页面填写，但网络目标固定为内置官方 API 地址，不开放任意 Base URL，避免凭据被发送到未知主机。

## 从页面开始使用

1. 首次打开应用，创建本地管理员账号。
2. 在“模型与系统设置”添加供应商，填写 API Key、生成模型和可选向量模型，然后执行连接测试。
3. 创建或进入项目，在“智能控制台”为自动抽取、语义向量和引用式问答选择已验证的供应商。
4. 在同一控制台连接一个或多个 GitHub 仓库；也可以继续手工录入项目资料。
5. 运行代码扫描和仓库资料同步。扫描结果冻结到明确 commit，并按仓库级原子发布。
6. 进入“智能记忆”，明确确认本次外部模型传输后执行自动抽取或建立统一语义索引。
7. 人工审核候选；之后可以做语义检索，或生成带精确引用的项目回答。

## 安全与数据边界

- 管理员密码使用 scrypt 与随机盐保存；会话 Token 只保存 SHA-256，浏览器 Cookie 为 HttpOnly、SameSite=Lax。
- API Key 和 GitHub PAT 使用 AES-256-GCM、随机 nonce、认证标签和绑定用途的 AAD 加密。网页/API 只返回尾号，不返回密文或明文。
- 主密钥不进入 PostgreSQL。Compose 使用独立命名卷 `ai-project-os-secrets` 持久化 `/var/lib/ai-project-os-secrets/master.key`。
- GitHub 客户端只允许固定 `api.github.com` GET 端点，拒绝重定向、超大响应、身份不一致和不受控分页。
- 模型网络目标来自内置供应商注册表，不接受页面提供的任意 URL。
- 自动抽取把 Source 视为不可信文本；模型必须返回严格 JSON 和 Source 中存在的连续原文。
- 新索引构建失败时，活动指针仍指向上一代完整索引；只有全部向量持久化成功后才在事务中切换。
- RAG 上下文被视为不可信内容；模型只能引用本次检索返回的 MemoryRecord UUID。
- 项目删除会级联清理本项目的任务、授权、候选、索引和回答；供应商凭据与全局连接独立保存。

## 当前限制

- 这是本地单管理员版本，没有多用户、RBAC、SSO 或远程团队协作。
- 页面任务在 Next.js 单体进程中执行并持久化状态，没有独立 worker；执行期间应保持本地服务运行。
- 单次统一索引最多 5,000 个分块、24 MiB 分块文本；自动抽取最多 10 条资料、总计 200,000 字符。超限会明确拒绝，不会静默截断。
- 模型调用会使用用户自己的供应商额度并可能产生费用；项目不自动代替用户发送真实私有资料做验收。
- 不支持自定义 OpenAI-compatible Base URL、Ollama、Azure OpenAI、文件上传、OCR、飞书、MCP、自动改代码或任何 GitHub 写操作。
- 已有 V1 CLI 和历史运行合同继续保留用于兼容与审计，但 V2.0 的常规配置和操作入口是网页。

## 本地 Docker 部署

要求：Docker Desktop。复制环境示例并只填写数据库密码：

```bash
cp .env.example .env
# 编辑 .env，设置 POSTGRES_PASSWORD；不要把 .env 提交到 Git
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

打开 <http://127.0.0.1:3000> 完成首次管理员初始化。模型与 GitHub 凭据全部在页面配置，不需要写入 `.env`。

Compose 会等待 PostgreSQL 健康，执行一次 `prisma migrate deploy`，再启动应用。数据库只绑定 `127.0.0.1:5433`，数据卷为 `ai-project-os-pgdata`，主密钥卷为 `ai-project-os-secrets`。更新代码后重新执行 `docker compose up -d --build` 即可。不要执行 `docker compose down -v`，它会删除数据库和主密钥卷。

当前 Compose 会用 `POSTGRES_*` 拼接容器内连接串，因此 `POSTGRES_PASSWORD` 应使用 URL-safe 字符；若包含 `@`、`:`、`/`、`?`、`#` 或 `%`，必须先做 URL 编码。

如果前面有 HTTPS 反向代理，可在容器环境中设置 `AI_PROJECT_OS_SECURE_COOKIES=true`；本机 HTTP 默认不设置 Secure Cookie。

## 本地开发

要求：Node.js 24+、pnpm 10+、PostgreSQL 18 + pgvector。

```bash
pnpm install
cp .env.example .env
# DATABASE_URL 指向本机 PostgreSQL，例如 127.0.0.1:5433
pnpm db:generate
pnpm exec prisma migrate deploy --config prisma.config.ts
pnpm dev
```

应用运行于 <http://localhost:3000>。本地直接运行时，凭据主密钥默认自动创建在 `~/.ai-project-os/master.key`，权限必须为 `0600`。

## 验证

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm db:validate
git diff --check

# 真实 PostgreSQL V2 AI 闭环；创建的隔离数据会自动清理
WEB_AI_POSTGRES_GATE=1 pnpm exec tsx --test test/web-ai-workflow-postgres.test.ts
```

`pnpm build` 使用 Next.js 官方 Webpack 构建后端，以避免部分受限 macOS 环境中 Turbopack 的本地端口限制。

## V2.0 页面与 API

- `/setup`、`/login`：首次管理员初始化与登录。
- `/settings`：模型供应商、API Key、模型和连接测试。
- `/projects/:projectId/control`：项目模型路由、GitHub 多仓库连接、扫描、同步和任务状态。
- `/projects/:projectId/memory`：自动抽取、候选审核、统一向量索引、语义检索和引用式问答。
- `/api/settings/providers/*`：受认证保护的供应商配置、密钥轮换与连接测试。
- `/api/projects/:projectId/ai-routes`：项目级能力路由。
- `/api/projects/:projectId/repositories/*`：多仓库连接、代码扫描和资料同步。
- `/api/projects/:projectId/memory/*`：索引、抽取、候选审核、搜索与 RAG。
- `/api/projects/:projectId/jobs`：最近持久化任务状态。

除健康检查、首次初始化和登录外，项目与设置 API 都要求有效管理员会话；所有写请求还要求同源 `Origin`/`Host`。

## 历史材料

V1 CLI 手册和历史合同保留在 `docs/`，仅用于兼容、审计和理解旧数据结构。它们不覆盖本 README 描述的当前 V2.0 页面能力。
