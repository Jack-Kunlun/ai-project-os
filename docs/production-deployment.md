# GitHub Actions 生产部署

状态：`CONTROLLED_PRERELEASE`。当前批准的生产目标是 `v0.5.0-dev.4`。该版本仍是预发布，不是稳定版或 GitHub Latest；工作流只对这一精确标签开放，旧 `v0.5.0-dev.1` clean-reset 入口、`v0.5.0-dev.2`、`v0.5.0-dev.3`、`v0.4.0-dev.1`、`v0.3.0-dev.1`、`v0.2.0-dev.1` 和其他 `-dev` 标签继续失败关闭。

AI Project OS 从 GitHub Actions 的 **Deploy production** 工作流手动部署已经通过标签 CI 的批准版本。该入口仅负责部署当前有效产品版本，不把部署权限开放给产品内的 Action Engine、MCP 或自动化 Worker。

## v0.5.0-dev.1 clean-reset 边界

`v0.5.0-dev.1` 使用一次性的 `clean-deploy` 路径，不是 v0.4 的数据库升级。部署器在切换前必须完成并验证 PostgreSQL、主密钥卷、上传卷和主机恢复配置的加密异地备份，然后只删除 Compose 项目标记且未被挂载的 `AI_PROJECT_OS_PGDATA_VOLUME`；永不删除 secrets、uploads、`.env` 或备份目录，也不执行 `down -v`、Docker prune 或通配删除。

因此 v0.3 用户、配置、额度、审计、供应商连接和其他数据库记录不会被带入 v0.4；管理员必须在新数据库的 `/setup` 重新初始化并重新配置供应商、额度、审计基线和其他平台数据。备份是强制门禁，但 PostgreSQL 卷删除后不提供自动回滚；失败时保留备份与新栈现场，由管理员按验证过的备份恢复或修复。

## v0.5.0-dev.4 preserve-data 边界

`v0.5.0-dev.4` 只允许从已运行的 `v0.5.0-dev.1` 做一次性保留数据切换。部署器会先校验运行中 app/worker 容器自身携带的 `.1` OCI 版本元数据；即使旧容器记录的镜像 digest 已无法由 Docker inspect 找到，也不会因此误判源容器。旧 writer 仍服务时，部署器先在精确 `.1` checkout 构建 app/worker，并按服务固定可 inspect 的回滚镜像引用，再构建 `.4` 目标镜像；只有源回滚制品和目标镜像均复核通过后，才停止 writer。停止精确旧 writer 后排空数据库客户端，完成 `pre-deploy-to-v0.5.0-dev.4` 加密异地备份，再只重建 app/worker。它不会运行数据库迁移、principal bootstrap、reconcile，不会删除或重建 PostgreSQL 容器/卷，也不会执行 Compose down 或 Docker prune。

切换前后必须保持同一 PostgreSQL 容器、PGDATA 物理卷名称、创建时间、Compose 标签和唯一挂载者，且 `_prisma_migrations` 为 106 条总计、106 条已完成、0 条回滚、0 条未完成；关键数据计数不得减少。切换失败时，部署器使用切换前由精确 `.1` checkout 重建并固定的服务级回滚镜像引用和源 checkout 自动恢复 `.1` app/worker；不依赖已经消失的旧容器镜像 digest，也不宣称重建制品与历史镜像字节级相同。回退也失败时会按 Compose project/service 精确停止 app/worker，并验证只剩原 PostgreSQL 运行后输出 `PRESERVE_DEPLOY_RECOVERY_REQUIRED`。若停止或隔离验证失败，则输出 `PRESERVE_DEPLOY_EMERGENCY writers_may_be_running=true`，不得假定写入者已停止，必须立即人工处置。

## 安全模型

- 工作流只能通过 `workflow_dispatch` 手动触发，并且必须从 `main` 运行。
- 当前输入只接受 `v0.5.0-dev.4`，目标必须是 annotated tag，且 `package.json` 版本必须精确匹配 `0.5.0-dev.4`；服务器同时固定核验不可变的 `.1` 源标签。
- 部署前会通过 GitHub API 确认 `.1` 源标签和 `.4` 目标标签对应精确提交的 `CI` push 运行已经 `completed/success`。
- GitHub 使用独立 ED25519 私钥；服务器对应公钥带 `restrict` 和 forced-command，不能获取 Shell、PTY、端口转发或执行任意命令。
- forced-command 只接受 `preserve-deploy v0.5.0-dev.1 v0.5.0-dev.4 <40 位 SHA> CONFIRM_PRESERVE_DATA_V1`，再调用 root 持有的固定部署程序；sudoers 不再开放 clean-deploy。专用系统账号 `ai-project-os-actions` 没有人工登录密钥；`deploy` 用户不加入 `docker` 组，也不获得无密码 sudo。
- 服务器会再次通过 GitHub 公共 API 核验标签 CI，专用私钥本身不能绕过发布门禁。
- 生产 `.env` 位于 `/etc/ai-project-os/production.env`，权限为 `root:root 0600`，不会进入仓库、Actions 日志或部署结果。
- 源回滚制品和目标镜像会在旧 app/worker 仍健康时完成构建与复核；部署器捕获精确健康容器 ID，停止旧 app/worker，确认维护窗口中只剩本项目的 PostgreSQL 并且端口只绑定 `127.0.0.1`，再以 stopped-writer cutover 模式调用 `pre-deploy` 备份。只有 `BACKUP_OK source_quiesced=true`、归档对象和唯一命名且经 COS metadata 验证的 manifest 均验证成功后才允许继续；完整合同见[生产异地备份](production-backup.md)。
- preserve-data 部署在验证备份后只执行 `docker compose up -d --no-deps --no-build --force-recreate app worker`；绝不执行 `docker compose down`、删除卷、Docker prune 或任何数据库初始化/迁移服务。
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

1. 安装 root-owned 的 `/usr/local/sbin/ai-project-os-preserve-deploy` 和 forced-command gateway；历史 clean-deploy 文件仅保留作受控恢复材料，不在 Actions sudoers 中开放。
2. 使用 `visudo` 校验并安装只允许固定部署程序的 sudoers 规则。
3. 把现有生产 `.env` 复制到 `/etc/ai-project-os/production.env`，设为 `root:root 0600`，同时收紧旧文件权限。
4. 创建密码锁定的专用系统账号 `ai-project-os-actions`，只为该账号追加受限 Actions 公钥；现有 `deploy` 人工运维账号和公钥保持不变。
5. 校验并安装 root-only 的 COS/age 备份脚本、每日 systemd timer、备份与部署结果目录；备份配置不完整时安装失败关闭。

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

该命令需要服务器已经安装当前版本的受限网关、preserve-data 部署器和配置器。部署 `v0.5.0-dev.4` 前必须从受信候选源码重新运行 `install-production-deploy.sh`，使 root-owned 工具、106-entry migration ledger 门禁、完整容器 ID 字符串校验、源回滚制品门禁与精确 tag allowlist 同步更新；旧网关不接受该 preserve 命令。安装工具不会自动部署应用，配置 Environment 也不会绕过标签、CI、备份或数据不变性预检。

## 部署流程

在点击生产入口前，必须先用当前生产备份在隔离主机完成恢复演练，并确认备份归档、manifest、数据库权限、app、worker 和登录边界均通过。保留数据切换不删除生产数据库，但回退所需的源 checkout、可 inspect 的源回滚制品和 PostgreSQL 身份证据必须可用；运行中旧容器记录的 digest 不要求仍可 inspect。还必须确认生产服务器已安装本版本网关/部署器，Environment secrets/variables 完整。

1. 打开 GitHub 仓库的 **Actions**。
2. 选择 **Deploy production**。
3. 点击 **Run workflow**，Branch 保持 `main`，确认 tag 为 `v0.5.0-dev.4`。
4. 如配置了 Environment 审批，批准该部署。
5. 工作流才会依次完成标签/CI 验证、受限 SSH、加密异地备份、部署、公网健康与 HTTP→HTTPS 跳转验证。

成功日志只报告 tag、提交、本地备份目录、COS 对象路径和健康状态，不输出密码或连接字符串。生产部署结果保存在 `/var/lib/ai-project-os/last-deployment`，权限为 `root:root 0600`。

## 失败与恢复边界

- 标签 CI 缺失或失败：部署不会连接服务器。
- SSH、本地备份、age 加密、COS 上传/远端校验、磁盘空间或当前容器状态异常：部署在迁移前失败关闭；失败备份没有远端成功标记，因此不会触发本地清理。
- 预构建、停止、维护隔离或备份失败：切换尚未开始，部署器只重启已捕获的旧 app/worker ID，并保留已创建的备份。
- app/worker 切换或健康检查失败：部署器恢复源 `.1` checkout 和已固定的源回滚镜像引用，并验证本地健康、数据计数、迁移 ledger 与 PGDATA 身份；回退失败时先隔离 app/worker 并输出 `PRESERVE_DEPLOY_RECOVERY_REQUIRED`。若 stop/隔离验证失败，输出 `PRESERVE_DEPLOY_EMERGENCY writers_may_be_running=true`，不得宣称写入者已停止，必须立即人工处置。
- 人工恢复前先确认目标版本与备份 manifest；`.1` recovery 可以接受 `pre-deploy-to-v0.5.0-dev.4` 备份，未来 `.4` recovery 仍只接受 appVersion 与目标标签一致的备份。由 `.1` 源 checkout 重建的回滚镜像不保证与历史丢失镜像字节级一致，应先在隔离恢复环境验证。

服务器只自动删除超过本地保留期、已通过远端验证并带 root-only 标记的旧备份，同时保留最小副本数；无标记的手工或失败备份不会删除。COS 生命周期仍需在定时运行、部署前备份和独立恢复均通过后另行配置。“成功上传备份”不等于“恢复已经验证”。

## 部署后仍需人工验收

`/api/health`、容器健康和公网 HTTPS 只证明基础运行状态。首次 `/setup` 管理员初始化、管理员登录、会话 Cookie 的 `Secure` 属性、文件上传，以及重新配置的模型、Git、OIDC、Embedding 和第三方 MCP 连接仍需分别现场验证。
