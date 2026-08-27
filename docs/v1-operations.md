# V1 本机运行手册

AI Project OS V1 把网页人工工作台与本机受控编排分开：网页不保存 GitHub/OpenAI 凭据，也不提供模型授权、仓库同步、索引或搜索写接口；这些动作只由本机 CLI 发起。

## 1. 启动基础服务

要求 Node.js 24+、pnpm 10+ 和 Docker Desktop。

```bash
pnpm install
cp .env.example .env
# 设置 POSTGRES_PASSWORD 和宿主机 DATABASE_URL，保持 AI/GitHub 默认关闭
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
curl --fail http://127.0.0.1:3000/api/health
```

先在网页创建 Project，并记下项目 URL 中的 `projectId`。人工 Source 和 Project Snapshot 可以在不启用任何外部连接的情况下使用。

## 2. 授权人工资料

先从网页或项目 Source API 取得明确的 `sourceId`。每个 `--source-id` 都必须属于同一个项目，并通过本地敏感信息扫描。

```bash
pnpm project-ai:config -- status --project-id <projectId>
pnpm project-ai:config -- configure \
  --project-id <projectId> \
  --source-id <sourceId> \
  --acknowledge-external-model-transfer selected-project-sources-to-openai:v1
```

命令会创建固定策略和 30 天模型授权，但不会立刻发送资料。输出中 Embedding operation 的 grant ID 用于后续人工资料索引。

## 3. 连接多个 GitHub 仓库

在宿主机 `.env` 中显式设置：

```dotenv
GITHUB_ENABLED=true
GITHUB_TOKEN_FILE=/absolute/path/to/read-only-token-file
```

token 文件必须位于仓库之外；token 只应具有所选仓库和已启用资料类型的读取权限。不要把 token 放进 `.env`、命令行、JSON 配置或提交。

为每个仓库复制并编辑 `config/github-repository.example.json`。`requiredForProjectSnapshot` 决定该仓库是否是项目级跨仓库快照的硬依赖；`trackedRef`、资料开关、代码 roots 和软排除规则会固化到仓库账本。

```bash
pnpm github-repository -- connect \
  --project-id <projectId> \
  --repository <owner/name> \
  --config-file /absolute/path/to/repository-config.json

pnpm github-repository -- list --project-id <projectId>
pnpm github-repository -- status --project-id <projectId>
```

重复 `connect` 可增加多个仓库。网页和未认证 HTTP API 不显示私有仓库身份；`list` 与 `status` 只在本机输出。

## 4. 冻结并同步仓库证据

代码扫描按项目处理所有符合条件的仓库，并先冻结 tracked ref 对应 commit。资料同步按仓库执行，只读取配置中明确启用的 metadata、README、Markdown、Issue、PR 或 Release。

```bash
pnpm github-repository -- scan-code --project-id <projectId>
pnpm github-repository -- sync-material \
  --project-id <projectId> \
  --link-id <repositoryLinkId>
pnpm github-repository -- status --project-id <projectId>
```

仓库重定向、身份变化、无法确认权限、限流、过大响应、扫描隔离或冻结 commit 不一致都会失败关闭；旧的已发布快照不会被半成品覆盖。

## 5. 授权并构建 Embedding 索引

只有这一节的索引命令会把对应分块发送给 OpenAI。执行前必须确认你有权处理这些内容，并在 `.env` 中显式设置：

```dotenv
AI_ENABLED=true
AI_PROVIDER=openai
OPENAI_API_KEY=<local-only-key>
```

为每个需要语义检索的仓库分别签发代码和资料 grant。只需索引时可以仅授权 `embedding`：

```bash
pnpm repository-ai:grant -- issue \
  --project <projectId> \
  --link <repositoryLinkId> \
  --operations embedding \
  --consent repository-code-to-openai:v1 \
  --acknowledge-external-transfer \
  --acknowledge-processing-rights

pnpm repository-material-ai:grant -- issue \
  --project <projectId> \
  --link <repositoryLinkId> \
  --operations embedding \
  --consent repository-material-to-openai:v1 \
  --acknowledge-external-transfer \
  --acknowledge-processing-rights
```

使用各命令输出的 grant ID 构建索引：

```bash
pnpm project-memory:index -- project \
  --project-id <projectId> \
  --grant-id <manualSourceEmbeddingGrantId> \
  --acknowledge-external-model-transfer selected-project-sources-to-openai:v1

pnpm project-memory:index -- repository-code \
  --project-id <projectId> \
  --link-id <repositoryLinkId> \
  --grant-id <repositoryCodeGrantId> \
  --acknowledge-external-model-transfer repository-code-to-openai:v1 \
  --acknowledge-processing-rights

pnpm project-memory:index -- repository-material \
  --project-id <projectId> \
  --link-id <repositoryLinkId> \
  --grant-id <repositoryMaterialGrantId> \
  --acknowledge-external-model-transfer repository-material-to-openai:v1 \
  --acknowledge-processing-rights
```

每次执行只接受固定 OpenAI origin、固定 Embedding profile、无重定向的单次请求；无法对账、无效向量、维度错误或授权失效不会发布当前索引。

## 6. 发布仓库和项目 RAG 快照

先逐个发布仓库快照，再发布项目级跨仓库快照。项目发布要求所有 active 且 `requiredForProjectSnapshot=true` 的仓库都已有与当前 frozen commit、配置和索引一致的仓库快照。

```bash
pnpm project-memory:publish -- repository \
  --project-id <projectId> \
  --link-id <repositoryLinkId>

pnpm project-memory:publish -- project --project-id <projectId>
pnpm github-repository -- status --project-id <projectId>
```

发布使用仓库级原子指针；任一必需仓库未就绪时，项目指针保持原值。

## 7. 检索

关键词检索不访问外部网络。`--scope auto` 优先使用合格的跨仓库快照，否则回退到人工资料快照；也可以固定为 `project` 或 `repositories`。

```bash
pnpm project-memory:search -- \
  --project-id <projectId> \
  --query "当前风险是什么" \
  --take 5 \
  --scope auto
```

语义混合检索会把本次查询文本发送给 OpenAI 生成查询向量，必须逐次加入精确确认：

```bash
pnpm project-memory:search -- \
  --project-id <projectId> \
  --query "当前风险是什么" \
  --take 5 \
  --scope auto \
  --acknowledge-external-query-transfer project-query-to-openai:v1
```

结果只来自当前 Snapshot，并携带人工 Source 或仓库、frozen commit、路径/资料定位和内容摘要指纹等不可变引用。V1 返回检索证据，不执行生成式 RAG 回答。

## 8. 撤权和停用

```bash
pnpm project-ai:config -- revoke --project-id <projectId>
pnpm repository-ai:grant -- revoke --project <projectId> --link <repositoryLinkId>
pnpm repository-material-ai:grant -- revoke --project <projectId> --link <repositoryLinkId>
pnpm github-repository -- disable --project-id <projectId> --link-id <repositoryLinkId>
```

撤权、策略修订、仓库停用或 frozen commit 变化会使依赖它的索引、摘要、分析和 RAG 快照失去读取资格；历史审计和不可变证据账本仍保留。`unlink` 是更强的账本终态，只在确认不再使用该连接时执行。

## 9. V1 安全边界

- 没有认证、RBAC 或多用户隔离，因此只适合受信任的本机环境，不能直接暴露到公网。
- 自动抽取、生成式摘要、项目分析、RAG 回答和生产智能体执行仍关闭；已有实现覆盖固定计划、响应验证、引用、冲突、拒答、审计和失效语义。
- 智能体边界禁止 Shell、文件系统、任意网络、MCP、GitHub 写操作、数据库写工具和自动改代码。
- 没有后台 worker、定时同步或实时 GitHub webhook；同步和索引都由操作者显式运行。
- 本项目的验收使用 fake provider 和本地数据库证明边界，不代替操作者对真实私有内容的外发授权，也不声明真实模型质量或费用结果。
