# GitHub Actions 生产部署（未来能力，当前禁用）

状态：`PLANNED`。AI Project OS 当前仍处于 `0.1.0-dev.1` 内部开发阶段，没有正式发布基线；首个正式公开版本计划为 `1.0.0`。在 `v1.0.0` 正式发布前，**Deploy production** 工作流的生产 job 通过静态 `if: ... && false` fail-closed，任何手动触发都不会执行检出、SSH、部署或健康检查。

未来启用后，AI Project OS 才会从 GitHub Actions 的 **Deploy production** 工作流手动部署已经正式发布并通过标签 CI 的版本。该入口仅负责部署当前有效产品版本，不把部署权限开放给产品内的 Action Engine、MCP 或自动化 Worker。

## 安全模型

- 当前工作流 job 静态禁用，原因是项目尚未达到首个正式 `v1.0.0` 发布；重新启用前必须保留同一 fail-closed 原则。
- 启用后工作流只能通过 `workflow_dispatch` 手动触发，并且必须从 `main` 运行。
- 输入只接受 `vX.Y.Z`，目标必须是 annotated tag，且 `package.json` 版本必须匹配。
- 部署前会通过 GitHub API 确认该标签、该精确提交的 `CI` push 运行已经 `completed/success`。
- GitHub 使用独立 ED25519 私钥；服务器对应公钥带 `restrict` 和 forced-command，不能获取 Shell、PTY、端口转发或执行任意命令。
- forced-command 只接受 `deploy <tag> <40 位 SHA>`，再调用 root 持有的固定部署程序。专用系统账号 `ai-project-os-actions` 没有人工登录密钥；`deploy` 用户不加入 `docker` 组，也不获得无密码 sudo。
- 服务器会再次通过 GitHub 公共 API 核验标签 CI，专用私钥本身不能绕过发布门禁。
- 生产 `.env` 位于 `/etc/ai-project-os/production.env`，权限为 `root:root 0600`，不会进入仓库、Actions 日志或部署结果。
- 每次替换容器前，会把 PostgreSQL、自持主密钥卷和上传卷备份到 `/var/backups/ai-project-os/<timestamp>-to-<tag>.*`，并校验 dump、tar 和 SHA-256。
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

1. 安装 root-owned 的 `/usr/local/sbin/ai-project-os-deploy` 和 forced-command gateway。
2. 使用 `visudo` 校验并安装只允许固定部署程序的 sudoers 规则。
3. 把现有生产 `.env` 复制到 `/etc/ai-project-os/production.env`，设为 `root:root 0600`，同时收紧旧文件权限。
4. 创建密码锁定的专用系统账号 `ai-project-os-actions`，只为该账号追加受限 Actions 公钥；现有 `deploy` 人工运维账号和公钥保持不变。
5. 创建 root-only 的备份与部署结果目录。

## GitHub Environment

在仓库 **Settings → Environments** 创建 `production`。建议配置 Required reviewers，避免误触立即进入生产。

在 `production` 的 Environment secrets 中添加：

- `PRODUCTION_SSH_PRIVATE_KEY`：上面生成的完整私钥内容。
- `PRODUCTION_SSH_KNOWN_HOSTS`：经过现有可信 SSH 连接核对的服务器 ED25519 known_hosts 行。

不要把私钥、数据库密码、服务器 `.env` 或外部服务凭据保存为仓库文件、Actions artifact 或普通变量。

## 启用后的部署流程（未来计划）

首个正式 `v1.0.0` 发布并完成独立发布验收前，不要配置或点击生产部署入口。`0.1.0-dev.1` 以及任何 `-dev`/候选版本都不能进入生产 tag 通道。

在未来启用后：

1. 打开 GitHub 仓库的 **Actions**。
2. 选择 **Deploy production**。
3. 点击 **Run workflow**，Branch 保持 `main`，确认 tag。
4. 如配置了 Environment 审批，批准该部署。
5. 工作流才会依次完成标签/CI 验证、受限 SSH 部署、公网健康与 HTTP→HTTPS 跳转验证。

成功日志只报告 tag、提交、备份目录和健康状态，不输出密码或连接字符串。生产部署结果保存在 `/var/lib/ai-project-os/last-deployment`，权限为 `root:root 0600`。

## 失败与恢复边界

- 标签 CI 缺失或失败：部署不会连接服务器。
- SSH、备份、磁盘空间或当前容器状态异常：部署在迁移前失败关闭。
- 构建失败：旧容器保持运行，已创建的备份保留。
- 迁移或新容器健康失败：工作流失败并保留备份与容器现场；不会自动回滚数据库，因为新迁移可能与旧代码不兼容。
- 人工恢复前先确定目标版本的数据兼容性，再选择重新部署修复版本或从对应备份恢复 PostgreSQL、主密钥和上传卷。

备份当前不会自动删除。应按磁盘容量和合规要求另行制定保留、异机复制与恢复演练策略；“成功创建备份”不等于“恢复已经验证”。

## 部署后仍需人工验收

`/api/health`、容器健康和公网 HTTPS 只证明基础运行状态。首次初始化、管理员登录、会话 Cookie 的 `Secure` 属性、文件上传，以及实际配置的模型、Git、OIDC、Embedding 和第三方 MCP 连接仍需分别现场验证。
