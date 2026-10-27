# AI Project OS

把资料、问题和下一步工作放在一起。

AI Project OS 是一个可自行部署的知识与项目工作台。你可以把文档、会议记录、网页和代码仓库中的内容汇集起来，围绕资料提问，查看回答的出处，再把需要推进的事情放进项目计划。

它既可以作为个人知识库，也可以供团队共同维护项目资料、决策、进展与风险。

[开始使用](#开始使用) · [本机部署](#本机部署) · [使用指南](docs/user-operation-guide.md) · [版本记录](CHANGELOG.md) · [许可](#许可与商业授权)

## 可以用它做什么

**整理自己的知识。** 在“我的知识”中保存笔记和导入文件，检索已有内容，或打开一篇资料直接提问。个人资料可以独立使用，需要用于协作时再放入项目。

**围绕资料讨论项目。** 将需求文档、会议记录、网页和只读仓库内容加入项目，整理其中的决策、进展、问题与风险。问答保留引用和会话历史，可以连续追问、置顶、重命名、归档或移至回收站，也可以在其他页面打开悬浮问答。

**把讨论落实到工作。** 为工作项指定负责人、期限、验收标准和相关证据，查看依赖、逾期与受阻情况。项目概览、简报和通知帮助团队了解进展，成员按各自权限访问内容。

想查看资料之间的联系，可以打开“知识图谱”，在三维视图中浏览资料、已确认事实和已记录关系，点击节点回到详情。模型用量和平台额度可在用量与账单相关页面查看。

界面支持中文、英文，以及浅色、深色和跟随系统的主题。资料正文、问题、回答和引用保留原文。

## 开始使用

已有账号时，登录后从下面任一路径开始。需要自己搭建实例，请先看[本机部署](#本机部署)。

### 先试一篇自己的资料

打开 **我的知识 → 新建或导入 → 保存 → 提问这篇**。在输入框核对本轮范围和模型，点击发送即可围绕这篇内容提问并查看引用，无需先创建项目或配置个人模型。平台管理员须已启用相应的默认模型，账号也需要有可用的平台额度。

### 用一个项目串起资料和工作

1. **创建项目**：在“我的项目”中新建项目，填写名称和描述。当前工作区需要有创建项目的权限。
2. **添加资料**：进入“项目资料”，点击“添加资料”，上传需求文档、会议记录等内容，或直接输入文字。
3. **整理内容**：确认模型和资料范围后提交后台整理，在“识别任务”中查看进度。图片和扫描件先核对识别文字；冲突或不确定的整理结果留待人工处理。
4. **围绕项目提问**：打开“智能问答”并选择该项目，例如：“还有哪些待解决的问题？请附上对应资料。”根据回答中的引用核对原文。
5. **安排下一步**：进入“项目计划”，创建工作项并补充负责人、验收标准和证据。资料整理结果和 AI 建议需要由人决定如何纳入计划。

之后可按需要邀请成员、生成简报或设置自动化。完整操作见[使用指南](docs/user-operation-guide.md)，应用内可从头部帮助入口查看操作说明。

## 本机部署

以下步骤用于**首次启动一个新的本地实例**。已有部署的更新请阅读[正式发布说明](docs/production-release.md)。

### 1. 准备环境

安装并启动 Docker Desktop，使用 Docker Compose **2.30 或以上**，然后获取源码：

```bash
git clone https://github.com/Jack-Kunlun/ai-project-os.git
cd ai-project-os
cp .env.example .env
```

编辑 `.env`，填写六项数据库密码。每项使用独立的随机值，可分别运行 `openssl rand -hex 32` 生成。

<details>
<summary>查看需要填写的六项密码</summary>

```dotenv
POSTGRES_CLUSTER_ADMIN_PASSWORD=
POSTGRES_MIGRATOR_PASSWORD=
POSTGRES_RUNTIME_PASSWORD=
POSTGRES_ENTITLEMENT_WRITER_PASSWORD=
POSTGRES_GIT_AUTOMATION_WORKER_PASSWORD=
POSTGRES_ENTITLEMENT_INVENTORY_READER_PASSWORD=
```

</details>

本机试用时，再将 `LOCAL_REGISTRATION_ENABLED` 改为 `true`，便于创建普通账号；其他值先保留示例默认值。注册默认关闭，邮箱、短信和 GitHub 登录需要另外配置。`.env` 中的真实密码和密钥不要提交到仓库。

### 2. 启动服务

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps --all
```

首次启动会构建应用并初始化数据库。正常时，`postgres`、`app`、`worker`、`git-worker` 显示为 `healthy`，`principal-bootstrap`、`migrate`、`reconcile` 显示为 `Exited (0)`。

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。也可以检查服务状态：

```bash
curl --fail http://127.0.0.1:3000/api/health
```

### 3. 完成首次配置

1. **创建平台管理员**：首次访问会进入初始化页面。管理员负责配置模型、账号和额度。
2. **配置模型**：在管理端的“模型与能力”中添加供应商，测试连接并启用所需能力。
3. **创建普通账号**：退出管理员，在登录页注册普通账号。它会拥有自己的个人工作区，用于日常知识和项目操作；此步骤需要前面已开启本地注册。
4. **配置试用权益和额度**：重新登录管理员，为刚创建的账号配置相应权益与平台额度。本地用户名注册不自动发放新用户赠送权益。

完成后，用普通账号登录，按[开始使用](#开始使用)添加第一篇资料。若采用邮箱、短信或 GitHub 登录，请先按相应指南配置，再创建普通账号。

本地数据保存在数据库、凭据主密钥和上传文件三个命名卷中。停止服务可使用 `docker compose down`；**不要添加 `-v`**，它会删除这些数据卷。对外提供访问前，按[部署安全说明](docs/deployment-security.md)配置 HTTPS、反向代理和入口限流。

## 常见问题

### 需要自己准备模型 API Key 吗？

普通用户可以使用管理员配置的平台默认模型，账号需要有可用的平台额度。自行部署时，由管理员准备供应商凭据并启用模型。符合会员条件的用户也可以配置个人模型，用于项目时还需要完成项目授权。

支持 OpenAI、DeepSeek、Qwen、GLM；可用的生成、视觉和向量能力取决于实际配置和连接测试。Git、GitHub 登录、OIDC、短信、邮箱和 MCP 各有启用条件，接入说明见[管理员指南](docs/admin-operation-guide.md)。

### 资料会发送到哪里？

自行部署时，资料保存在自己的部署中。识别、整理和问答需要调用外部模型时，页面会展示模型和发送范围，经你确认后再发送给对应供应商；智能问答会发送当前问题、所选范围内的相关资料与已有会话上下文，输入框会持续展示供应商与计量条款，点击发送即授权本轮发送。自动化中的模型任务同样需要当次确认。Token 用量与平台额度分别展示。

### 支持导入哪些资料？

支持常见文本、PDF、Word、Excel、PowerPoint 和图片，也可导入网页、本地文件夹及配置好的只读 Git 仓库内容。图片、扫描件和项目 Office 内嵌图片的识别依赖视觉模型；个人知识库的 Office 导入只取正文，暂不支持音视频识别。

网页导入目前以静态文本为主。需要执行 JavaScript 或登录站点的正文抓取尚未作为常规部署能力开放。

### 整理结果还需要逐条确认吗？

项目上传文件、已核对图文和手工资料中，直接摘自原文、表述明确且不与已有事实冲突的内容，可以自动记为项目事实。改写、冲突或不确定的内容，以及网页、仓库和工具结果，仍由人核对。整理结果保留来源，便于回到原文判断和修正。

### 问答怎样找到资料？

统一智能问答目前按关键词选择资料，再结合本轮确认的范围和会话历史回答。需要语义检索时，可使用个人知识或项目高级工具中的索引与检索功能。查看回答时，可以沿引用核对当时使用的资料版本。

### 它能自动执行项目工作吗？

项目智能体可以分析资料、生成简报和提出建议。创建工作项、接受建议、推进状态及确认完成仍由人操作；代码修改、Git 写入、Shell 执行、合并和部署不在其权限范围内。

Git 和受控 MCP 工具只读。MCP 工具读取需要管理员审核、项目授权和逐次审批，成功结果经人工选择后才能纳入资料。真实外部服务须在自己的部署中验证。

## 开发与检查

应用使用 Next.js、React、TypeScript、Prisma 和 PostgreSQL + pgvector；后台 Worker 与应用在同一个仓库中维护。

<details>
<summary>展开本地开发配置与检查命令</summary>

本地开发需要 Node.js 24、pnpm 10.14.0 和 PostgreSQL 18 + pgvector。先在独立开发库中完成数据库初始化与权限配置，在 `.env` 中设置宿主机可访问的 `DATABASE_URL`（运行账号）、`ENTITLEMENT_DATABASE_URL`（额度写入账号）和 `GIT_AUTOMATION_DATABASE_URL`（Git Worker 账号）。使用已有加密连接时，还需要与该数据库配套的凭据主密钥。数据库角色和配置见[管理员指南](docs/admin-operation-guide.md#2-首次启动与升级)。

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev
```

需要后台识别与自动化时，在另一个终端加载同一份开发环境变量后运行 `pnpm worker`。Git 自动同步使用独立的 `git-worker`；若直接运行其脚本，该进程的 `DATABASE_URL` 和 `GIT_AUTOMATION_DATABASE_URL` 必须同时指向专用 Git Worker 账号。Compose 已配置这两个后台服务。

| 命令 | 用途 |
| --- | --- |
| `pnpm test` | 默认测试集，部分集成测试需独立环境 |
| `pnpm lint` / `pnpm typecheck` | 代码规范与类型检查 |
| `pnpm build` | 生产构建 |
| `pnpm performance:check` | 检查已生成构建产物的性能预算 |
| `pnpm db:validate` | 校验 Prisma Schema 和迁移文件 |

数据库集成、浏览器与容器验收的独立环境要求见[持续集成说明](docs/continuous-integration.md)和[本地候选验收](docs/local-release.md)。

</details>

## 进一步阅读

| 你需要了解 | 文档 |
| --- | --- |
| 日常使用、资料整理、问答与项目协作 | [普通用户指南](docs/user-operation-guide.md) |
| 模型、账号、额度与平台管理 | [管理员指南](docs/admin-operation-guide.md) |
| 邮箱或手机号登录的配置与限制 | [邮箱认证](docs/email-authentication.md) · [手机号认证](docs/phone-authentication.md) |
| 公网部署与正式版本更新 | [部署安全](docs/deployment-security.md) · [正式发布](docs/production-release.md) |
| 服务监控、备份与恢复 | [运行监控](docs/monitoring.md) · [备份](docs/production-backup.md) · [迁移与恢复](docs/production-host-migration.md) |
| 验证自己接入的模型、Git、OIDC 或 MCP | [外部服务验收](docs/external-service-acceptance.md) |
| 版本变化与历史记录 | [当前源码版本 1.2.19](docs/releases/v1.2.19.md) · [更新记录](CHANGELOG.md) |

## 许可与商业授权

项目作者：**风岚（笔名）**。

本仓库中项目权利人有权授权的软件代码采用 [PolyForm Strict License 1.0.0](LICENSE.md)，属于源码可见许可；具体权利以许可证全文为准。

- **非商业使用**：可按许可证使用软件。该许可不授予修改、制作衍生作品或分发软件的权利；如需这些权利，须另行取得书面授权。
- **商业使用**：须事先取得单独书面授权。联系邮箱：[1837115857@qq.com](mailto:1837115857@qq.com)。
- **其他材料**：第三方组件适用其各自许可；文档等其他材料未另行授权。
