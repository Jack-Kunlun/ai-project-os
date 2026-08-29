# AI Project OS

AI Project OS V3.0.0 是一套可本地部署的项目长期记忆与只读项目智能工作台。它把人工资料、文件、网页和多个 Git 服务中的代码仓库整理为有来源、有版本、有审核状态的项目记忆，并提供语义检索、引用式 RAG、项目状态简报、受约束的只读智能体、持久化自动化、记忆质量治理和团队权限。

模型、Git 与 OIDC 凭据全部从页面配置，由服务端使用 AES-256-GCM 加密保存；主密钥位于数据库之外。涉及向第三方模型发送项目内容的操作仍要求用户在页面核对供应商、模型和输入范围。AI 抽取结果只进入候选队列，人工确认后才成为项目事实。

## 从哪里开始

- 页面指南：启动后打开 <http://127.0.0.1:3000/guide>。
- 完整手册：[docs/operation-manual.md](docs/operation-manual.md)。
- 历史 CLI 手册：[docs/v1-operations.md](docs/v1-operations.md)，仅用于兼容旧流程。

推荐首次使用顺序：

1. 启动 Docker Compose，初始化本地管理员。
2. 在“模型设置”添加并测试 OpenAI、DeepSeek、Qwen 或 GLM。
3. 在“连接器”配置需要使用的 Git 服务。
4. 创建项目，在项目“智能控制台”分配视觉、抽取、向量与生成模型。
5. 上传文件，或添加网页、本地文件夹和一个或多个代码仓库。
6. 审核 AI 候选并建立语义索引。
7. 使用语义搜索、引用式问答和只读项目智能体。
8. 在“自动化”“记忆质量”和“通知”中维护长期运行状态。
9. 需要协作时，在“团队”中创建成员、邀请链接或 OIDC 身份源。

## 当前能力

| 能力 | V3.0.0 行为 |
| --- | --- |
| Dashboard | 汇总跨项目指标、配置就绪度、推荐下一步、待处理状态和最近任务；项目管理保持为独立顶部入口 |
| 项目与个人中心 | 项目搜索、创建、软归档、恢复和受限 JSON 导出；个人资料、登录名、密码和活动会话管理 |
| 多用户与 RBAC | 工作区角色 Owner/Admin/Member/Viewer，项目角色 Owner/Editor/Viewer；服务端对页面和 API 统一鉴权 |
| 邀请与 OIDC | 邮箱限定邀请；OpenID Connect Authorization Code + PKCE；支持 `client_secret_post` / `client_secret_basic`、受控自动建号和企业内网显式授权 |
| 模型供应商 | 页面配置 OpenAI、DeepSeek、Qwen、GLM 的 API Key、生成/视觉/向量模型并测试连接；密钥不回显 |
| 项目 AI 路由 | 每个项目独立选择图片识别、自动抽取、向量索引和引用式生成模型；路由变更保留审计与影响提示 |
| 文件与图片识别 | TXT、Markdown、JSON、CSV、PDF、DOCX、PPTX、XLSX、PNG、JPEG、WebP；本地解析文本，图片和扫描 PDF 经当次授权后调用视觉模型并逐片段审核 |
| 外部资料 | 抓取公开网页或经明确授权的内网页面；浏览器选择本地文件夹后按文件批量导入；来源版本原子发布 |
| 多 Git 连接 | GitHub、Gitee、GitLab、自建 GitLab、Gitea、Forgejo 和通用 Git；HTTPS Token/Basic 或 SSH Key；支持自定义 CA、known_hosts 与显式内网授权 |
| 多仓库记忆 | 一个项目可关联多个 Git 服务上的多个仓库；按分支与目录冻结 commit，完整校验后原子发布代码快照 |
| GitHub 扩展资料 | 既有 GitHub 专用连接继续支持 README、Markdown、Issue、PR 和 Release 的只读同步 |
| 自动抽取与审核 | 从明确选择的资料抽取 decision、progress、issue、risk；结构与连续原文验证通过后进入人工审核 |
| 统一向量记忆 | 对人工/文件/网页/仓库资料和代码快照确定性分块；支持增量构建与全量重建，完成后原子切换索引 |
| 语义搜索与 RAG | 向量和关键词混合排序；回答只能引用本次检索命中的不可变证据记录 |
| 项目简报与只读智能体 | 聚合项目概览、已确认条目、语义记忆和仓库状态；模型计划只能调用固定的项目内只读工具 |
| 自动化 Worker | Compose 独立 Worker 持久化领取规则、租约与运行结果；支持仓库同步、网页刷新、记忆质量检查，以及需要人工确认的模型任务提醒 |
| 记忆质量 | 确定性识别重复、冲突、过期、证据不足和低置信度记忆；可维护置信度、重要性、有效期、置顶和人工复核时间 |
| 通知中心 | 汇总自动化成功、失败、记忆质量与模型外发待确认通知，支持已读状态 |
| 治理与审核 | 候选审核、异常任务收口、模型路由历史和 7/30/90 天用量核对 |

## 配置入口

业务配置均位于页面：

- `/settings`：模型供应商与 API Key。
- `/connections`：Git 服务与凭据。
- `/team`：成员、邀请和 OIDC。
- `/projects/:projectId/control`：项目级 AI 路由。
- `/projects/:projectId/repositories`：项目多仓库关联与扫描。
- `/projects/:projectId/external-sources`：网页与本地文件夹资料。
- `/projects/:projectId/automations`：自动化规则与运行记录。

`.env` 只承载部署基础设施参数，例如数据库连接、端口和安全 Cookie 开关；模型 API Key、Git Token、SSH Key 与 OIDC Client Secret 不写入环境变量。

## 安全与可信边界

- 密码使用 scrypt 与随机盐；会话 Token 只保存 SHA-256；Cookie 为 HttpOnly、SameSite=Lax。
- 模型、Git 和 OIDC Secret 使用 AES-256-GCM、随机 nonce、认证标签与用途绑定 AAD；API 不返回明文或密文。
- Git HTTPS 执行固定验证过的 DNS 地址并拒绝重定向；SSH 固定解析地址，同时以原主机名校验 known_hosts。云元数据地址始终阻止，私网必须显式授权。
- 网页与 OIDC 服务端请求固定 DNS 解析、限制响应大小并阻止云元数据地址；公网默认要求 HTTPS。
- OIDC 校验 issuer、audience、nonce、过期时间和允许的 JWKS 签名算法；未知身份不会仅凭相同邮箱自动绑定到已有账户。
- 仓库扫描先固定远端 commit，再在隔离临时目录读取受控范围；Git 交互、系统/全局配置、钩子和非目标协议均关闭。
- 上传文件核对扩展名与真实格式，限制压缩包条目、解压体积、图片像素和 PDF 页数。
- 模型输出和网页内容一律视为不可信数据；抽取证据、RAG 引用与智能体工具结果均由服务端验证项目边界。
- 索引、仓库快照和网页修订失败时不会替换上一代完整活动版本。
- 项目归档会暂停活动自动化；运行中任务会阻止归档，恢复项目不会自动恢复原自动化规则。

## 当前限制

- V3.0.0 当前提供一个由旧数据迁移得到的默认工作区；数据模型支持多个工作区，但页面尚未提供工作区创建和切换。
- OIDC 不提供“按邮箱自动合并已有本地账户”。已有账户需要未来的显式身份绑定流程；当前遇到相同邮箱会拒绝登录，避免账户劫持。
- Git 通用连接器读取代码与文本快照；Issue、PR、Release 等扩展资料目前仍是 GitHub 专用能力。
- 网页来源只抓取服务端可读取的静态文本，不执行 JavaScript，也不提供页面登录或自定义请求头。
- Office 内嵌图片、音频和视频不会识别；单文件最大 25 MiB，其他细分限制见操作手册。
- 模型调用使用用户自己的供应商额度，可能产生费用；系统不维护实时价格，因此不估算账单。
- 自动化可以自动同步仓库、刷新网页和运行确定性质量检查；涉及向模型发送内容的索引与简报任务只创建待确认通知，不会绕过当次授权。
- 智能体没有 Shell、任意文件系统、代码修改、Git 写入、部署或 MCP 写权限。
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
- `worker`：running

Compose 使用三个命名卷：`ai-project-os-pgdata`、`ai-project-os-secrets`、`ai-project-os-uploads`。不要执行 `docker compose down -v`，该命令会删除数据库、凭据主密钥和上传文件。

如使用 HTTPS 反向代理，可设置基础设施开关 `AI_PROJECT_OS_SECURE_COOKIES=true`。`POSTGRES_PASSWORD` 若包含 URL 保留字符，需要先进行 URL 编码。

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
pnpm lint
pnpm typecheck
pnpm build
pnpm db:validate
git diff --check

V3_POSTGRES_GATE=1 pnpm exec tsx --test test/v3-postgres.test.ts
pnpm exec prisma migrate status --config prisma.config.ts
```

`pnpm build` 使用 Next.js Webpack 构建。真实 PostgreSQL V3 测试使用本地签名 OIDC 服务与隔离测试数据，不调用真实模型供应商。

## 主要页面

- `/dashboard`：跨项目概览、就绪度和最近任务。
- `/projects`：项目管理。
- `/settings`：模型连接。
- `/connections`：Git 连接。
- `/team`：成员、邀请和 OIDC。
- `/notifications`：通知中心。
- `/profile`：个人资料与登录安全。
- `/guide`：页面操作指南。
- `/projects/:projectId/assets`：文件资料。
- `/projects/:projectId/external-sources`：网页与本地文件夹。
- `/projects/:projectId/repositories`：多 Git 仓库。
- `/projects/:projectId/automations`：自动化。
- `/projects/:projectId/control`：AI 路由。
- `/projects/:projectId/memory`：抽取、索引、搜索和 RAG。
- `/projects/:projectId/memory-quality`：记忆质量与生命周期。
- `/projects/:projectId/intelligence`：简报和只读智能体。
- `/projects/:projectId/governance`：审核、异常与用量。

## 历史材料

V1 CLI 手册和历史运行合同继续保留用于兼容与审计，但不覆盖 V3.0.0 的页面能力。当前能力、限制和使用方式以本 README、页面指南和操作手册为准。
