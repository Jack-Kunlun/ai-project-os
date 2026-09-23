# GitHub Actions 生产部署

状态：`CONTROLLED_PRERELEASE`。当前批准的生产目标是 `v0.6.0-dev.8`。该版本仍是预发布，不是稳定版或 GitHub Latest；工作流只对这一精确目标标签开放，并要求生产当前运行 `v0.6.0-dev.7`。

AI Project OS 从 GitHub Actions 的 **Deploy production** 工作流手动部署已经通过标签 CI 的批准版本。该入口仅负责部署当前有效产品版本，不把部署权限开放给产品内的 Action Engine、MCP 或自动化 Worker。

## v0.5.0-dev.1 clean-reset 边界

`v0.5.0-dev.1` 使用一次性的 `clean-deploy` 路径，不是 v0.4 的数据库升级。部署器在切换前必须完成并验证 PostgreSQL、主密钥卷、上传卷和主机恢复配置的加密异地备份，然后只删除 Compose 项目标记且未被挂载的 `AI_PROJECT_OS_PGDATA_VOLUME`；永不删除 secrets、uploads、`.env` 或备份目录，也不执行 `down -v`、Docker prune 或通配删除。

因此 v0.3 用户、配置、额度、审计、供应商连接和其他数据库记录不会被带入 v0.4；管理员必须在新数据库的 `/setup` 重新初始化并重新配置供应商、额度、审计基线和其他平台数据。备份是强制门禁，但 PostgreSQL 卷删除后不提供自动回滚；失败时保留备份与新栈现场，由管理员按验证过的备份恢复或修复。

## v0.5.0-dev.4 preserve-data 边界

`v0.5.0-dev.4` 只允许从已运行的 `v0.5.0-dev.1` 做一次性保留数据切换。部署器会先校验运行中 app/worker 容器自身携带的 `.1` OCI 版本元数据；即使旧容器记录的镜像 digest 已无法由 Docker inspect 找到，也不会因此误判源容器。旧 writer 仍服务时，部署器先在精确 `.1` checkout 构建 app/worker，并按服务固定可 inspect 的回滚镜像引用，再构建 `.4` 目标镜像；只有源回滚制品和目标镜像均复核通过后，才停止 writer。停止精确旧 writer 后排空数据库客户端，完成 `pre-deploy-to-v0.5.0-dev.4` 加密异地备份，再只重建 app/worker。它不会运行数据库迁移、principal bootstrap、reconcile，不会删除或重建 PostgreSQL 容器/卷，也不会执行 Compose down 或 Docker prune。

切换前后必须保持同一 PostgreSQL 容器、PGDATA 物理卷名称、创建时间、Compose 标签和唯一挂载者，且 `_prisma_migrations` 为 106 条总计、106 条已完成、0 条回滚、0 条未完成；关键数据计数不得减少。切换失败时，部署器使用切换前由精确 `.1` checkout 重建并固定的服务级回滚镜像引用和源 checkout 自动恢复 `.1` app/worker；不依赖已经消失的旧容器镜像 digest，也不宣称重建制品与历史镜像字节级相同。回退也失败时会按 Compose project/service 精确停止 app/worker，并验证只剩原 PostgreSQL 运行后输出 `PRESERVE_DEPLOY_RECOVERY_REQUIRED`。若停止或隔离验证失败，则输出 `PRESERVE_DEPLOY_EMERGENCY writers_may_be_running=true`，不得假定写入者已停止，必须立即人工处置。

## v0.6.0-dev.6 迁移边界

`v0.6.0-dev.6` 从 `.5.0-dev.1` 或 `.5.0-dev.4` 的 106 条精确 Prisma 迁移账本升级到 107 条。部署器在旧 app/worker 仍健康时构建全部候选镜像并执行只读预检，然后停止捕获到的两个写入容器，确认 Compose 仅剩 PostgreSQL、运行时与权益写入角色已无数据库会话，再创建 `source_quiesced=true` 的加密异地备份。只有这些证据齐全时才运行 principal bootstrap、migration、权限 reconcile 与新 app/worker。

迁移后的预检要求 107 条迁移名称和 SHA-256 checksum 与候选 tag 完全一致，并确认四张个人知识库表存在。迁移边界前失败会重启原 app/worker；迁移边界后失败会停止新 app/worker，输出 `V06_DEPLOY_RECOVERY_REQUIRED` 以及本地备份、COS 对象和 manifest，禁止旧应用自动连接可能已经升级的结构。恢复时按备份 manifest 在隔离环境验证后，使用现有 recovery 模式恢复对应 0.5 源版本。

## v0.6.0-dev.7 无迁移补丁边界

`v0.6.0-dev.7` 只允许从已运行且健康的 `v0.6.0-dev.6` 进入。部署器在旧 app/worker 仍服务时构建新的 app、worker 和只读补丁预检镜像，确认源/目标标签为线性 annotated tag 且 `prisma/migrations` 零差异；停止精确旧 writer 后创建 `source_quiesced=true` 的 `.7` 备份，再次确认 107 条迁移账本、四张个人知识关系以及预先列明的约束、索引、触发器、函数名称/数量、启用/有效状态和枚举值满足预检，最后只重建 app/worker。

补丁路径不会启动 `principal-bootstrap`、`migrate` 或 `reconcile`，不会删除或重建 PostgreSQL、secrets、uploads 卷。切换失败时会停止候选 writer，使用切换前捕获的 `.6` 镜像引用恢复旧 app/worker；恢复失败输出 `PATCH_DEPLOY_EMERGENCY` 并保持 writer 隔离，等待人工处置。

## v0.6.0-dev.8 迁移边界

`v0.6.0-dev.8` 只允许从已运行且健康的 `v0.6.0-dev.7` 进入。部署器在旧 writer 服务期间构建候选镜像并验证精确 107 条源迁移账本；停止 app/worker、排空写入会话并完成 `source_quiesced=true` 异地备份后，才运行 principal bootstrap、9 条新迁移和权限 reconcile。启动新 writer 前再次验证 116 条迁移名称、checksum、新增关系、枚举和触发器。

迁移边界后失败会停止候选 writer并输出 `V06_NEXT_DEPLOY_RECOVERY_REQUIRED` 及备份证据，不会让 `.7` writer 自动连接已变更的结构。

## 安全模型

- 工作流只能通过 `workflow_dispatch` 手动触发，并且必须从 `main` 运行。
- 当前目标输入只接受 `v0.6.0-dev.8`，目标必须是 annotated tag，且 `package.json`、应用版本与 OCI 标签必须匹配 `0.6.0-dev.8`；源输入只接受 `v0.6.0-dev.7`。
- 部署前会通过 GitHub API 确认所选源标签和 0.6 目标标签对应精确提交的 `CI` push 运行已经 `completed/success`。
- GitHub 使用独立 ED25519 私钥；服务器对应公钥带 `restrict` 和 forced-command，不能获取 Shell、PTY、端口转发或执行任意命令。
- forced-command 当前发布只接受精确的 `deploy-v06-next v0.6.0-dev.7 v0.6.0-dev.8 <source SHA> <target SHA> CONFIRM_V06_NEXT_MIGRATION_V1`；历史协议继续保留用于审计。其他命令全部拒绝，sudoers 不开放 Shell、Git 或 Docker。
- 服务器会再次通过 GitHub 公共 API 核验标签 CI，专用私钥本身不能绕过发布门禁。
- 生产 `.env` 位于 `/etc/ai-project-os/production.env`，权限为 `root:root 0600`，不会进入仓库、Actions 日志或部署结果。
- 历史 `.5 -> .6` 路径会构建并复核源回滚制品和目标镜像；`.6 -> .7` 路径会在旧 app/worker 仍健康时捕获精确容器与镜像身份并构建目标镜像和只读预检。两条路径都会停止旧 app/worker，确认维护窗口中只剩本项目的 PostgreSQL 且端口只绑定 `127.0.0.1`，再以 stopped-writer cutover 模式调用 `pre-deploy` 备份。只有 `BACKUP_OK source_quiesced=true`、归档对象和唯一命名且经 COS metadata 验证的 manifest 均验证成功后才允许继续；完整合同见[生产异地备份](production-backup.md)。
- 0.6 迁移部署在验证停写备份后只运行受 Compose 依赖约束的 principal bootstrap、migrate、reconcile、app 与 worker；`.6`→`.7` 补丁只运行 app 与 worker，绝不执行 `docker compose down`、删除卷或 Docker prune。
- 同一时间只允许一个生产部署；GitHub 与服务器两侧均禁止并发覆盖。

## 一次性服务器准备

在可信电脑上生成独立密钥，不要复用个人 SSH 密钥：

```bash
ssh-keygen -t ed25519 -N '' \
  -C github-actions-ai-project-os-production \
  -f ./ai-project-os-actions-production
```

只把公钥上传到服务器，然后在 `/srv/ai-project-os/app` 的受信发布源码中执行安装器：

```bash
sudo deploy/production/install-production-deploy.sh \
  /home/deploy/ai-project-os-actions-production.pub
```

安装器会：

1. 安装 root-owned 的历史部署器、`.7`→`.8` 迁移部署器、release-tooling 更新器和 forced-command gateway；历史 clean-deploy 文件仅保留作受控恢复材料，不在 Actions sudoers 中开放。
2. 使用 `visudo` 校验并安装只允许固定部署程序的 sudoers 规则。
3. 把现有生产 `.env` 复制到 `/etc/ai-project-os/production.env`，设为 `root:root 0600`，同时收紧旧文件权限。
4. 创建密码锁定的专用系统账号 `ai-project-os-actions`，只为该账号追加受限 Actions 公钥；现有 `deploy` 人工运维账号和公钥保持不变。
5. 校验并安装 root-only 的 COS/age 备份脚本、每日 systemd timer、备份与部署结果目录；备份配置不完整时安装失败关闭。

### 0.6 发布工具更新边界

服务器需要从包含 `ai-project-os-install-release-tooling` 的受信源码人工执行一次上述安装器。完成这一次初始化后，受限账号可以通过 `install-release-tooling` 协议刷新 0.6 系列的 root-owned 发布工具，不再需要为每个 0.6.x 候选登录服务器重复运行安装器。

更新器只接受 `v0.6.<patch>` 或 `v0.6.<patch>-dev.<number>` annotated tag、精确 40 位提交和固定确认词。它使用与运行中 Compose checkout 分离的 root-owned 仓库，再次核验固定 GitHub origin、标签提交、`package.json` 版本和该标签提交的成功 CI。通过后只安装代码中列出的 gateway、更新器、迁移/补丁部署器、preserve 部署器、OAuth 配置器、Compose operations override 和 sudoers；候选文件必须是普通非空文件，Shell 与 sudoers 必须先通过语法检查，目标路径不能由远端参数指定。

当前 **Deploy production** 工作流先用服务器现有更新器完成一次 bootstrap，再用候选 `.8` 更新器完成第二次工具同步，随后调用 `.7`→`.8` 专用迁移协议。同一 Actions 运行完成工具同步、OAuth 配置同步、停写备份、数据库迁移和公网健康验证。

## GitHub Environment

在仓库 **Settings → Environments** 创建 `production`。建议配置 Required reviewers，避免误触立即进入生产。

在 `production` 的 Environment secrets 中添加：

- `PRODUCTION_SSH_PRIVATE_KEY`：上面生成的完整私钥内容。
- `PRODUCTION_SSH_KNOWN_HOSTS`：经过现有可信 SSH 连接核对的服务器 ED25519 known_hosts 行。
- `AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET`：线上 GitHub OAuth App 的 Client Secret。

在 `production` 的 Environment variables 中添加：

- `AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID`：线上 GitHub OAuth App 的 Client ID。

并在 Environment variables 中添加：

- `PRODUCTION_SSH_HOST`：当前生产主机的公网 IPv4。工作流不在源码中硬编码服务器地址；主机迁移后必须同时更新此变量和 `PRODUCTION_SSH_KNOWN_HOSTS`。

不要把私钥、数据库密码、服务器 `.env` 或外部服务凭据保存为仓库文件、Actions artifact 或普通变量。

整机迁移、最终停写、加密恢复与回退流程见[单节点主机迁移与恢复](production-host-migration.md)。

生产 job 在任何备份、迁移或容器替换之前，通过受限 SSH key 的固定
`configure-github-oauth` 命令把 OAuth 配置经标准输入发送给 root-owned 配置器。配置器只接受固定三行协议，校验 GitHub 凭据格式、生产 `.env` 的 owner/mode、数据库密码与安全 Cookie 基线，把公开 origin 固定为 `https://ai-project-os.com`，并在同一目录原子替换 `/etc/ai-project-os/production.env`。Client Secret 不进入命令参数、Actions 输出、部署结果或仓库；远端只返回 `PRODUCTION_GITHUB_OAUTH_CONFIG_OK`。

首次使用 0.6 Actions 发布前，服务器必须从受信候选源码运行一次 `install-production-deploy.sh`，安装受限网关、固定 allowlist 的发布工具更新器和 0.6 部署器。之后工作流会从已验证的目标标签按固定顺序暂存并替换 root-owned 工具，最后切换网关；安装或更新发布工具都不会自动部署应用，配置 Environment 也不会绕过标签、CI、备份或数据库预检。

## 部署流程

一般生产标准要求在点击生产入口前用当前生产备份在隔离主机完成恢复演练，并确认备份归档、manifest、数据库权限、app、worker 和登录边界均通过。保留数据切换不删除生产数据库，但回退所需的源 checkout、可 inspect 的源回滚制品和 PostgreSQL 身份证据必须可用；还必须确认生产服务器已安装本版本网关/部署器，Environment secrets/variables 完整。

1. 打开 GitHub 仓库的 **Actions**。
2. 选择 **Deploy production**。
3. 点击 **Run workflow**，Branch 保持 `main`，确认 tag 为 `v0.6.0-dev.8`，source 为 `v0.6.0-dev.7`。
4. 如配置了 Environment 审批，批准该部署。
5. 工作流才会依次完成标签/CI 验证、受限 SSH、加密异地备份、部署、公网健康与 HTTP→HTTPS 跳转验证。

成功日志只报告 tag、提交、本地备份目录、COS 对象路径和健康状态，不输出密码或连接字符串。生产部署结果保存在 `/var/lib/ai-project-os/last-deployment`，权限为 `root:root 0600`。

## 失败与恢复边界

- 标签 CI 缺失或失败：部署不会连接服务器。
- SSH、本地备份、age 加密、COS 上传/远端校验、磁盘空间或当前容器状态异常：部署在迁移前失败关闭；失败备份没有远端成功标记，因此不会触发本地清理。
- 预构建、停止、维护隔离或备份失败：切换尚未开始，部署器只重启已捕获的旧 app/worker ID，并保留已创建的备份。
- migration、reconcile、app/worker 启动或健康检查在数据库变更后失败：部署器停止 app/worker 并输出 `V06_DEPLOY_RECOVERY_REQUIRED` 及备份位置。不得直接重启 0.5 writer；先在隔离环境验证 stopped-writer 备份，再按恢复手册处理。
- `.6 -> .7` 补丁在无数据库变更的切换阶段或健康校验失败：部署器停止候选 writer，使用切换前捕获的 `.6` 镜像身份恢复 app/worker；恢复成功输出 `PATCH_DEPLOY_RECOVERY_REQUIRED`，恢复失败输出 `PATCH_DEPLOY_EMERGENCY` 并保持 writer 隔离。
- `.7 -> .8` 在迁移边界前失败会恢复旧 writer；迁移边界后失败会保持 writer 隔离并输出 `V06_NEXT_DEPLOY_RECOVERY_REQUIRED`，需使用 stopped-writer 备份进行人工恢复。
- 人工恢复前先确认目标版本与备份 manifest。恢复目标必须与 manifest 的 `appVersion` 精确一致：0.5→0.6 备份仍按 `.1` 或 `.4` 源版本恢复；`.6`→`.7` 补丁备份记录 `.6` 源版本，`pre-deploy-to-v0.6.0-dev.7` 只是备份用途名称，不会改变 manifest 的源版本。由源版本 checkout 重建的回滚镜像不保证与历史丢失镜像字节级一致，应先在隔离恢复环境验证。

服务器只自动删除超过本地保留期、已通过远端验证并带 root-only 标记的旧备份，同时保留最小副本数；无标记的手工或失败备份不会删除。COS 生命周期仍需在定时运行、部署前备份和独立恢复均通过后另行配置。“成功上传备份”不等于“恢复已经验证”。

## 部署后仍需人工验收

`/api/health`、容器健康和公网 HTTPS 只证明基础运行状态。首次 `/setup` 管理员初始化、管理员登录、会话 Cookie 的 `Secure` 属性、文件上传，以及重新配置的模型、Git、OIDC、Embedding 和第三方 MCP 连接仍需分别现场验证。
