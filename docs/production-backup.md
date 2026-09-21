# 生产异地备份

本工具用于单节点实例的 PostgreSQL、凭据主密钥卷、上传卷和主机恢复配置备份。它可以独立于发布入口安装；当前部署链支持 `v0.5.0-dev.1` clean-reset、历史 `v0.5.0-dev.2`、`v0.5.0-dev.3` 和当前 `v0.5.0-dev.4` preserve-data 的精确备份命名，仍拒绝旧 `v0.4.0-dev.1`、`v0.3.0-dev.1`、`v0.2.0-dev.1` 和其他未批准的预发布标签。

`v0.5.0-dev.1` 的 `clean-deploy` 将此备份作为强制破坏性 reset 门禁：v0.4 用户、配置、额度、审计、供应商连接和其他旧数据库记录不会迁移到新库，管理员必须重新初始化 `/setup`。备份成功不提供卷删除后的自动回滚；只有归档、唯一命名且经 COS metadata 验证的 manifest 均验证成功，部署器才会继续删除精确 PostgreSQL 卷。

`v0.5.0-dev.4` 的 `preserve-deploy` 使用 `pre-deploy-to-v0.5.0-dev.4` 命名，备份完成后只替换 app/worker，不启动数据库迁移或初始化服务，不删除 PostgreSQL 容器/卷。`.1` recovery 接受这份 source appVersion 为 `.1` 的部署前备份；`.4` future recovery 仍要求 manifest appVersion 与目标标签精确一致。历史 `.2` 和 `.3` 备份命名继续保留在恢复白名单中。

## 已实现边界

- `ai-project-os-backup.timer` 每天在服务器本地时间 03:20 后的随机 20 分钟窗口内运行，并通过 `Persistent=true` 补跑关机期间错过的计划。
- 普通 `daily`、`manual` 模式会先暂停 `app` 与 `worker`，在数据复制窗口采集 PostgreSQL custom dump、主密钥卷和上传卷，随后恢复写入者并等待两项 Docker health 重新变为 `healthy`，再继续上传并报告成功，因此其 `source_quiesced=false`。部署专用 `pre-deploy` 由部署器先停止并确认精确的旧 app/worker，再通过维护隔离和 post-stop 只读预检确认没有其他同库客户端；随后备份脚本读取这两个已停止容器的文件卷，生成并远端验证 `source_quiesced=true` 的最终迁移备份。备份失败或迁移前失败会通过精确容器 ID 恢复写入者；备份成功后才进入迁移，迁移开始后不恢复旧代码。暂停不能替代数据库客户端排空，因此 pre-deploy 不使用暂停作为最终快照边界。
- 格式版本 2 还会按严格白名单加入 `production.env`、COS 上传配置、age 公钥、TLS 证书/私钥、`deploy` 登录材料和 Actions 公钥。它们只存在于 age 加密归档内，不会写入公开 manifest、运维状态 JSON 或仓库。
- 本地备份先校验 `pg_restore --list`、三个 tar 目录和内部 `SHA256SUMS`，然后以专用 age 公钥流式加密；服务器不持有解密私钥。
- 加密归档、SHA-256 sidecar、唯一命名且经 COS metadata 验证的 manifest 和 `manifests/latest.json` 指针上传到 COS。COSCLI 必须完成整体 CRC64 校验，随后脚本通过 `HeadObject` 对比远端长度并要求 CRC64 元数据存在。
- 只有四件对象均验证成功，备份目录才会获得 root-only 的 `.cos-upload-verified` 标记。无标记、上传失败或结构不完整的本地备份不会进入自动清理范围。
- 默认只清理超过 14 天且带有效远端标记的本地备份，并始终保留至少 3 份已验证本地副本。现有手工备份因为没有自动上传标记，不会被删除。
- `v0.5.0-dev.1` clean-reset 部署器先在旧 app/worker 仍健康时完成候选镜像构建，再停止精确旧 writer ID，以 stopped-writer cutover 模式调用同一个脚本；只有 `BACKUP_OK source_quiesced=true`、归档对象和唯一命名且经 COS metadata 验证的 manifest 均验证成功后才允许 reset。远端备份失败会使部署失败关闭。
- `v0.5.0-dev.4` preserve-data 部署器沿用同一 stopped-writer 备份门禁，但只允许目标名 `pre-deploy-to-v0.5.0-dev.4`；成功后校验 PostgreSQL 容器、卷身份、106 条 migration ledger 和关键数据计数均未减少。历史 `.2` 和 `.3` 目标仍可由备份/恢复脚本识别，但不再进入新的生产部署入口。
- 每日/手工备份会先取得生产部署锁，部署期间不会启动；部署器持有同一把锁后再调用 `pre-deploy` 模式，避免定时备份与迁移或容器替换交叉运行。
- 每次任务会把运行中、成功、失败或跳过状态原子写入 `/var/lib/ai-project-os-operations/backups`。这里只包含时间、任务类型、对象路径、大小、摘要、重试次数和安全错误码；生产 Compose 以只读方式将该目录挂载给应用，应用没有 Docker、systemd、备份正文或凭据访问权。

COS 生命周期尚不由仓库脚本修改。必须先取得至少一次定时运行、一次部署前备份和一次独立恢复证据，再在腾讯云控制台配置远端保留策略。

## 服务器前置文件

以下文件必须由 `root` 持有：

| 路径 | 权限 | 用途 |
| --- | --- | --- |
| `/etc/ai-project-os/cos-backup.env` | `0600` | 非交互备份目标与本地保留策略 |
| `/etc/ai-project-os/coscli.yaml` | `0600` | COSCLI 加密凭据配置 |
| `/etc/ai-project-os/production-backup-age.pub` | `0644` | 仅包含 age 公钥 |

`cos-backup.env` 至少包含：

```dotenv
COS_BACKUP_BUCKET=ai-project-os-backup-1306016679
COS_BACKUP_REGION=ap-hongkong
COS_BACKUP_PREFIX=production

# 可选；省略时分别为 14 天和至少 3 份。
LOCAL_RETENTION_DAYS=14
LOCAL_MIN_VERIFIED=3
```

脚本不会 `source` 此文件，只会按名称读取上述目标与保留字段；即使旧配置暂时仍含 `COS_SECRET_ID` 或 `COS_SECRET_KEY`，脚本也不会读取或输出它们。COSCLI 运行时凭据由 root-only 的 `/etc/ai-project-os/coscli.yaml` 管理。首次自动备份和独立恢复通过后，应在确认另有恢复副本的前提下移除 `cos-backup.env` 中重复的凭据。不要把任何真实密钥写进仓库、systemd unit、Actions 日志或此文档。

当前实现固定并现场验证 COSCLI `v1.0.9`。升级 COSCLI 前必须重新验证上传参数、整体 CRC64 和 `stat` 输出合同。

## 安装与首次运行

从受信任的仓库检出执行：

```bash
sudo deploy/production/install-production-backup.sh
```

默认安装只写入脚本和 unit，不启用 timer，也不会立即创建备份。首次手动演练使用：

```bash
sudo systemctl start ai-project-os-backup.service
sudo systemctl status ai-project-os-backup.service --no-pager
sudo journalctl -u ai-project-os-backup.service --since '-30 minutes' --no-pager
sudo cat /var/lib/ai-project-os-backup/last-success
sudo cat /var/lib/ai-project-os-operations/backups/current.json
```

`last-success` 不包含凭据，但仍保持 `root:root 0600`。成功结果必须同时包含：

- `status=COS_UPLOAD_VERIFIED`
- `/var/backups/ai-project-os/...` 下的精确本地备份路径
- 加密归档与 SHA-256 sidecar 的 `cos://.../production/backups/...` 对象
- age 加密归档的 SHA-256
- 唯一命名且经 COS metadata 验证的 manifest 与 `manifests/latest.json` 对象路径

`current.json` 与 `history/*.json` 是供系统运维页面读取的脱敏副本，保持 `root:root 0644` 并位于专用 `0755` 目录。页面仅对初始化应用时创建的首位超级管理员开放；其他系统管理员、工作区管理员和普通成员均不能通过受保护 API 读取。状态目录不包含 COS Secret、COSCLI 配置、age 私钥、数据库密码、原始日志或备份正文。

不要仅凭 `systemctl start` 返回成功或 COS 中出现对象就宣称备份可恢复。管理员仍需下载归档、校验 sidecar、使用异地 age 私钥解密，并在 UUID 隔离数据库和卷中完成恢复演练。完整的本地隔离命令、停止条件和证据边界见[恢复演练 Runbook](./recovery-drill.md)。

首次手工备份和独立恢复均通过后再启用每日 timer：

```bash
sudo systemctl enable --now ai-project-os-backup.timer
sudo systemctl status ai-project-os-backup.timer --no-pager
sudo systemctl list-timers ai-project-os-backup.timer --no-pager
```

## 失败边界

- 当前 Compose 栈缺少 PostgreSQL、app 或 worker：定时/手工备份失败，不创建成功标记。
- 生产部署正在运行：定时/手工备份最多等待 10 分钟取得部署锁，超时后安全失败，不干扰部署。
- 磁盘可用空间低于 5 GiB：在创建备份前失败。
- 数据复制失败：写入者恢复，未完成目录被精确删除。
- 写入者恢复后 3 分钟内未重新达到 Docker `healthy`：备份失败关闭，不上传、不清理本地备份。
- age、COS 上传或远端 metadata 验证失败：完整本地明文备份保留，不写成功标记，也不执行本地保留清理。
- 本地清理只匹配严格命名、root-only 成功标记且已超过保留期的目录；不使用 `find -delete`、通配目录删除或 Docker prune。

如果服务日志出现失败，先保留现场并修复根因；不要手工给目录补 `.cos-upload-verified`。

## 部署前门禁

GitHub Actions 生产部署时，服务器端部署器会执行：

```text
标签与成功 CI 复核（`.1` 源与 `.3` 目标）
→ 候选镜像预构建
→ 捕获精确旧 app/worker，停止并确认写入者已退出
→ 维护隔离与 stopped-writer cutover
→ age 加密
→ COS 上传及远端大小/CRC64 校验
→ 写入本地远端验证标记
→ 由同一批已停止旧 app/worker 生成并验证 `source_quiesced=true` 备份
→ preserve-data 只重建 app/worker，保持 PostgreSQL 原容器与卷
```

Actions 只能看到对象路径和成功标记，不能读取 COS 凭据、age 私钥、数据库密码或备份正文。
